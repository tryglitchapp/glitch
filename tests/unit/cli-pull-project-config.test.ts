import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPullCommand } from '../../cli/pull';

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildBundle(packId: string, mode: 'slim' | 'full') {
  const summaryData = '{\n  "website": "example.com"\n}\n';
  const summaryBytes = Buffer.from(summaryData, 'utf8');
  return {
    format: 'glitchpack',
    bundleVersion: '1.0',
    packId,
    createdAt: '2026-02-27T00:00:00.000Z',
    mode,
    manifest: { id: packId },
    summary: { website: 'example.com' },
    toc: {},
    files: [
      {
        path: 'summary.json',
        contentType: 'application/json',
        encoding: 'utf8',
        bytes: summaryBytes.length,
        sha256: createHash('sha256').update(summaryBytes).digest('hex'),
        data: summaryData,
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  vi.restoreAllMocks();
});

describe('cli pull project config defaults', () => {
  it('uses nearest project config defaults for mode/format/output directory', async () => {
    const tempRoot = await mkTempDir('glitch-pull-project-defaults-');
    const projectRoot = path.join(tempRoot, 'project');
    const nestedCwd = path.join(projectRoot, 'apps', 'web');
    await fs.mkdir(path.join(projectRoot, '.glitch'), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, '.glitch', 'project.json'),
      JSON.stringify(
        {
          contextPacksDir: './project-packs',
          defaultBundleMode: 'full',
          defaultFormat: 'bundle',
        },
        null,
        2
      ),
      'utf8'
    );

    const fetchStub = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const mode = parsed.searchParams.get('mode');
      const safeMode = mode === 'full' ? 'full' : 'slim';
      return new Response(JSON.stringify(buildBundle('pack_from_project', safeMode)), { status: 200 });
    });

    const exitCode = await runPullCommand(['pack_from_project'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_test',
      cwd: nestedCwd,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchStub.mock.calls[0]?.[0] ?? '');
    expect(requestedUrl).toContain('/v1/packs/pack_from_project/bundle?mode=full');

    const bundleOutput = path.join(projectRoot, 'project-packs', 'glitchpack_pack_from_project.json');
    const exists = await fs.stat(bundleOutput).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('allows --mode and --format flags to override project defaults', async () => {
    const tempRoot = await mkTempDir('glitch-pull-project-override-');
    const projectRoot = path.join(tempRoot, 'project');
    const nestedCwd = path.join(projectRoot, 'src');
    await fs.mkdir(path.join(projectRoot, '.glitch'), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, '.glitch', 'project.json'),
      JSON.stringify(
        {
          contextPacksDir: './project-packs',
          defaultBundleMode: 'full',
          defaultFormat: 'bundle',
        },
        null,
        2
      ),
      'utf8'
    );

    const fetchStub = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const mode = parsed.searchParams.get('mode');
      const safeMode = mode === 'full' ? 'full' : 'slim';
      return new Response(JSON.stringify(buildBundle('pack_from_project', safeMode)), { status: 200 });
    });

    const exitCode = await runPullCommand(['pack_from_project', '--mode', 'slim', '--format', 'dir'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_test',
      cwd: nestedCwd,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchStub.mock.calls[0]?.[0] ?? '');
    expect(requestedUrl).toContain('/v1/packs/pack_from_project/bundle?mode=slim');

    const unpackedOutput = path.join(projectRoot, 'project-packs', 'pack_from_project', 'summary.json');
    const summary = await fs.readFile(unpackedOutput, 'utf8');
    expect(summary).toContain('example.com');
  });
});
