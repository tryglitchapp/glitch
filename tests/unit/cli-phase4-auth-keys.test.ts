import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalWorkspacesPath = process.env.GLITCH_WORKSPACES_PATH;
const originalWebBase = process.env.GLITCH_WEB_BASE_URL;
const originalPollInterval = process.env.GLITCH_LOGIN_POLL_INTERVAL_MS;
const originalPollTimeout = process.env.GLITCH_LOGIN_MAX_POLL_MS;

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupCliEnv(configValue: Record<string, unknown> = {}): Promise<{ configPath: string; workspacesPath: string }> {
  const root = await mkTempDir('glitch-cli-phase4-');
  const configPath = path.join(root, 'config.json');
  const workspacesPath = path.join(root, 'workspaces.json');
  await fs.writeFile(configPath, `${JSON.stringify(configValue, null, 2)}\n`, 'utf8');
  process.env.GLITCH_CONFIG_PATH = configPath;
  process.env.GLITCH_WORKSPACES_PATH = workspacesPath;
  return { configPath, workspacesPath };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({
    status: 0,
    stdout: '',
    stderr: '',
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  process.env.GLITCH_WORKSPACES_PATH = originalWorkspacesPath;
  process.env.GLITCH_WEB_BASE_URL = originalWebBase;
  process.env.GLITCH_LOGIN_POLL_INTERVAL_MS = originalPollInterval;
  process.env.GLITCH_LOGIN_MAX_POLL_MS = originalPollTimeout;
  vi.restoreAllMocks();
});

afterAll(() => {
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  process.env.GLITCH_WORKSPACES_PATH = originalWorkspacesPath;
  process.env.GLITCH_WEB_BASE_URL = originalWebBase;
  process.env.GLITCH_LOGIN_POLL_INTERVAL_MS = originalPollInterval;
  process.env.GLITCH_LOGIN_MAX_POLL_MS = originalPollTimeout;
});

describe('phase 4 auth and keys commands', () => {
  it('login performs handoff poll and stores API key', async () => {
    const { configPath } = await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: '',
    });
    process.env.GLITCH_WEB_BASE_URL = 'https://www.tryglitch.app';
    process.env.GLITCH_LOGIN_POLL_INTERVAL_MS = '1';
    process.env.GLITCH_LOGIN_MAX_POLL_MS = '200';

    let pollCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === 'https://mcp.example.com/v1/auth/firebase/handoff/start' && method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            handoffToken: 'handoff_123',
            expiresAt: '2026-03-09T00:00:00.000Z',
          }),
          { status: 200 }
        );
      }

      if (url === 'https://mcp.example.com/v1/auth/firebase/handoff/poll' && method === 'POST') {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              status: 'pending',
              expiresAt: '2026-03-09T00:00:00.000Z',
            }),
            { status: 200 }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            status: 'completed',
            email: 'cli-user@example.com',
            emailVerified: true,
            apiKey: {
              id: 'key_new',
              plaintext: 'glk_live_new',
            },
          }),
          { status: 200 }
        );
      }

      return new Response('not found', { status: 404 });
    }));

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['login']);
    expect(exitCode).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalled();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { api_key?: string };
    expect(config.api_key).toBe('glk_live_new');
  });

  it('logout clears stored api_key', async () => {
    const { configPath } = await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'glk_live_old',
    });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['logout']);
    expect(exitCode).toBe(0);

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { api_key?: string };
    expect(config.api_key).toBe('');
  });

  it('whoami falls back to /v1/usage for api-key auth', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'glk_live_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://mcp.example.com/v1/auth/me') {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'FIREBASE_ID_TOKEN_REQUIRED',
            error: 'Firebase ID token is required.',
          }),
          { status: 401 }
        );
      }

      if (url === 'https://mcp.example.com/v1/usage') {
        return new Response(
          JSON.stringify({
            ok: true,
            type: 'user',
            userId: 'user_123',
            plan: 'free',
            remaining: 9,
            limit: 12,
            used: 3,
          }),
          { status: 200 }
        );
      }

      return new Response('not found', { status: 404 });
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['whoami', '--json']);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      authMode?: string;
      userId?: string;
      plan?: string;
      usage?: { remaining?: number; limit?: number };
    };
    expect(payload.authMode).toBe('api-key');
    expect(payload.userId).toBe('user_123');
    expect(payload.plan).toBe('free');
    expect(payload.usage?.remaining).toBe(9);
    expect(payload.usage?.limit).toBe(12);
  });

  it('keys list and keys create return json output', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'glk_live_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === 'https://mcp.example.com/v1/keys' && method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            activeKeyId: 'key_current',
            keys: [
              {
                id: 'key_current',
                keyPrefix: 'glk_live',
                label: 'default',
                scopes: ['contextpacks:read', 'contextpacks:list'],
                createdAt: '2026-03-09T00:00:00.000Z',
                lastUsedAt: null,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === 'https://mcp.example.com/v1/keys' && method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            key: {
              id: 'key_created',
              keyPrefix: 'glk_new',
              plaintext: 'glk_live_created',
              label: 'cli-test',
              scopes: ['contextpacks:read', 'contextpacks:list'],
              createdAt: '2026-03-09T00:00:00.000Z',
            },
          }),
          { status: 201 }
        );
      }

      return new Response('not found', { status: 404 });
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const listExitCode = await runGlitchCli(['keys', 'list', '--json']);
    expect(listExitCode).toBe(0);
    const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      activeKeyId?: string;
      keys?: Array<{ id?: string }>;
    };
    expect(listPayload.activeKeyId).toBe('key_current');
    expect(listPayload.keys?.[0]?.id).toBe('key_current');

    logSpy.mockClear();
    const createExitCode = await runGlitchCli(['keys', 'create', 'cli-test', '--json']);
    expect(createExitCode).toBe(0);
    const createPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      key?: { id?: string; plaintext?: string; label?: string };
    };
    expect(createPayload.key?.id).toBe('key_created');
    expect(createPayload.key?.plaintext).toBe('glk_live_created');
    expect(createPayload.key?.label).toBe('cli-test');
  });

  it('keys revoke clears local api_key when revoking current active key', async () => {
    const { configPath } = await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'glk_live_current',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === 'https://mcp.example.com/v1/keys' && method === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            activeKeyId: 'key_current',
            keys: [
              {
                id: 'key_current',
                keyPrefix: 'glk_live',
                label: 'default',
                scopes: ['contextpacks:read', 'contextpacks:list'],
                createdAt: '2026-03-09T00:00:00.000Z',
                lastUsedAt: null,
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === 'https://mcp.example.com/v1/keys/key_current' && method === 'DELETE') {
        return new Response(
          JSON.stringify({
            ok: true,
            revokedKeyId: 'key_current',
            clearedSessions: 1,
          }),
          { status: 200 }
        );
      }

      return new Response('not found', { status: 404 });
    }));

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['keys', 'revoke', 'key_current', '--yes']);
    expect(exitCode).toBe(0);

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { api_key?: string };
    expect(config.api_key).toBe('');
  });
});
