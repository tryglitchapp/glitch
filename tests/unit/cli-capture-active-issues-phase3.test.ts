import { webcrypto } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildDirectoryPackMock,
  getPackFilesMock,
  launchMock,
} = vi.hoisted(() => ({
  buildDirectoryPackMock: vi.fn(),
  getPackFilesMock: vi.fn(),
  launchMock: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: launchMock,
  },
}));

vi.mock('../../src/lib/context-pack/directory-pack-builder', () => ({
  buildDirectoryPack: buildDirectoryPackMock,
  getPackFiles: getPackFilesMock,
}));

vi.mock('../../src/lib/context-pack/upload-schema', () => ({
  validateUploadRequestPayload: () => ({ ok: true }),
  formatUploadValidationErrors: () => 'invalid payload',
}));

vi.mock('../../src/lib/security/redact-pack', () => ({
  redactUploadPayload: (payload: unknown) => payload,
}));

const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalCrypto = globalThis.crypto;
let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupCliConfig(configValue: Record<string, unknown>): Promise<string> {
  const root = await mkTempDir('glitch-cli-active-issues-phase3-');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify(configValue, null, 2)}\n`, 'utf8');
  process.env.GLITCH_CONFIG_PATH = configPath;
  return configPath;
}

beforeEach(() => {
  vi.resetModules();
  globalThis.crypto = webcrypto as Crypto;
  buildDirectoryPackMock.mockReset();
  getPackFilesMock.mockReset();
  launchMock.mockReset();
  getPackFilesMock.mockReturnValue([]);
  buildDirectoryPackMock.mockResolvedValue({
    id: 'pack_local',
    manifest: {
      id: 'pack_local',
      url: 'https://example.com/final',
      watchedElements: [],
      stats: { totalStateChanges: 0, propertiesChanged: [], duration: 0 },
    },
  });

  const page = {
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          refId: 'ref_1',
          selector: '#cta',
          occurrenceIndex: 0,
          domPath: [0],
          fingerprint: { tag: 'button', classList: ['cta'] },
        },
      ])
      .mockResolvedValueOnce({
        captured: [
          {
            selector: '#cta',
            targetRef: {
              refId: 'ref_1',
              selector: '#cta',
              occurrenceIndex: 0,
              domPath: [0],
              fingerprint: { tag: 'button', classList: ['cta'] },
            },
            state: {
              timestamp: 0,
              boundingBox: { x: 0, y: 0, width: 100, height: 40 },
              styles: {},
              classes: ['cta'],
              isVisible: true,
              attributes: {},
              computedStyles: {},
              viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
              scrollOffsets: { x: 0, y: 0 },
              scrollSize: { width: 1440, height: 2000 },
              parentChain: [],
              textContent: 'CTA',
              selector: '#cta',
              tag: 'button',
            },
          },
        ],
        unresolved: [],
      })
      .mockResolvedValueOnce({ width: 1440, height: 900, devicePixelRatio: 2 }),
    url: vi.fn(() => 'https://example.com/final'),
    screenshot: vi.fn(async () => {}),
  };

  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };

  launchMock.mockResolvedValue(browser);
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  vi.restoreAllMocks();
});

afterAll(() => {
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  globalThis.crypto = originalCrypto;
});

describe('capture phase 3 active issues integration', () => {
  it('uses the server-returned pack id for activation and final resource output', async () => {
    await setupCliConfig({
      cloud_url: 'https://mcp.example.com',
      api_key: 'api_test',
    });

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://mcp.example.com/packs') {
        return new Response(
          JSON.stringify({ ok: true, packId: 'pack_server' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'https://mcp.example.com/v1/active-issues') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ packId: 'pack_server', mode: 'promote' }));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { runCaptureCli } = await import('../../cli/capture');
    const exitCode = await runCaptureCli(
      ['https://example.com', '--selector', '#cta', '--cloud', '--activate'],
      { fetchImpl: fetchImpl as unknown as typeof fetch, interactive: false },
    );

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith('Uploaded pack: pack_server');
    expect(logSpy).toHaveBeenCalledWith('Added to Active Issues');
    expect(logSpy).toHaveBeenCalledWith('Resource URI: contextpacks://active');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
