import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConnectCommand } from '../../cli/connect';

let tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFetchOkStub() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/health')) {
      return new Response('ok', { status: 200 });
    }
    if (url.endsWith('/v1/usage')) {
      return new Response(JSON.stringify({ remaining: 10, limit: 12, plan: 'free' }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  vi.restoreAllMocks();
});

describe('cli connect', () => {
  it('detects repo root from nested cwd for cursor target by default', async () => {
    const tempRoot = await mkTempDir('glitch-connect-detect-root-');
    const projectRoot = path.join(tempRoot, 'project');
    const nestedCwd = path.join(projectRoot, 'apps', 'web');
    const homeDir = path.join(tempRoot, 'home');
    const rootConfigPath = path.join(projectRoot, '.cursor', 'mcp.json');
    const nestedConfigPath = path.join(nestedCwd, '.cursor', 'mcp.json');
    const gitignorePath = path.join(projectRoot, '.gitignore');

    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });

    const fetchStub = createFetchOkStub();
    const exitCode = await runConnectCommand(['cursor', '--gitignore'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: nestedCwd,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    await expect(fs.stat(rootConfigPath)).resolves.toBeTruthy();
    await expect(fs.stat(nestedConfigPath)).rejects.toBeTruthy();

    const gitignore = await fs.readFile(gitignorePath, 'utf8');
    expect(gitignore).toContain('.cursor/');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('fails when repo-scoped cursor config would write a real key and .cursor/ is not gitignored', async () => {
    const tempRoot = await mkTempDir('glitch-connect-guardrail-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const configPath = path.join(projectRoot, '.cursor', 'mcp.json');

    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });

    const fetchStub = createFetchOkStub();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await runConnectCommand(['cursor', '--project', projectRoot], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(1);
    await expect(fs.stat(configPath)).rejects.toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('Refusing to write a real API key into .cursor/mcp.json');
    expect(errorSpy.mock.calls[0]?.[0]).toContain('Re-run with --gitignore or use --template.');
  });

  it('updates only the glitch MCP entry and preserves other servers', async () => {
    const tempRoot = await mkTempDir('glitch-connect-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const configPath = path.join(projectRoot, '.cursor', 'mcp.json');
    const gitignorePath = path.join(projectRoot, '.gitignore');

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            existing: {
              type: 'sse',
              url: 'https://example.com/sse',
            },
          },
          foo: 'bar',
        },
        null,
        2
      ),
      'utf8'
    );

    const fetchStub = createFetchOkStub();
    const exitCode = await runConnectCommand(['cursor', '--project', projectRoot, '--gitignore'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    const nextConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
      foo: string;
    };
    expect(nextConfig.foo).toBe('bar');
    expect(nextConfig.mcpServers.existing).toBeTruthy();
    expect(nextConfig.mcpServers.glitch).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: {
        Authorization: 'Bearer api_secret',
      },
    });

    const gitignore = await fs.readFile(gitignorePath, 'utf8');
    expect(gitignore).toContain('.cursor/');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('writes template authorization without requiring .cursor/ gitignore protection', async () => {
    const tempRoot = await mkTempDir('glitch-connect-template-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const configPath = path.join(projectRoot, '.cursor', 'mcp.json');
    const gitignorePath = path.join(projectRoot, '.gitignore');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });

    const fetchStub = vi.fn(async () => new Response('unexpected', { status: 500 }));
    const exitCode = await runConnectCommand(['cursor', '--project', projectRoot, '--template'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: '',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    const nextConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(nextConfig.mcpServers.glitch).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: {
        Authorization: 'Bearer [API KEY]',
      },
    });
    await expect(fs.stat(gitignorePath)).rejects.toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('fails for claude when --project is provided', async () => {
    const tempRoot = await mkTempDir('glitch-connect-invalid-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const fetchStub = createFetchOkStub();

    const exitCode = await runConnectCommand(['claude', '--project', projectRoot], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(1);
  });

  it('for claude remote mode prints connector guidance and does not write claude_desktop_config.json', async () => {
    const tempRoot = await mkTempDir('glitch-connect-claude-remote-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    const claudeConfigPath = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

    const fetchStub = createFetchOkStub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runConnectCommand(['claude'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    await expect(fs.stat(claudeConfigPath)).rejects.toBeTruthy();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const loggedLines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(logSpy).toHaveBeenCalledWith(
      'Claude Desktop ignores remote MCP servers added directly in claude_desktop_config.json.'
    );
    expect(loggedLines).toContain('Authorization: Bearer [REDACTED]');
    expect(loggedLines).toContain('Re-run with --show-token to print the live bearer token for manual paste.');
    expect(loggedLines.some((line) => line.includes('api_secret'))).toBe(false);
  });

  it('for claude remote mode prints the live token only when --show-token is passed', async () => {
    const tempRoot = await mkTempDir('glitch-connect-claude-show-token-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    await fs.mkdir(projectRoot, { recursive: true });

    const fetchStub = createFetchOkStub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runConnectCommand(['claude', '--show-token'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const loggedLines = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(loggedLines).toContain('Authorization: Bearer api_secret');
    expect(loggedLines).not.toContain('Re-run with --show-token to print the live bearer token for manual paste.');
  });

  it('for claude stdio mode writes type-based stdio config entry', async () => {
    const tempRoot = await mkTempDir('glitch-connect-claude-stdio-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    const claudeConfigPath = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

    const fetchStub = createFetchOkStub();
    const exitCode = await runConnectCommand(
      ['claude', '--claude-stdio-command', 'node', '--claude-stdio-arg', 'dist/stdio-proxy.js'],
      {
        cloudUrl: 'https://mcp.example.com',
        apiKey: 'api_secret',
        cwd: projectRoot,
        homeDir,
        fetchImpl: fetchStub as unknown as typeof fetch,
      }
    );

    expect(exitCode).toBe(0);
    const nextConfig = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(nextConfig.mcpServers.glitch).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['dist/stdio-proxy.js'],
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects --show-token for non-claude targets', async () => {
    const tempRoot = await mkTempDir('glitch-connect-show-token-invalid-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const fetchStub = createFetchOkStub();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runConnectCommand(['windsurf', '--show-token'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_secret',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(1);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('--claude-stdio-command/--claude-stdio-arg/--show-token are only supported for the claude target.');
  });

  it('fails when no API key is configured and --template is not used', async () => {
    const tempRoot = await mkTempDir('glitch-connect-no-key-');
    const projectRoot = path.join(tempRoot, 'project');
    const homeDir = path.join(tempRoot, 'home');
    const fetchStub = createFetchOkStub();

    const exitCode = await runConnectCommand(['windsurf'], {
      cloudUrl: 'https://mcp.example.com',
      apiKey: '',
      cwd: projectRoot,
      homeDir,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(exitCode).toBe(1);
  });
});
