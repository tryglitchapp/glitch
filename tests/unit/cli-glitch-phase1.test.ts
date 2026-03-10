import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCaptureCliMock = vi.fn();
const runPullCommandMock = vi.fn();
const runConnectCommandMock = vi.fn();

vi.mock('../../cli/capture', () => ({
  runCaptureCli: runCaptureCliMock,
}));

vi.mock('../../cli/pull', () => ({
  runPullCommand: runPullCommandMock,
}));

vi.mock('../../cli/connect', () => ({
  runConnectCommand: runConnectCommandMock,
}));

const originalConfigPath = process.env.GLITCH_CONFIG_PATH;
const originalWorkspacesPath = process.env.GLITCH_WORKSPACES_PATH;
let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function prepareConfigPath(): Promise<string> {
  const tempDir = await mkTempDir('glitch-cli-phase1-config-');
  const configPath = path.join(tempDir, 'config.json');
  const workspacesPath = path.join(tempDir, 'workspaces.json');
  await fs.writeFile(configPath, '{}\n', 'utf8');
  process.env.GLITCH_CONFIG_PATH = configPath;
  process.env.GLITCH_WORKSPACES_PATH = workspacesPath;
  return configPath;
}

beforeEach(() => {
  vi.resetModules();
  runCaptureCliMock.mockReset();
  runPullCommandMock.mockReset();
  runConnectCommandMock.mockReset();
  runCaptureCliMock.mockResolvedValue(0);
  runPullCommandMock.mockResolvedValue(0);
  runConnectCommandMock.mockResolvedValue(0);
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

describe('glitch cli phase 1 command aliases', () => {
  it('routes snapshot shorthand to capture with url + snapshot mode', async () => {
    await prepareConfigPath();
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['snapshot', 'https://example.com', '--cloud']);
    expect(exitCode).toBe(0);
    expect(runCaptureCliMock).toHaveBeenCalledTimes(1);
    expect(runCaptureCliMock).toHaveBeenCalledWith([
      '--url',
      'https://example.com',
      '--cloud',
      '--mode',
      'snapshot',
    ]);
  });

  it('routes record shorthand to capture with url + recorder mode', async () => {
    await prepareConfigPath();
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['record', 'https://example.com', '--multi']);
    expect(exitCode).toBe(0);
    expect(runCaptureCliMock).toHaveBeenCalledTimes(1);
    expect(runCaptureCliMock).toHaveBeenCalledWith([
      '--url',
      'https://example.com',
      '--multi',
      '--mode',
      'recorder',
    ]);
  });

  it('routes packs pull to the existing pull command pathway', async () => {
    await prepareConfigPath();
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['packs', 'pull', '--help']);
    expect(exitCode).toBe(0);
    expect(runPullCommandMock).toHaveBeenCalledTimes(1);
    expect(runPullCommandMock.mock.calls[0]?.[0]).toEqual(['--help']);
  });

  it('routes workspace init and writes project config defaults', async () => {
    await prepareConfigPath();
    const projectRoot = await mkTempDir('glitch-cli-workspace-init-');
    const { runGlitchCli } = await import('../../cli/glitch');

    const exitCode = await runGlitchCli(['workspace', 'init', projectRoot]);
    expect(exitCode).toBe(0);

    const projectConfigPath = path.join(projectRoot, '.glitch', 'project.json');
    const projectConfigRaw = await fs.readFile(projectConfigPath, 'utf8');
    const projectConfig = JSON.parse(projectConfigRaw) as {
      contextPacksDir?: string;
    };

    expect(projectConfig.contextPacksDir).toBe('./context-packs');
  });
});
