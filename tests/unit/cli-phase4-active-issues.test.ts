import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalWorkspacesPath = process.env.GLITCH_WORKSPACES_PATH;

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupCliEnv(
  configValue: Record<string, unknown> = {}
): Promise<{ configPath: string; workspacesPath: string }> {
  const root = await mkTempDir('glitch-cli-phase4-active-');
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
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  process.env.GLITCH_WORKSPACES_PATH = originalWorkspacesPath;
  vi.restoreAllMocks();
});

afterAll(() => {
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  process.env.GLITCH_WORKSPACES_PATH = originalWorkspacesPath;
});

describe('phase 4 active commands', () => {
  it('lists active issues as json', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://mcp.example.com/v1/active-issues');
      expect(init?.method ?? 'GET').toBe('GET');
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          primaryPackId: 'pack_primary',
          items: [
            {
              packId: 'pack_primary',
              isPrimary: true,
              source: 'snapshot',
              bugType: 'layout-shift',
              url: 'https://example.com/settings',
              lastPromotedAt: '2026-03-09T00:00:00.000Z',
            },
          ],
        }),
        { status: 200 }
      );
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['active', 'list', '--json']);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      total?: number;
      primaryPackId?: string | null;
      items?: Array<{ packId?: string }>;
    };
    expect(payload.total).toBe(1);
    expect(payload.primaryPackId).toBe('pack_primary');
    expect(payload.items?.[0]?.packId).toBe('pack_primary');
  });

  it('adds a pack to active issues and prints the active alias', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://mcp.example.com/v1/active-issues');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ packId: 'pack_primary', mode: 'promote' }));
      return new Response(
        JSON.stringify({
          ok: true,
          packId: 'pack_primary',
          added: true,
          promoted: true,
          primaryPackId: 'pack_primary',
          total: 1,
        }),
        { status: 200 }
      );
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['active', 'add', 'pack_primary']);

    expect(exitCode).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        'Added "pack_primary" to Active Issues.',
        'Primary active pack: pack_primary',
        'Resource URI: contextpacks://active',
        'Total: 1 Active Issue.',
      ])
    );
  });

  it('removes a pack from active issues and reports when none remain', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://mcp.example.com/v1/active-issues/pack_primary');
      expect(init?.method).toBe('DELETE');
      return new Response(
        JSON.stringify({
          ok: true,
          removedPackId: 'pack_primary',
          primaryPackId: null,
          total: 0,
        }),
        { status: 200 }
      );
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['active', 'remove', 'pack_primary']);

    expect(exitCode).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        'Removed "pack_primary" from Active Issues.',
        'No active issues remain.',
        'Total: 0 Active Issues.',
      ])
    );
  });

  it('clears all active issues with --yes and prints the cleared count', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://mcp.example.com/v1/active-issues');
      expect(init?.method).toBe('DELETE');
      return new Response(
        JSON.stringify({
          ok: true,
          cleared: 2,
          primaryPackId: null,
          total: 0,
        }),
        { status: 200 }
      );
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['active', 'clear', '--yes']);

    expect(exitCode).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        'Cleared 2 Active Issues.',
        'No active issues remain.',
      ])
    );
  });
});
