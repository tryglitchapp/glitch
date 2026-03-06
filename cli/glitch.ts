#!/usr/bin/env node

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { runCaptureCli } from './capture';
import { runConnectCommand } from './connect';
import { runPullCommand } from './pull';

type Destination = 'local' | 'cloud';
type ConfigKey = 'default_destination' | 'local_pack_dir' | 'cloud_url' | 'api_key';
type ConfigRecord = Record<string, unknown> & {
  default_destination?: Destination;
  local_pack_dir?: string;
  cloud_url?: string;
  api_key?: string;
};
type HealthStatus = 'PASS' | 'WARN' | 'FAIL';
type HealthCheck = {
  name: string;
  status: HealthStatus;
  detail: string;
  hint?: string;
};
type ProjectBundleMode = 'slim' | 'full';
type ProjectOutputFormat = 'dir' | 'bundle';
type ProjectConfigRecord = Record<string, unknown> & {
  contextPacksDir?: string;
  defaultBundleMode?: ProjectBundleMode;
  defaultFormat?: ProjectOutputFormat;
};
type InitProjectOptions = {
  projectPath?: string;
  contextPacksDir?: string;
  defaultBundleMode?: ProjectBundleMode;
  defaultFormat?: ProjectOutputFormat;
  gitignore: boolean;
};

const DEFAULT_CONFIG_PATH = process.env.GLITCH_CONFIG_PATH?.trim() || '~/.glitch/config.json';
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const DEFAULT_PROJECT_CONTEXT_PACKS_DIR = './context-packs';
const DEFAULT_CONFIG: Record<ConfigKey, string> = {
  default_destination: 'local',
  local_pack_dir: '~/.glitch/context-packs',
  cloud_url: 'https://mcp-server-production-b57a.up.railway.app',
  api_key: '',
};

function printUsage() {
  console.log(`glitch <command> [options]

Commands:
  capture ...                         Run capture workflow (snapshot/recorder)
  pull <packId> [options]             Download a cloud pack bundle and unpack locally
  connect <target> [options]          Write MCP config for cursor|claude|windsurf
  init [--project [path]]             Init global config or .glitch/project.json
  config set <key> <value>            Update one config value
  doctor [--json]                     Run local/cloud diagnostics
  status [--json]                     Show cloud/auth status
  help                                Show this message

Config keys:
  default_destination                 local | cloud
  local_pack_dir                      directory path
  cloud_url                           MCP server URL
  api_key                             API key for cloud uploads`);
}

function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

function resolvePath(pathLike: string): string {
  return resolve(expandHomePath(pathLike));
}

function resolveConfigPath(): string {
  return resolvePath(DEFAULT_CONFIG_PATH);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hardenConfigPermissions(configPath: string) {
  try {
    chmodSync(dirname(configPath), SECURE_DIR_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }
  try {
    chmodSync(configPath, SECURE_FILE_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }
}

function loadConfig(): ConfigRecord {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, 'utf8').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in config file "${configPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file "${configPath}" must contain a JSON object.`);
  }

  return parsed as ConfigRecord;
}

function saveConfig(config: ConfigRecord) {
  const configPath = resolveConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: SECURE_DIR_MODE });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  hardenConfigPermissions(configPath);
}

function ensureLocalPackDir(config: ConfigRecord) {
  if (!config.local_pack_dir || typeof config.local_pack_dir !== 'string') return;
  const localPackDir = resolvePath(config.local_pack_dir);
  mkdirSync(localPackDir, { recursive: true, mode: SECURE_DIR_MODE });
  try {
    chmodSync(localPackDir, SECURE_DIR_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }
}

function setMissingDefaults(config: ConfigRecord): { next: ConfigRecord; changed: boolean } {
  const next: ConfigRecord = { ...config };
  let changed = false;

  (Object.keys(DEFAULT_CONFIG) as ConfigKey[]).forEach((key) => {
    if (typeof next[key] === 'undefined') {
      next[key] = DEFAULT_CONFIG[key];
      changed = true;
    }
  });

  return { next, changed };
}

function runInit(args: string[]): number {
  if (args.length === 0) {
    return runInitGlobal();
  }

  if (args.includes('--help') || args.includes('-h')) {
    printInitUsage();
    return 0;
  }

  let parsed: InitProjectOptions;
  try {
    parsed = parseInitProjectOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'Usage: glitch init --project [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore]'
    );
    return 1;
  }

  return runInitProject(parsed);
}

function runInitGlobal(): number {
  const configPath = resolveConfigPath();
  const fileExists = existsSync(configPath);

  const existing = loadConfig();
  const { next, changed } = setMissingDefaults(existing);
  if (!fileExists || changed) {
    saveConfig(next);
  }
  ensureLocalPackDir(next);

  if (!fileExists) {
    console.log(`Created config: ${configPath}`);
  } else if (changed) {
    console.log(`Updated config with missing defaults: ${configPath}`);
  } else {
    hardenConfigPermissions(configPath);
    console.log(`Config already initialized: ${configPath}`);
  }
  console.log(`Local pack directory: ${resolvePath((next.local_pack_dir as string) || DEFAULT_CONFIG.local_pack_dir)}`);
  return 0;
}

function printInitUsage(): void {
  console.log(`glitch init [--project [path]] [options]

Global init:
  glitch init

Project init:
  glitch init --project [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore]

Project options:
  --context-packs-dir <dir>  Set contextPacksDir (default: ./context-packs)
  --default-mode <mode>      Set defaultBundleMode (slim|full)
  --default-format <format>  Set defaultFormat (dir|bundle)
  --gitignore                Append context packs dir and .cursor/ to project .gitignore`);
}

function parseInitProjectOptions(args: string[]): InitProjectOptions {
  let projectRequested = false;
  const parsed: InitProjectOptions = {
    gitignore: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--project') {
      projectRequested = true;
      const maybePath = args[i + 1];
      if (maybePath && !maybePath.startsWith('--')) {
        parsed.projectPath = maybePath;
        i += 1;
      }
      continue;
    }

    if (token === '--context-packs-dir') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --context-packs-dir');
      parsed.contextPacksDir = value;
      i += 1;
      continue;
    }

    if (token === '--default-mode') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --default-mode');
      if (value !== 'slim' && value !== 'full') {
        throw new Error(`Invalid --default-mode "${value}". Expected "slim" or "full".`);
      }
      parsed.defaultBundleMode = value;
      i += 1;
      continue;
    }

    if (token === '--default-format') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --default-format');
      if (value !== 'dir' && value !== 'bundle') {
        throw new Error(`Invalid --default-format "${value}". Expected "dir" or "bundle".`);
      }
      parsed.defaultFormat = value;
      i += 1;
      continue;
    }

    if (token === '--gitignore') {
      parsed.gitignore = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!projectRequested) {
    throw new Error('Use `glitch init` for global config, or include `--project` for project config.');
  }
  return parsed;
}

function runInitProject(options: InitProjectOptions): number {
  const cwd = process.cwd();
  const discoveredRoot = detectProjectRootFrom(cwd);
  const detectedRoot = options.projectPath
    ? resolvePath(options.projectPath)
    : discoveredRoot ?? cwd;

  if (!options.projectPath && !discoveredRoot) {
    console.warn('WARNING: Could not detect project root from .git/package.json. Using current directory.');
  }

  const projectConfigPath = resolve(detectedRoot, '.glitch', 'project.json');
  const fileExists = existsSync(projectConfigPath);

  let existing: ProjectConfigRecord;
  try {
    existing = loadProjectConfig(projectConfigPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const next: ProjectConfigRecord = { ...existing };
  let changed = false;

  const contextPacksDir = options.contextPacksDir?.trim() || next.contextPacksDir || DEFAULT_PROJECT_CONTEXT_PACKS_DIR;
  if (typeof contextPacksDir !== 'string' || !contextPacksDir.trim()) {
    console.error('contextPacksDir must be a non-empty string.');
    return 1;
  }

  if (next.contextPacksDir !== contextPacksDir) {
    next.contextPacksDir = contextPacksDir;
    changed = true;
  }

  if (options.defaultBundleMode && next.defaultBundleMode !== options.defaultBundleMode) {
    next.defaultBundleMode = options.defaultBundleMode;
    changed = true;
  }
  if (options.defaultFormat && next.defaultFormat !== options.defaultFormat) {
    next.defaultFormat = options.defaultFormat;
    changed = true;
  }

  if (!fileExists || changed) {
    saveProjectConfig(projectConfigPath, next);
  } else {
    hardenConfigPermissions(projectConfigPath);
  }

  const contextDirAbs = resolveProjectPath(detectedRoot, contextPacksDir);
  ensureDirectorySecure(contextDirAbs);

  if (options.gitignore) {
    const contextEntry = toGitignoreEntry(contextPacksDir);
    const gitignoreEntries = ['.cursor/', ...(contextEntry ? [contextEntry] : [])];
    const gitignoreResult = ensureGitignoreEntries(detectedRoot, gitignoreEntries);
    if (gitignoreResult.updated) {
      console.log(`Updated .gitignore: ${gitignoreResult.path}`);
    }
  }

  if (!fileExists) {
    console.log(`Created project config: ${projectConfigPath}`);
  } else if (changed) {
    console.log(`Updated project config: ${projectConfigPath}`);
  } else {
    console.log(`Project config already initialized: ${projectConfigPath}`);
  }
  console.log(`Project root: ${detectedRoot}`);
  console.log(`contextPacksDir: ${contextPacksDir}`);
  return 0;
}

function loadProjectConfig(projectConfigPath: string): ProjectConfigRecord {
  if (!existsSync(projectConfigPath)) {
    return {};
  }

  const raw = readFileSync(projectConfigPath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in project config "${projectConfigPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Project config "${projectConfigPath}" must contain a JSON object.`);
  }

  const record = parsed as ProjectConfigRecord;
  if (typeof record.contextPacksDir !== 'undefined' && (typeof record.contextPacksDir !== 'string' || !record.contextPacksDir.trim())) {
    throw new Error(`Project config "${projectConfigPath}" has invalid contextPacksDir.`);
  }
  if (typeof record.defaultBundleMode !== 'undefined' && record.defaultBundleMode !== 'slim' && record.defaultBundleMode !== 'full') {
    throw new Error(`Project config "${projectConfigPath}" has invalid defaultBundleMode.`);
  }
  if (typeof record.defaultFormat !== 'undefined' && record.defaultFormat !== 'dir' && record.defaultFormat !== 'bundle') {
    throw new Error(`Project config "${projectConfigPath}" has invalid defaultFormat.`);
  }

  return record;
}

function saveProjectConfig(projectConfigPath: string, config: ProjectConfigRecord): void {
  mkdirSync(dirname(projectConfigPath), { recursive: true, mode: SECURE_DIR_MODE });
  writeFileSync(projectConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECURE_FILE_MODE,
  });
  hardenConfigPermissions(projectConfigPath);
}

function detectProjectRootFrom(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, '.git')) || existsSync(resolve(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveProjectPath(projectRoot: string, pathLike: string): string {
  const expanded = expandHomePath(pathLike);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(projectRoot, expanded);
}

function ensureDirectorySecure(pathLike: string): void {
  mkdirSync(pathLike, { recursive: true, mode: SECURE_DIR_MODE });
  try {
    chmodSync(pathLike, SECURE_DIR_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }
}

function toGitignoreEntry(pathLike: string): string | null {
  const trimmed = pathLike.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('~/') || /^[A-Za-z]:/.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    return null;
  }
  return `${normalized}/`;
}

function ensureGitignoreEntries(projectRoot: string, entries: string[]): { path: string; updated: boolean } {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const normalizedExisting = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const missing = entries.filter((entry) => !normalizedExisting.has(entry));
  if (missing.length === 0) {
    return { path: gitignorePath, updated: false };
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${prefix}${missing.join('\n')}\n`;
  writeFileSync(gitignorePath, next, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  try {
    chmodSync(gitignorePath, SECURE_FILE_MODE);
  } catch {
    // Ignore unsupported chmod/chown environments.
  }

  return { path: gitignorePath, updated: true };
}

function validateConfigValue(key: ConfigKey, rawValue: string): string {
  const value = rawValue.trim();
  if (!value && key !== 'api_key') {
    throw new Error(`Value for "${key}" cannot be empty.`);
  }

  if (key === 'default_destination') {
    if (value !== 'local' && value !== 'cloud') {
      throw new Error('default_destination must be "local" or "cloud".');
    }
    return value;
  }

  if (key === 'cloud_url') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid URL for cloud_url: ${value}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('cloud_url must use http or https.');
    }
    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      throw new Error('cloud_url must use https unless host is localhost/127.0.0.1/::1.');
    }
    return value;
  }

  if (key === 'api_key') {
    return value;
  }

  return rawValue;
}

function runConfigSet(args: string[]): number {
  const [rawKey, ...valueParts] = args;
  if (!rawKey || valueParts.length === 0) {
    console.error('Usage: glitch config set <key> <value>');
    return 1;
  }

  const validKeys: ConfigKey[] = ['default_destination', 'local_pack_dir', 'cloud_url', 'api_key'];
  if (!validKeys.includes(rawKey as ConfigKey)) {
    console.error(`Unknown config key "${rawKey}". Valid keys: ${validKeys.join(', ')}`);
    return 1;
  }

  const key = rawKey as ConfigKey;
  const rawValue = valueParts.join(' ');

  let normalizedValue: string;
  try {
    normalizedValue = validateConfigValue(key, rawValue);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const existing = loadConfig();
  const next: ConfigRecord = { ...existing, [key]: normalizedValue };
  const withDefaults = setMissingDefaults(next).next;
  saveConfig(withDefaults);

  if (key === 'local_pack_dir') {
    ensureLocalPackDir(withDefaults);
  }

  console.log(`Set ${key} in ${resolveConfigPath()}`);
  return 0;
}

function runConfig(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'set') {
    console.error('Usage: glitch config set <key> <value>');
    return 1;
  }

  return runConfigSet(rest);
}

function parseJsonFlag(args: string[]): { json: boolean; extras: string[] } {
  const json = args.includes('--json');
  const extras = args.filter((arg) => arg !== '--json');
  return { json, extras };
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function isSecureFileMode(mode: number): boolean {
  const effective = mode & 0o777;
  // File should not be executable and should not grant group/other access.
  return (effective & 0o177) === 0;
}

function isSecureDirectoryMode(mode: number): boolean {
  const effective = mode & 0o777;
  // Directory should not grant group/other access.
  return (effective & 0o077) === 0;
}

function printChecks(checks: HealthCheck[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  checks.forEach((check) => {
    console.log(`[${check.status}] ${check.name}: ${check.detail}`);
    if (check.hint) {
      console.log(`  hint: ${check.hint}`);
    }
  });
}

function hasFailingChecks(checks: HealthCheck[]): boolean {
  return checks.some((check) => check.status === 'FAIL');
}

function resolveInjectorBundleCandidates(): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  return [
    resolve(currentDir, 'capture-inject.js'),
    resolve(currentDir, 'dist/capture-inject.js'),
    resolve(process.cwd(), 'cli/dist/capture-inject.js'),
  ];
}

function parseAndValidateCloudUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL for cloud_url: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('cloud_url must use http or https.');
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('cloud_url must use https unless host is localhost/127.0.0.1/::1.');
  }
  return parsed;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function runDoctor(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch doctor [--json]');
    return 1;
  }

  const checks: HealthCheck[] = [];

  const majorVersion = Number(process.versions.node.split('.')[0] ?? '0');
  if (Number.isFinite(majorVersion) && majorVersion >= 18) {
    checks.push({
      name: 'Node version',
      status: 'PASS',
      detail: `Node ${process.versions.node}`,
    });
  } else {
    checks.push({
      name: 'Node version',
      status: 'FAIL',
      detail: `Node ${process.versions.node} is unsupported.`,
      hint: 'Install Node 18+.',
    });
  }

  const configPath = resolveConfigPath();
  const hasConfig = existsSync(configPath);
  checks.push({
    name: 'Config file',
    status: hasConfig ? 'PASS' : 'WARN',
    detail: hasConfig ? configPath : `Missing config at ${configPath}`,
    hint: hasConfig ? undefined : 'Run `glitch init`.',
  });

  let config: ConfigRecord = {};
  let configLoadError: string | null = null;
  try {
    config = loadConfig();
    checks.push({
      name: 'Config JSON',
      status: 'PASS',
      detail: 'Configuration is valid JSON.',
    });
  } catch (error) {
    configLoadError = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'Config JSON',
      status: 'FAIL',
      detail: configLoadError,
      hint: 'Fix JSON syntax or run `glitch init`.',
    });
  }

  if (hasConfig && !configLoadError) {
    try {
      const configStat = statSync(configPath);
      const configMode = configStat.mode;
      checks.push({
        name: 'Config file permissions',
        status: isSecureFileMode(configMode) ? 'PASS' : 'WARN',
        detail: `mode ${formatMode(configMode)}`,
        hint: isSecureFileMode(configMode) ? undefined : `Run: chmod 600 ${configPath}`,
      });
    } catch (error) {
      checks.push({
        name: 'Config file permissions',
        status: 'WARN',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const configDir = dirname(configPath);
      const configDirStat = statSync(configDir);
      const configDirMode = configDirStat.mode;
      checks.push({
        name: 'Config directory permissions',
        status: isSecureDirectoryMode(configDirMode) ? 'PASS' : 'WARN',
        detail: `mode ${formatMode(configDirMode)}`,
        hint: isSecureDirectoryMode(configDirMode) ? undefined : `Run: chmod 700 ${configDir}`,
      });
    } catch (error) {
      checks.push({
        name: 'Config directory permissions',
        status: 'WARN',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const localPackDir = resolvePath(
    typeof config.local_pack_dir === 'string' && config.local_pack_dir.trim()
      ? config.local_pack_dir
      : DEFAULT_CONFIG.local_pack_dir
  );
  try {
    mkdirSync(localPackDir, { recursive: true, mode: SECURE_DIR_MODE });
    accessSync(localPackDir, constants.R_OK | constants.W_OK);
    checks.push({
      name: 'Local pack directory',
      status: 'PASS',
      detail: `${localPackDir} is readable/writable.`,
    });
  } catch (error) {
    checks.push({
      name: 'Local pack directory',
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      hint: `Ensure directory exists and is writable: ${localPackDir}`,
    });
  }

  try {
    const localDirStat = statSync(localPackDir);
    const localDirMode = localDirStat.mode;
    checks.push({
      name: 'Local pack directory permissions',
      status: isSecureDirectoryMode(localDirMode) ? 'PASS' : 'WARN',
      detail: `mode ${formatMode(localDirMode)}`,
      hint: isSecureDirectoryMode(localDirMode) ? undefined : `Run: chmod 700 ${localPackDir}`,
    });
  } catch (error) {
    checks.push({
      name: 'Local pack directory permissions',
      status: 'WARN',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const bundleCandidates = resolveInjectorBundleCandidates();
  const bundlePath = bundleCandidates.find((candidate) => existsSync(candidate)) ?? null;
  checks.push({
    name: 'CLI injector bundle',
    status: bundlePath ? 'PASS' : 'FAIL',
    detail: bundlePath ?? `Not found. Checked: ${bundleCandidates.join(', ')}`,
    hint: bundlePath ? undefined : 'Run `npm run build:cli-inject`.',
  });

  try {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
    checks.push({
      name: 'Playwright',
      status: 'PASS',
      detail: 'Chromium launch smoke test succeeded.',
    });
  } catch (error) {
    checks.push({
      name: 'Playwright',
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Install Playwright/browser binaries: npm install playwright && npx playwright install chromium',
    });
  }

  const cloudUrlValue =
    typeof config.cloud_url === 'string' && config.cloud_url.trim()
      ? config.cloud_url.trim()
      : DEFAULT_CONFIG.cloud_url;
  let parsedCloudUrl: URL | null = null;
  try {
    parsedCloudUrl = parseAndValidateCloudUrl(cloudUrlValue);
    checks.push({
      name: 'Cloud URL',
      status: 'PASS',
      detail: parsedCloudUrl.toString(),
    });
  } catch (error) {
    checks.push({
      name: 'Cloud URL',
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Run `glitch config set cloud_url https://...`.',
    });
  }

  if (parsedCloudUrl) {
    const healthUrl = new URL('/health', parsedCloudUrl).toString();
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(healthUrl, {}, 5000);
      const latencyMs = Date.now() - startedAt;
      checks.push({
        name: 'Cloud health',
        status: response.ok ? 'PASS' : 'FAIL',
        detail: `${response.status} ${response.statusText} (${latencyMs}ms)`,
        hint: response.ok ? undefined : `Verify MCP server health endpoint: ${healthUrl}`,
      });
    } catch (error) {
      checks.push({
        name: 'Cloud health',
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
        hint: `Verify connectivity to ${healthUrl}`,
      });
    }
  }

  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  if (!parsedCloudUrl) {
    checks.push({
      name: 'Cloud usage',
      status: 'WARN',
      detail: 'Skipped because cloud URL is invalid.',
    });
  } else if (!apiKey) {
    checks.push({
      name: 'Cloud usage',
      status: 'WARN',
      detail: 'No API key configured.',
      hint: 'Run `glitch config set api_key <key>`.',
    });
  } else {
    const usageUrl = new URL('/v1/usage', parsedCloudUrl).toString();
    try {
      const response = await fetchWithTimeout(
        usageUrl,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
        5000
      );
      if (!response.ok) {
        checks.push({
          name: 'Cloud usage',
          status: 'FAIL',
          detail: `${response.status} ${response.statusText}`,
          hint: 'Verify API key validity.',
        });
      } else {
        const body = (await response.json()) as Record<string, unknown>;
        const remaining = typeof body.remaining === 'number' ? body.remaining : null;
        const limit = typeof body.limit === 'number' ? body.limit : null;
        checks.push({
          name: 'Cloud usage',
          status: 'PASS',
          detail: remaining !== null && limit !== null
            ? `remaining=${remaining}, limit=${limit}`
            : 'Usage endpoint reachable.',
        });
      }
    } catch (error) {
      checks.push({
        name: 'Cloud usage',
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
        hint: `Verify connectivity/auth to ${usageUrl}`,
      });
    }
  }

  printChecks(checks, json);
  return hasFailingChecks(checks) ? 1 : 0;
}

async function runStatus(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch status [--json]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    } else {
      console.error(detail);
    }
    return 1;
  }

  const cloudUrlValue =
    typeof config.cloud_url === 'string' && config.cloud_url.trim()
      ? config.cloud_url.trim()
      : DEFAULT_CONFIG.cloud_url;

  let parsedCloudUrl: URL;
  try {
    parsedCloudUrl = parseAndValidateCloudUrl(cloudUrlValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, cloudUrl: cloudUrlValue, error: detail }, null, 2));
    } else {
      console.error(`Cloud URL invalid: ${detail}`);
    }
    return 1;
  }

  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  const status: Record<string, unknown> = {
    ok: true,
    cloudUrl: parsedCloudUrl.toString(),
    apiKeyConfigured: Boolean(apiKey),
  };

  const healthUrl = new URL('/health', parsedCloudUrl).toString();
  try {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(healthUrl, {}, 5000);
    status.health = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      latencyMs: Date.now() - startedAt,
    };
    if (!response.ok) {
      status.ok = false;
    }
  } catch (error) {
    status.health = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    status.ok = false;
  }

  if (apiKey) {
    const usageUrl = new URL('/v1/usage', parsedCloudUrl).toString();
    try {
      const response = await fetchWithTimeout(
        usageUrl,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
        5000
      );
      if (response.ok) {
        status.usage = await response.json();
      } else {
        status.usage = {
          ok: false,
          status: response.status,
          statusText: response.statusText,
        };
        status.ok = false;
      }
    } catch (error) {
      status.usage = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      status.ok = false;
    }
  }

  const health = status.health as Record<string, unknown> | undefined;
  const healthOk = health?.ok === true;
  const usage = status.usage as Record<string, unknown> | undefined;
  const usageHasAuthFailure =
    Boolean(usage && typeof usage.status === 'number' && [401, 403].includes(usage.status as number));
  const usageOk = Boolean(usage && !usageHasAuthFailure && usage.ok !== false);

  let state: 'connected' | 'reachable_unauthenticated' | 'degraded' | 'offline';
  if (!healthOk) {
    state = 'offline';
  } else if (!apiKey) {
    state = 'reachable_unauthenticated';
  } else if (usageOk) {
    state = 'connected';
  } else if (usageHasAuthFailure) {
    state = 'reachable_unauthenticated';
  } else {
    state = 'degraded';
  }

  status.state = state;

  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`State: ${state}`);
    console.log(`Cloud URL: ${String(status.cloudUrl)}`);
    if (health?.ok) {
      console.log(`Health: PASS (${String(health.status)} ${String(health.statusText)}, ${String(health.latencyMs)}ms)`);
    } else {
      console.log(`Health: FAIL (${String(health?.error ?? `${health?.status} ${health?.statusText}`)})`);
    }
    console.log(`API key configured: ${status.apiKeyConfigured ? 'yes' : 'no'}`);
    if (status.usage) {
      const usageRow = status.usage as Record<string, unknown>;
      if (typeof usageRow.remaining === 'number' && typeof usageRow.limit === 'number') {
        const plan = typeof usageRow.plan === 'string' ? usageRow.plan : 'unknown';
        console.log(`Usage: ${usageRow.remaining}/${usageRow.limit} remaining (${plan})`);
      } else {
        console.log(`Usage: ${JSON.stringify(status.usage)}`);
      }
    }
  }

  return state === 'connected' || state === 'reachable_unauthenticated' ? 0 : 1;
}

async function runPull(args: string[]): Promise<number> {
  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const cloudUrlValue =
    typeof config.cloud_url === 'string' && config.cloud_url.trim()
      ? config.cloud_url.trim()
      : DEFAULT_CONFIG.cloud_url;

  let parsedCloudUrl: URL;
  try {
    parsedCloudUrl = parseAndValidateCloudUrl(cloudUrlValue);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  return await runPullCommand(args, {
    cloudUrl: parsedCloudUrl.toString(),
    apiKey,
    cwd: process.cwd(),
  });
}

async function runConnect(args: string[]): Promise<number> {
  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const cloudUrlValue =
    typeof config.cloud_url === 'string' && config.cloud_url.trim()
      ? config.cloud_url.trim()
      : DEFAULT_CONFIG.cloud_url;

  let parsedCloudUrl: URL;
  try {
    parsedCloudUrl = parseAndValidateCloudUrl(cloudUrlValue);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  return await runConnectCommand(args, {
    cloudUrl: parsedCloudUrl.toString(),
    apiKey,
    cwd: process.cwd(),
  });
}

export async function runGlitchCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  try {
    if (command === 'capture') {
      return await runCaptureCli(rest);
    }
    if (command === 'init') {
      return runInit(rest);
    }
    if (command === 'config') {
      return runConfig(rest);
    }
    if (command === 'doctor') {
      return await runDoctor(rest);
    }
    if (command === 'status') {
      return await runStatus(rest);
    }
    if (command === 'pull') {
      return await runPull(rest);
    }
    if (command === 'connect') {
      return await runConnect(rest);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

const exitCode = await runGlitchCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
