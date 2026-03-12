import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

type ConnectTarget = 'cursor' | 'claude' | 'windsurf';

type ConnectArgs = {
  target: ConnectTarget | null;
  project?: string;
  global: boolean;
  template: boolean;
  gitignore: boolean;
  showToken: boolean;
  claudeStdioCommand?: string;
  claudeStdioArgs: string[];
  help: boolean;
};

type ConnectCommandContext = {
  cloudUrl: string;
  apiKey: string;
  cwd?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
};

type ConnectTargetResolved = {
  configPath: string;
  scope: 'project' | 'global';
  projectRoot?: string;
  projectRootSource?: 'explicit' | 'detected' | 'cwd';
};

const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

export async function runConnectCommand(args: string[], context: ConnectCommandContext): Promise<number> {
  let parsed: ConnectArgs;
  try {
    parsed = parseConnectArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'Usage: glitch connect cursor|claude|windsurf [--project <path>] [--global] [--template] [--gitignore] [--show-token] [--claude-stdio-command <cmd> --claude-stdio-arg <arg>...]'
    );
    return 1;
  }

  if (parsed.help) {
    printConnectUsage();
    return 0;
  }

  if (!parsed.target) {
    console.error('Missing target. Expected one of: cursor, claude, windsurf.');
    return 1;
  }

  const home = context.homeDir ? resolve(context.homeDir) : homedir();
  const cwd = context.cwd ? resolve(context.cwd) : process.cwd();
  let resolved: ConnectTargetResolved;
  try {
    resolved = resolveTargetConfigPath(parsed, home, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (resolved.scope === 'project' && resolved.projectRootSource === 'cwd') {
    console.warn('WARNING: Could not detect project root from .git/package.json. Using current directory.');
  }

  if (parsed.target === 'claude') {
    return await runClaudeConnect(parsed, context, resolved.configPath);
  }

  const tokenValue = parsed.template ? '[API KEY]' : context.apiKey.trim();
  if (!tokenValue) {
    console.error('No API key configured. Run `glitch config set api_key <key>` or use `--template`.');
    return 1;
  }

  const bearer = `Bearer ${tokenValue}`;
  const sseUrl = new URL('/sse', context.cloudUrl).toString();

  if (resolved.scope === 'project' && resolved.projectRoot) {
    try {
      enforceCursorGitignoreGuardrail(resolved.projectRoot, {
        autoAdd: parsed.gitignore,
        writingRealToken: !parsed.template,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    upsertGlitchMcpConfig(resolved.configPath, sseUrl, bearer);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`Updated MCP config for ${parsed.target}: ${resolved.configPath}`);

  if (parsed.template) {
    console.log('Template mode enabled; skipped cloud verification.');
    return 0;
  }

  try {
    const verification = await verifyCloudAccess(context.cloudUrl, context.apiKey.trim(), context.fetchImpl ?? fetch);
    console.log(`Cloud verification: PASS (health ${verification.healthStatus}, usage ${verification.usageStatus})`);
    return 0;
  } catch (error) {
    console.error(`Cloud verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printConnectUsage() {
  console.log(`glitch connect cursor|claude|windsurf [options]

Options:
  --project <path>         Project root for repo-scoped Cursor config
  --global                 Use a global config path (Cursor only)
  --template               Write "Bearer [API KEY]" instead of a real key
  --gitignore              Add .cursor/ to the nearest repo .gitignore before writing a real key
  --show-token             For claude remote setup: print the live bearer token
  --claude-stdio-command   For claude only: write local stdio command in claude_desktop_config.json
  --claude-stdio-arg       For claude only: append one stdio arg (repeatable)
  --help                   Show this message`);
}

function parseConnectArgs(argv: string[]): ConnectArgs {
  const parsed: ConnectArgs = {
    target: null,
    global: false,
    template: false,
    gitignore: false,
    showToken: false,
    claudeStdioArgs: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--global') {
      parsed.global = true;
      continue;
    }
    if (token === '--template') {
      parsed.template = true;
      continue;
    }
    if (token === '--gitignore') {
      parsed.gitignore = true;
      continue;
    }
    if (token === '--show-token') {
      parsed.showToken = true;
      continue;
    }
    if (token === '--claude-stdio-command') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --claude-stdio-command');
      parsed.claudeStdioCommand = value;
      i += 1;
      continue;
    }
    if (token === '--claude-stdio-arg') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --claude-stdio-arg');
      parsed.claudeStdioArgs.push(value);
      i += 1;
      continue;
    }
    if (token === '--project') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --project');
      parsed.project = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (parsed.target) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    parsed.target = parseTarget(token);
  }

  if (parsed.target && parsed.target !== 'claude' && (parsed.claudeStdioCommand || parsed.claudeStdioArgs.length > 0 || parsed.showToken)) {
    throw new Error('--claude-stdio-command/--claude-stdio-arg/--show-token are only supported for the claude target.');
  }
  if (!parsed.claudeStdioCommand && parsed.claudeStdioArgs.length > 0) {
    throw new Error('--claude-stdio-arg requires --claude-stdio-command.');
  }

  return parsed;
}

function parseTarget(value: string): ConnectTarget {
  if (value === 'cursor' || value === 'claude' || value === 'windsurf') {
    return value;
  }
  throw new Error(`Unsupported target "${value}". Expected cursor, claude, or windsurf.`);
}

function resolveTargetConfigPath(parsed: ConnectArgs, home: string, cwd: string): ConnectTargetResolved {
  if (!parsed.target) {
    throw new Error('Missing connect target.');
  }

  if (parsed.target !== 'cursor' && parsed.project) {
    throw new Error('--project is only supported for the cursor target.');
  }

  if (parsed.target === 'cursor') {
    if (parsed.global && parsed.project) {
      throw new Error('Use either --global or --project for cursor, not both.');
    }
    if (parsed.global) {
      return {
        configPath: resolve(home, '.cursor', 'mcp.json'),
        scope: 'global',
      };
    }
    const detectedProjectRoot = detectProjectRootFrom(cwd);
    const projectRootSource: 'explicit' | 'detected' | 'cwd' = parsed.project
      ? 'explicit'
      : detectedProjectRoot
        ? 'detected'
        : 'cwd';
    const projectRoot = parsed.project
      ? resolvePathLike(parsed.project, cwd, home)
      : detectedProjectRoot ?? cwd;
    return {
      configPath: resolve(projectRoot, '.cursor', 'mcp.json'),
      scope: 'project',
      projectRoot,
      projectRootSource,
    };
  }

  if (parsed.target === 'claude') {
    return {
      configPath: resolve(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      scope: 'global',
    };
  }

  return {
    configPath: resolve(home, '.config', 'windsurf', 'mcp.json'),
    scope: 'global',
  };
}

function resolvePathLike(pathLike: string, cwd: string, home: string): string {
  const expanded = expandHomePath(pathLike, home);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(cwd, expanded);
}

function expandHomePath(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return resolve(home, input.slice(2));
  return input;
}

function enforceCursorGitignoreGuardrail(
  projectRoot: string,
  options: {
    autoAdd: boolean;
    writingRealToken: boolean;
  }
): void {
  const guardrailRoot = findNearestGitRoot(projectRoot) ?? projectRoot;
  const gitignorePath = resolve(guardrailRoot, '.gitignore');
  const hasGitignore = existsSync(gitignorePath);
  const content = hasGitignore ? readFileSync(gitignorePath, 'utf8') : '';
  const ignored = isCursorIgnored(content);
  if (ignored) return;

  if (options.autoAdd) {
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const next = `${content}${prefix}.cursor/\n`;
    writeFileWithMode(gitignorePath, next);
    console.log(`Added .cursor/ to ${gitignorePath}`);
    return;
  }

  if (!options.writingRealToken) {
    return;
  }

  throw new Error(
    `Refusing to write a real API key into .cursor/mcp.json because .cursor/ is not gitignored in ${gitignorePath}. Re-run with --gitignore or use --template.`
  );
}

function isCursorIgnored(gitignoreContent: string): boolean {
  return gitignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === '.cursor' || line === '.cursor/' || line === '/.cursor' || line === '/.cursor/');
}

function findNearestGitRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, '.git'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function detectProjectRootFrom(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, '.git')) || existsSync(resolve(current, 'package.json'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function upsertGlitchMcpConfig(configPath: string, sseUrl: string, bearer: string): void {
  const existing = readJsonObjectIfExists(configPath);

  const mcpServersRaw = existing.mcpServers;
  if (typeof mcpServersRaw !== 'undefined' && (!mcpServersRaw || typeof mcpServersRaw !== 'object' || Array.isArray(mcpServersRaw))) {
    throw new Error(`Invalid MCP config at ${configPath}: "mcpServers" must be an object.`);
  }
  const mcpServers = (mcpServersRaw ?? {}) as Record<string, unknown>;

  mcpServers.glitch = {
    type: 'sse',
    url: sseUrl,
    headers: {
      Authorization: bearer,
    },
  };

  const next = {
    ...existing,
    mcpServers,
  };

  writeFileWithMode(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

function upsertGlitchClaudeStdioConfig(configPath: string, command: string, args: string[]): void {
  const existing = readJsonObjectIfExists(configPath);

  const mcpServersRaw = existing.mcpServers;
  if (
    typeof mcpServersRaw !== 'undefined'
    && (!mcpServersRaw || typeof mcpServersRaw !== 'object' || Array.isArray(mcpServersRaw))
  ) {
    throw new Error(`Invalid MCP config at ${configPath}: "mcpServers" must be an object.`);
  }
  const mcpServers = (mcpServersRaw ?? {}) as Record<string, unknown>;

  mcpServers.glitch = {
    type: 'stdio',
    command,
    args,
  };

  const next = {
    ...existing,
    mcpServers,
  };

  writeFileWithMode(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

function readJsonObjectIfExists(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in ${filePath}: top-level value must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeFileWithMode(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: SECURE_DIR_MODE });
  try {
    chmodSync(dirname(filePath), SECURE_DIR_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }

  writeFileSync(filePath, contents, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }
}

async function verifyCloudAccess(
  cloudUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<{ healthStatus: number; usageStatus: number }> {
  const healthUrl = new URL('/health', cloudUrl).toString();
  const healthResponse = await fetchWithTimeout(fetchImpl, healthUrl, {}, 5000);
  if (!healthResponse.ok) {
    throw new Error(`${healthUrl} responded with ${healthResponse.status} ${healthResponse.statusText}`);
  }

  const usageUrl = new URL('/v1/usage', cloudUrl).toString();
  const usageResponse = await fetchWithTimeout(
    fetchImpl,
    usageUrl,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    5000
  );

  if (!usageResponse.ok) {
    const body = (await usageResponse.text()).trim();
    throw new Error(`${usageUrl} responded with ${usageResponse.status} ${usageResponse.statusText}${body ? `: ${body}` : ''}`);
  }

  return {
    healthStatus: healthResponse.status,
    usageStatus: usageResponse.status,
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function runClaudeConnect(
  parsed: ConnectArgs,
  context: ConnectCommandContext,
  claudeConfigPath: string
): Promise<number> {
  if (parsed.claudeStdioCommand) {
    const command = parsed.claudeStdioCommand.trim();
    if (!command) {
      console.error('Value for --claude-stdio-command cannot be empty.');
      return 1;
    }
    try {
      upsertGlitchClaudeStdioConfig(claudeConfigPath, command, parsed.claudeStdioArgs);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    console.log(`Updated Claude stdio MCP config: ${claudeConfigPath}`);
    console.log('Configured using type-based stdio schema.');
    return 0;
  }

  const sseUrl = new URL('/sse', context.cloudUrl).toString();
  const apiKey = context.apiKey.trim();
  const tokenValue = formatClaudeTokenForOutput(parsed, apiKey);

  console.log('Claude Desktop ignores remote MCP servers added directly in claude_desktop_config.json.');
  console.log('Use Claude Desktop -> Settings -> Connectors to add the remote Glitch server.');
  console.log(`Connector URL: ${sseUrl}`);
  console.log(`Authorization: Bearer ${tokenValue}`);

  if (parsed.template) {
    console.log('Template mode enabled; replace [API KEY] with your real key in the Claude connector UI.');
    return 0;
  }

  if (!apiKey) {
    console.warn('No API key configured. Run `glitch config set api_key <key>` and re-run with --show-token for a ready-to-paste bearer token.');
    return 0;
  }

  if (!parsed.showToken) {
    console.log('Re-run with --show-token to print the live bearer token for manual paste.');
  }

  try {
    const verification = await verifyCloudAccess(context.cloudUrl, apiKey, context.fetchImpl ?? fetch);
    console.log(`Cloud verification: PASS (health ${verification.healthStatus}, usage ${verification.usageStatus})`);
    return 0;
  } catch (error) {
    console.error(`Cloud verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function formatClaudeTokenForOutput(parsed: ConnectArgs, apiKey: string): string {
  if (parsed.template) {
    return '[API KEY]';
  }
  if (!apiKey) {
    return '[API KEY]';
  }
  if (parsed.showToken) {
    return apiKey;
  }
  return '[REDACTED]';
}
