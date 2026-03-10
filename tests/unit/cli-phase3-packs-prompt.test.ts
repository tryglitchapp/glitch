import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyToClipboardMock = vi.fn();

vi.mock('../../cli/lib/clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}));

const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalWorkspacesPath = process.env.GLITCH_WORKSPACES_PATH;

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupCliEnv(configValue: Record<string, unknown> = {}): Promise<{ configPath: string; workspacesPath: string }> {
  const root = await mkTempDir('glitch-cli-phase3-');
  const configPath = path.join(root, 'config.json');
  const workspacesPath = path.join(root, 'workspaces.json');
  await fs.writeFile(configPath, `${JSON.stringify(configValue, null, 2)}\n`, 'utf8');
  process.env.GLITCH_CONFIG_PATH = configPath;
  process.env.GLITCH_WORKSPACES_PATH = workspacesPath;
  return { configPath, workspacesPath };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeFile(pathLike: string, data: string) {
  const bytes = Buffer.from(data, 'utf8');
  return {
    path: pathLike,
    contentType: pathLike.endsWith('.md') ? 'text/markdown' : 'application/json',
    encoding: 'utf8' as const,
    bytes: bytes.length,
    sha256: sha256(bytes),
    data,
  };
}

function buildPromptBundle(packId = 'pack_phase3') {
  const manifest = {
    id: packId,
    version: '3.0',
    timestamp: '2026-03-08T01:02:03.000Z',
    source: 'snapshot',
    bugType: 'layout-shift',
    url: 'https://example.com/settings',
    watchedElements: [
      {
        id: 'el_00',
        selector: '#save-button',
        dir: 'watched/el_00_save-button',
        targetRefId: 'ref_save_1',
      },
    ],
    stats: {
      totalStateChanges: 4,
      propertiesChanged: ['transform'],
      duration: 0,
    },
  };

  const summary = {
    keyFindings: ['Save button jumps by 8px on click'],
    recommendedMCPQueries: ['find button render path', 'inspect transition styles'],
  };

  const interactions = [
    { type: 'click', timestamp: 120, target: { selector: '#save-button', tag: 'button', isWatchedElement: true } },
  ];

  const core = {
    selector: '#save-button',
    tag: 'button',
    boundingBox: { x: 20, y: 40, width: 120, height: 36 },
    classes: ['btn', 'primary'],
    isVisible: true,
  };

  const fullStyles = {
    computedStyles: {
      position: 'relative',
      transform: 'translateY(0px)',
      transition: 'transform 0.2s ease',
    },
  };

  return {
    format: 'glitchpack',
    bundleVersion: '1.0',
    packId,
    createdAt: '2026-03-08T01:02:03.000Z',
    mode: 'slim',
    manifest: { id: packId },
    summary: {},
    toc: {},
    files: [
      makeFile('manifest.json', JSON.stringify(manifest, null, 2)),
      makeFile('summary.json', JSON.stringify(summary, null, 2)),
      makeFile('prompt.md', 'Save button shifts downward after click.'),
      makeFile('interactions.json', JSON.stringify(interactions, null, 2)),
      makeFile('watched/el_00_save-button/core.json', JSON.stringify(core, null, 2)),
      makeFile('watched/el_00_save-button/full-styles.json', JSON.stringify(fullStyles, null, 2)),
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  copyToClipboardMock.mockReset();
  copyToClipboardMock.mockReturnValue({ ok: true, method: 'mock' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

describe('phase 3 packs and prompt commands', () => {
  it('packs list returns filtered json rows', async () => {
    await setupCliEnv({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('https://mcp.example.com/v1/packs');
      return new Response(
        JSON.stringify({
          ok: true,
          total: 2,
          websites: [
            {
              hostname: 'example.com',
              packCount: 1,
              packs: [
                {
                  id: 'pack_a',
                  timestamp: '2026-03-08T00:00:00.000Z',
                  source: 'snapshot',
                  bugType: 'layout-shift',
                  url: 'https://example.com',
                  watchedElements: 1,
                  totalStateChanges: 4,
                  duration: 0,
                },
              ],
            },
            {
              hostname: 'other.com',
              packCount: 1,
              packs: [
                {
                  id: 'pack_b',
                  timestamp: '2026-03-07T00:00:00.000Z',
                  source: 'recorder',
                  bugType: 'animation',
                  url: 'https://other.com',
                  watchedElements: 2,
                  totalStateChanges: 9,
                  duration: 250,
                },
              ],
            },
          ],
        }),
        { status: 200 }
      );
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['packs', 'list', '--json', '--host', 'example.com', '--source', 'snapshot']);
    expect(exitCode).toBe(0);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      total?: number;
      items?: Array<{ id: string; host: string; source: string }>;
    };
    expect(payload.total).toBe(1);
    expect(payload.items?.[0]?.id).toBe('pack_a');
    expect(payload.items?.[0]?.host).toBe('example.com');
    expect(payload.items?.[0]?.source).toBe('snapshot');
  });

  it('packs show reads local bundle json and emits structured summary', async () => {
    await setupCliEnv({});
    const bundlePath = path.join(await mkTempDir('glitch-cli-phase3-bundle-'), 'glitchpack_pack_phase3.json');
    await fs.writeFile(bundlePath, `${JSON.stringify(buildPromptBundle('pack_show'), null, 2)}\n`, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['packs', 'show', bundlePath, '--json']);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      packId?: string;
      watchedElements?: number;
      totalStateChanges?: number;
      source?: string;
    };
    expect(payload.packId).toBe('pack_show');
    expect(payload.source).toBe('snapshot');
    expect(payload.watchedElements).toBe(1);
    expect(payload.totalStateChanges).toBe(4);
  });

  it('prompt generate prints generated prompt text from local bundle', async () => {
    await setupCliEnv({});
    const bundlePath = path.join(await mkTempDir('glitch-cli-phase3-prompt-generate-'), 'glitchpack_pack_phase3.json');
    await fs.writeFile(bundlePath, `${JSON.stringify(buildPromptBundle('pack_generate'), null, 2)}\n`, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli([
      'prompt',
      'generate',
      bundlePath,
      '--target',
      'claude',
      '--framework',
      'react',
      '--style',
      'detailed',
      '--no-code',
    ]);

    expect(exitCode).toBe(0);
    const renderedPrompt = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(renderedPrompt).toContain('Pack ID: pack_generate');
    expect(renderedPrompt).toContain('Framework context: react');
    expect(renderedPrompt).toContain('I captured this UI bug with Glitch');
  });

  it('prompt copy prints prompt and exits non-zero when clipboard is unavailable', async () => {
    await setupCliEnv({});
    const bundlePath = path.join(await mkTempDir('glitch-cli-phase3-prompt-copy-'), 'glitchpack_pack_phase3.json');
    await fs.writeFile(bundlePath, `${JSON.stringify(buildPromptBundle('pack_copy'), null, 2)}\n`, 'utf8');

    copyToClipboardMock.mockReturnValue({ ok: false, error: 'clipboard missing' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['prompt', 'copy', bundlePath]);

    expect(exitCode).toBe(1);
    const renderedPrompt = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(renderedPrompt).toContain('Pack ID: pack_copy');
    expect(errorSpy).toHaveBeenCalledWith('Clipboard copy failed: clipboard missing');
  });
});
