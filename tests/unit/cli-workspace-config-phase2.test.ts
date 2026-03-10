import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULT_CLOUD_URL = 'https://mcp-server-production-b57a.up.railway.app';
const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalWorkspacesPath = process.env.GLITCH_WORKSPACES_PATH;

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupCliEnv(): Promise<{ configPath: string; workspacesPath: string }> {
  const root = await mkTempDir('glitch-cli-phase2-');
  const configPath = path.join(root, 'config.json');
  const workspacesPath = path.join(root, 'workspaces.json');
  await fs.writeFile(configPath, '{}\n', 'utf8');
  process.env.GLITCH_CONFIG_PATH = configPath;
  process.env.GLITCH_WORKSPACES_PATH = workspacesPath;
  return { configPath, workspacesPath };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  process.env.GLITCH_CONFIG_PATH = originalConfigPath;
  process.env.GLITCH_WORKSPACES_PATH = originalWorkspacesPath;
  vi.restoreAllMocks();
});

describe('workspace phase 2 commands', () => {
  it('workspace init creates project config and auto-registers/uses workspace by default', async () => {
    const { workspacesPath } = await setupCliEnv();
    const projectRoot = path.join(await mkTempDir('glitch-workspace-init-'), 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['workspace', 'init', projectRoot]);
    expect(exitCode).toBe(0);

    const projectConfigRaw = await fs.readFile(path.join(projectRoot, '.glitch', 'project.json'), 'utf8');
    const projectConfig = JSON.parse(projectConfigRaw) as { contextPacksDir?: string };
    expect(projectConfig.contextPacksDir).toBe('./context-packs');

    const registryRaw = await fs.readFile(workspacesPath, 'utf8');
    const registry = JSON.parse(registryRaw) as {
      current: string | null;
      workspaces: Array<{ name: string; root: string; createdAt: string; lastUsedAt: string }>;
    };
    expect(registry.current).toBe('project');
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]?.name).toBe('project');
    expect(registry.workspaces[0]?.root).toBe(projectRoot);
    expect(typeof registry.workspaces[0]?.createdAt).toBe('string');
    expect(typeof registry.workspaces[0]?.lastUsedAt).toBe('string');
  });

  it('workspace init supports --no-register for project-config-only setup', async () => {
    const { workspacesPath } = await setupCliEnv();
    const projectRoot = path.join(await mkTempDir('glitch-workspace-init-no-register-'), 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['workspace', 'init', projectRoot, '--no-register']);
    expect(exitCode).toBe(0);

    const projectConfigRaw = await fs.readFile(path.join(projectRoot, '.glitch', 'project.json'), 'utf8');
    const projectConfig = JSON.parse(projectConfigRaw) as { contextPacksDir?: string };
    expect(projectConfig.contextPacksDir).toBe('./context-packs');

    await expect(fs.readFile(workspacesPath, 'utf8')).rejects.toBeTruthy();
  });

  it('workspace init supports --no-use to register without switching current workspace', async () => {
    const { workspacesPath } = await setupCliEnv();
    const projectRoot = path.join(await mkTempDir('glitch-workspace-init-no-use-'), 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['workspace', 'init', projectRoot, '--name', 'my-app', '--no-use']);
    expect(exitCode).toBe(0);

    const registryRaw = await fs.readFile(workspacesPath, 'utf8');
    const registry = JSON.parse(registryRaw) as {
      current: string | null;
      workspaces: Array<{ name: string; root: string }>;
    };
    expect(registry.current).toBeNull();
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]?.name).toBe('my-app');
    expect(registry.workspaces[0]?.root).toBe(projectRoot);
  });

  it('legacy init --project remains compatible and can register/use workspace', async () => {
    const { workspacesPath } = await setupCliEnv();
    const projectRoot = path.join(await mkTempDir('glitch-init-legacy-'), 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['init', '--project', projectRoot, '--name', 'legacy-app', '--use']);
    expect(exitCode).toBe(0);

    const registryRaw = await fs.readFile(workspacesPath, 'utf8');
    const registry = JSON.parse(registryRaw) as {
      current: string | null;
      workspaces: Array<{ name: string; root: string }>;
    };
    expect(registry.current).toBe('legacy-app');
    expect(registry.workspaces[0]?.name).toBe('legacy-app');
    expect(registry.workspaces[0]?.root).toBe(projectRoot);
  });

  it('workspace add registers without writing project config', async () => {
    const { workspacesPath } = await setupCliEnv();
    const projectRoot = path.join(await mkTempDir('glitch-workspace-add-'), 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const { runGlitchCli } = await import('../../cli/glitch');
    const exitCode = await runGlitchCli(['workspace', 'add', projectRoot, '--name', 'added-app']);
    expect(exitCode).toBe(0);

    await expect(fs.stat(path.join(projectRoot, '.glitch', 'project.json'))).rejects.toBeTruthy();

    const registryRaw = await fs.readFile(workspacesPath, 'utf8');
    const registry = JSON.parse(registryRaw) as {
      current: string | null;
      workspaces: Array<{ name: string; root: string }>;
    };
    expect(registry.current).toBeNull();
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]?.name).toBe('added-app');
    expect(registry.workspaces[0]?.root).toBe(projectRoot);
  });

  it('workspace use/current/list support json output', async () => {
    const { workspacesPath } = await setupCliEnv();
    const registry = {
      current: null,
      workspaces: [
        {
          name: 'alpha',
          root: path.join(await mkTempDir('glitch-workspace-alpha-'), 'alpha'),
          createdAt: '2026-03-08T00:00:00.000Z',
          lastUsedAt: '2026-03-08T00:00:00.000Z',
        },
        {
          name: 'beta',
          root: path.join(await mkTempDir('glitch-workspace-beta-'), 'beta'),
          createdAt: '2026-03-08T00:00:00.000Z',
          lastUsedAt: '2026-03-08T00:00:00.000Z',
        },
      ],
    };
    await fs.writeFile(workspacesPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const { runGlitchCli } = await import('../../cli/glitch');
    const useExitCode = await runGlitchCli(['workspace', 'use', 'beta']);
    expect(useExitCode).toBe(0);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const currentExitCode = await runGlitchCli(['workspace', 'current', '--json']);
    expect(currentExitCode).toBe(0);
    const currentJson = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as { name?: string };
    expect(currentJson.name).toBe('beta');

    logSpy.mockClear();
    const listExitCode = await runGlitchCli(['workspace', 'list', '--json']);
    expect(listExitCode).toBe(0);
    const listJson = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      current?: string;
      workspaces?: Array<{ name: string }>;
    };
    expect(listJson.current).toBe('beta');
    expect(Array.isArray(listJson.workspaces)).toBe(true);
    expect(listJson.workspaces?.map((workspace) => workspace.name)).toEqual(['alpha', 'beta']);
  });
});

describe('config phase 2 commands', () => {
  it('config get/list expose values and defaults', async () => {
    const { configPath } = await setupCliEnv();
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          api_key: 'api_live_test',
        },
        null,
        2
      ),
      'utf8'
    );

    const { runGlitchCli } = await import('../../cli/glitch');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const getExitCode = await runGlitchCli(['config', 'get', 'cloud_url']);
    expect(getExitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(DEFAULT_CLOUD_URL);

    logSpy.mockClear();
    const listExitCode = await runGlitchCli(['config', 'list', '--json']);
    expect(listExitCode).toBe(0);
    const listed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      default_destination?: string;
      local_pack_dir?: string;
      cloud_url?: string;
      api_key?: string;
    };

    expect(listed.default_destination).toBe('local');
    expect(listed.local_pack_dir).toBe('~/.glitch/context-packs');
    expect(listed.cloud_url).toBe(DEFAULT_CLOUD_URL);
    expect(listed.api_key).toBe('api_live_test');
  });
});
