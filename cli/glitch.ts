#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  addActiveIssue as addActiveIssueRequest,
  clearActiveIssues as clearActiveIssuesRequest,
  listActiveIssues as listActiveIssuesRequest,
  removeActiveIssue as removeActiveIssueRequest,
  type ActiveIssueSummary,
} from './active-issues';
import { runCaptureCli } from './capture';
import { runConnectCommand } from './connect';
import { copyToClipboard } from './lib/clipboard';
import { loadPackFromReference, type HydratedPack } from './lib/pack-loader';
import { runPullCommand } from './pull';
import { generatePrompt, type PromptFramework, type PromptStyle } from '../src/lib/prompt/generator';
import type { PromptTarget } from '../src/lib/prompt/templates';

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
type WorkspaceRecord = {
  name: string;
  root: string;
  createdAt: string;
  lastUsedAt: string;
};
type WorkspaceRegistryRecord = {
  current: string | null;
  workspaces: WorkspaceRecord[];
};
type WorkspaceInitOptions = InitProjectOptions & {
  workspaceName?: string;
  use: boolean;
  registerWorkspace?: boolean;
};
type WorkspaceAddOptions = {
  projectPath?: string;
  workspaceName: string;
};
type PacksSourceFilter = 'snapshot' | 'recorder';
type PromptTargetOption = PromptTarget;
type PromptMode = ProjectBundleMode;
type PromptGenerateOptions = {
  packRef: string;
  target: PromptTargetOption;
  framework: PromptFramework;
  style: PromptStyle;
  includeCode: boolean;
  json: boolean;
  mode?: PromptMode;
  workspace?: string;
};
type PromptCopyOptions = PromptGenerateOptions & {
  json: false;
};
type CloudRuntimeContext = {
  cloudUrl: string;
  apiKey: string;
};
type CliCommand = {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  run: (args: string[]) => Promise<number> | number;
};

const DEFAULT_CONFIG_PATH = process.env.GLITCH_CONFIG_PATH?.trim() || '~/.glitch/config.json';
const DEFAULT_WORKSPACES_PATH = process.env.GLITCH_WORKSPACES_PATH?.trim() || '~/.glitch/workspaces.json';
const DEFAULT_WEB_URL = process.env.GLITCH_WEB_BASE_URL?.trim() || 'https://www.tryglitch.app';
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const DEFAULT_PROJECT_CONTEXT_PACKS_DIR = './context-packs';
const VALID_CONFIG_KEYS: ConfigKey[] = ['default_destination', 'local_pack_dir', 'cloud_url', 'api_key'];
const DEFAULT_CONFIG: Record<ConfigKey, string> = {
  default_destination: 'local',
  local_pack_dir: '~/.glitch/context-packs',
  cloud_url: 'https://mcp-server-production-b57a.up.railway.app',
  api_key: '',
};

function printUsage() {
  const commandRows = getCommandHelpRows();
  const labelWidth = commandRows.reduce((max, row) => Math.max(max, row.label.length), 0);
  const renderedCommands = commandRows
    .map((row) => `  ${row.label.padEnd(labelWidth + 2)}${row.summary}`)
    .join('\n');

  console.log(`glitch <command> [options]

Commands:
${renderedCommands}

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

function resolveWorkspacesPath(): string {
  return resolvePath(DEFAULT_WORKSPACES_PATH);
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

function loadWorkspaceRegistry(): WorkspaceRegistryRecord {
  const registryPath = resolveWorkspacesPath();
  if (!existsSync(registryPath)) {
    return { current: null, workspaces: [] };
  }

  const raw = readFileSync(registryPath, 'utf8').trim();
  if (!raw) {
    return { current: null, workspaces: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in workspace registry "${registryPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Workspace registry "${registryPath}" must contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  const rawCurrent = record.current;
  const rawWorkspaces = typeof record.workspaces === 'undefined' ? [] : record.workspaces;
  if (!Array.isArray(rawWorkspaces)) {
    throw new Error(`Workspace registry "${registryPath}" is missing "workspaces" array.`);
  }
  if (typeof rawCurrent !== 'undefined' && rawCurrent !== null && typeof rawCurrent !== 'string') {
    throw new Error(`Workspace registry "${registryPath}" has invalid "current" value.`);
  }

  const seenNames = new Set<string>();
  const seenRoots = new Set<string>();
  const workspaces: WorkspaceRecord[] = rawWorkspaces.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Workspace registry "${registryPath}" has invalid workspace at index ${index}.`);
    }

    const row = entry as Record<string, unknown>;
    const name = normalizeWorkspaceName(readRequiredString(row, 'name', registryPath, index));
    const root = resolvePath(readRequiredString(row, 'root', registryPath, index));
    const createdAt = readRequiredString(row, 'createdAt', registryPath, index);
    const lastUsedAt = readRequiredString(row, 'lastUsedAt', registryPath, index);
    if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(lastUsedAt))) {
      throw new Error(`Workspace registry "${registryPath}" has invalid timestamps at index ${index}.`);
    }
    if (seenNames.has(name)) {
      throw new Error(`Workspace registry "${registryPath}" has duplicate workspace name "${name}".`);
    }
    if (seenRoots.has(root)) {
      throw new Error(`Workspace registry "${registryPath}" has duplicate workspace root "${root}".`);
    }
    seenNames.add(name);
    seenRoots.add(root);

    return {
      name,
      root,
      createdAt,
      lastUsedAt,
    };
  });

  const current = typeof rawCurrent === 'string' && workspaces.some((workspace) => workspace.name === rawCurrent)
    ? rawCurrent
    : null;

  return { current, workspaces };
}

function saveWorkspaceRegistry(registry: WorkspaceRegistryRecord): void {
  const registryPath = resolveWorkspacesPath();
  mkdirSync(dirname(registryPath), { recursive: true, mode: SECURE_DIR_MODE });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECURE_FILE_MODE,
  });
  hardenConfigPermissions(registryPath);
}

function readRequiredString(
  row: Record<string, unknown>,
  key: string,
  registryPath: string,
  index: number
): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Workspace registry "${registryPath}" has invalid "${key}" at index ${index}.`);
  }
  return value.trim();
}

function normalizeWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Workspace name must be a non-empty string.');
  }
  return trimmed;
}

function deriveWorkspaceNameFromRoot(projectRoot: string): string {
  const candidate = basename(projectRoot).trim();
  if (!candidate) {
    throw new Error(`Unable to derive workspace name from root: ${projectRoot}`);
  }
  return candidate;
}

function findWorkspaceByName(registry: WorkspaceRegistryRecord, name: string): WorkspaceRecord | null {
  return registry.workspaces.find((workspace) => workspace.name === name) ?? null;
}

function findWorkspaceByRoot(registry: WorkspaceRegistryRecord, root: string): WorkspaceRecord | null {
  const normalizedRoot = resolve(root);
  return registry.workspaces.find((workspace) => workspace.root === normalizedRoot) ?? null;
}

function upsertWorkspace(
  registry: WorkspaceRegistryRecord,
  name: string,
  root: string,
  nowIso: string
): { next: WorkspaceRegistryRecord; workspace: WorkspaceRecord; created: boolean } {
  const normalizedName = normalizeWorkspaceName(name);
  const normalizedRoot = resolve(root);
  const byName = findWorkspaceByName(registry, normalizedName);
  const byRoot = findWorkspaceByRoot(registry, normalizedRoot);

  if (byName && byName.root !== normalizedRoot) {
    throw new Error(`Workspace name "${normalizedName}" is already registered for ${byName.root}.`);
  }

  if (byRoot && byRoot.name !== normalizedName) {
    throw new Error(`Workspace root "${normalizedRoot}" is already registered as "${byRoot.name}".`);
  }

  if (!byName && !byRoot) {
    const workspace: WorkspaceRecord = {
      name: normalizedName,
      root: normalizedRoot,
      createdAt: nowIso,
      lastUsedAt: nowIso,
    };
    return {
      next: {
        ...registry,
        workspaces: [...registry.workspaces, workspace],
      },
      workspace,
      created: true,
    };
  }

  const existing = (byName ?? byRoot) as WorkspaceRecord;
  const workspace: WorkspaceRecord = {
    ...existing,
    lastUsedAt: nowIso,
  };
  return {
    next: {
      ...registry,
      workspaces: registry.workspaces.map((entry) => (entry.name === existing.name ? workspace : entry)),
    },
    workspace,
    created: false,
  };
}

function setWorkspaceCurrent(
  registry: WorkspaceRegistryRecord,
  name: string,
  nowIso: string
): { next: WorkspaceRegistryRecord; workspace: WorkspaceRecord } {
  const workspace = findWorkspaceByName(registry, name);
  if (!workspace) {
    throw new Error(`Workspace "${name}" is not registered.`);
  }

  const updatedWorkspace: WorkspaceRecord = {
    ...workspace,
    lastUsedAt: nowIso,
  };
  return {
    next: {
      current: workspace.name,
      workspaces: registry.workspaces.map((entry) => (entry.name === workspace.name ? updatedWorkspace : entry)),
    },
    workspace: updatedWorkspace,
  };
}

function findWorkspaceByNameOrPath(registry: WorkspaceRegistryRecord, token: string): WorkspaceRecord | null {
  const byName = findWorkspaceByName(registry, token);
  if (byName) return byName;
  const byRoot = findWorkspaceByRoot(registry, token);
  if (byRoot) return byRoot;
  return null;
}

function printWorkspaceListTable(registry: WorkspaceRegistryRecord): void {
  if (registry.workspaces.length === 0) {
    console.log('No workspaces registered.');
    return;
  }

  const rows = registry.workspaces.map((workspace) => ({
    current: registry.current === workspace.name ? '*' : '',
    name: workspace.name,
    root: workspace.root,
    lastUsedAt: workspace.lastUsedAt,
  }));

  const currentWidth = Math.max(...rows.map((row) => row.current.length), 1);
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 'name'.length);
  const rootWidth = Math.max(...rows.map((row) => row.root.length), 'root'.length);

  console.log(
    `${' '.repeat(currentWidth)}  ${'name'.padEnd(nameWidth)}  ${'root'.padEnd(rootWidth)}  lastUsedAt`
  );
  rows.forEach((row) => {
    console.log(
      `${row.current.padEnd(currentWidth)}  ${row.name.padEnd(nameWidth)}  ${row.root.padEnd(rootWidth)}  ${row.lastUsedAt}`
    );
  });
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

  VALID_CONFIG_KEYS.forEach((key) => {
    if (typeof next[key] === 'undefined') {
      (next as Record<ConfigKey, unknown>)[key] = DEFAULT_CONFIG[key];
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

  let parsed: WorkspaceInitOptions;
  try {
    parsed = parseInitProjectOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'Usage: glitch init --project [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore] [--name <workspace-name>] [--use]'
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
  glitch init --project [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore] [--name <workspace-name>] [--use]

Project options:
  --context-packs-dir <dir>  Set contextPacksDir (default: ./context-packs)
  --default-mode <mode>      Set defaultBundleMode (slim|full)
  --default-format <format>  Set defaultFormat (dir|bundle)
  --gitignore                Append context packs dir and .cursor/ to project .gitignore
  --name <workspace-name>    Register this project root as a named workspace
  --use                      Register and set this workspace as current`);
}

function parseInitProjectOptions(args: string[]): WorkspaceInitOptions {
  let projectRequested = false;
  const parsed: WorkspaceInitOptions = {
    gitignore: false,
    use: false,
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

    if (token === '--name') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --name');
      parsed.workspaceName = normalizeWorkspaceName(value);
      i += 1;
      continue;
    }

    if (token === '--use') {
      parsed.use = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!projectRequested) {
    throw new Error('Use `glitch init` for global config, or include `--project` for project config.');
  }
  return parsed;
}

function runInitProject(options: WorkspaceInitOptions): number {
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

  const shouldRegisterWorkspace = typeof options.registerWorkspace === 'boolean'
    ? options.registerWorkspace
    : Boolean(options.workspaceName) || options.use;
  if (shouldRegisterWorkspace) {
    let registry: WorkspaceRegistryRecord;
    try {
      registry = loadWorkspaceRegistry();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const nowIso = new Date().toISOString();
    let workspaceName = options.workspaceName?.trim();
    if (!workspaceName) {
      workspaceName = findWorkspaceByRoot(registry, detectedRoot)?.name ?? deriveWorkspaceNameFromRoot(detectedRoot);
    }

    if (!workspaceName) {
      console.error('Workspace registration requested but no workspace name could be resolved.');
      return 1;
    }

    try {
      const upserted = upsertWorkspace(registry, workspaceName, detectedRoot, nowIso);
      let nextRegistry = upserted.next;

      if (upserted.created) {
        console.log(`Registered workspace "${upserted.workspace.name}" -> ${upserted.workspace.root}`);
      } else {
        console.log(`Workspace "${upserted.workspace.name}" already registered.`);
      }

      if (options.use) {
        const current = setWorkspaceCurrent(nextRegistry, upserted.workspace.name, nowIso);
        nextRegistry = current.next;
        console.log(`Current workspace set to "${current.workspace.name}".`);
      }

      saveWorkspaceRegistry(nextRegistry);
      console.log(`Workspace registry: ${resolveWorkspacesPath()}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

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

  if (!VALID_CONFIG_KEYS.includes(rawKey as ConfigKey)) {
    console.error(`Unknown config key "${rawKey}". Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
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

function runConfigGet(args: string[]): number {
  const { json, showSecret, extras } = parseConfigOutputFlags(args);
  const [rawKey] = extras;
  if (!rawKey || extras.length !== 1) {
    console.error('Usage: glitch config get <key> [--json] [--show-secret]');
    return 1;
  }

  if (!VALID_CONFIG_KEYS.includes(rawKey as ConfigKey)) {
    console.error(`Unknown config key "${rawKey}". Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
    return 1;
  }

  const key = rawKey as ConfigKey;
  let existing: ConfigRecord;
  try {
    existing = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const rawValue = setMissingDefaults(existing).next[key] ?? '';
  const formatted = formatConfigValueForOutput(key, rawValue, { showSecret });
  if (json) {
    const payload: Record<string, unknown> = { key, value: formatted.value };
    if (typeof formatted.configured === 'boolean') {
      payload.configured = formatted.configured;
    }
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatted.value);
  }
  return 0;
}

function runConfigList(args: string[]): number {
  const { json, showSecret, extras } = parseConfigOutputFlags(args);
  if (extras.length > 0) {
    console.error('Usage: glitch config list [--json] [--show-secret]');
    return 1;
  }

  let existing: ConfigRecord;
  try {
    existing = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const effective = setMissingDefaults(existing).next;
  const values = VALID_CONFIG_KEYS.reduce<Record<ConfigKey, string>>((acc, key) => {
    const raw = effective[key];
    acc[key] = formatConfigValueForOutput(key, raw, { showSecret }).value;
    return acc;
  }, {
    default_destination: '',
    local_pack_dir: '',
    cloud_url: '',
    api_key: '',
  });

  if (json) {
    console.log(JSON.stringify(values, null, 2));
  } else {
    VALID_CONFIG_KEYS.forEach((key) => {
      console.log(`${key}=${values[key]}`);
    });
  }
  return 0;
}

function runConfig(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: glitch config <set|get|list> ...');
    console.log('  glitch config set <key> <value>');
    console.log('  glitch config get <key> [--json] [--show-secret]');
    console.log('  glitch config list [--json] [--show-secret]');
    return subcommand ? 0 : 1;
  }
  if (subcommand === 'set') {
    return runConfigSet(rest);
  }
  if (subcommand === 'get') {
    return runConfigGet(rest);
  }
  if (subcommand === 'list') {
    return runConfigList(rest);
  }

  console.error('Usage: glitch config <set|get|list> ...');
  console.error('  glitch config set <key> <value>');
  console.error('  glitch config get <key> [--json] [--show-secret]');
  console.error('  glitch config list [--json] [--show-secret]');
  return 1;
}

function parseWorkspaceInitArgs(args: string[]): WorkspaceInitOptions {
  const parsed: WorkspaceInitOptions = {
    gitignore: false,
    use: true,
    registerWorkspace: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

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

    if (token === '--name') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --name');
      parsed.workspaceName = normalizeWorkspaceName(value);
      i += 1;
      continue;
    }

    if (token === '--use') {
      parsed.use = true;
      parsed.registerWorkspace = true;
      continue;
    }

    if (token === '--no-use') {
      parsed.use = false;
      continue;
    }

    if (token === '--no-register') {
      parsed.registerWorkspace = false;
      parsed.use = false;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (parsed.projectPath) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    parsed.projectPath = token;
  }

  return parsed;
}

function parseWorkspaceAddArgs(args: string[]): WorkspaceAddOptions {
  const parsed: WorkspaceAddOptions = {
    workspaceName: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--name') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --name');
      parsed.workspaceName = normalizeWorkspaceName(value);
      i += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (parsed.projectPath) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    parsed.projectPath = token;
  }

  if (!parsed.workspaceName) {
    throw new Error('Missing required --name <workspace-name>.');
  }

  return parsed;
}

function runWorkspaceInitCommand(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: glitch workspace init [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore] [--name <workspace-name>] [--use|--no-use] [--no-register]');
    return 0;
  }

  let parsed: WorkspaceInitOptions;
  try {
    parsed = parseWorkspaceInitArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch workspace init [path] [--context-packs-dir <dir>] [--default-mode slim|full] [--default-format dir|bundle] [--gitignore] [--name <workspace-name>] [--use|--no-use] [--no-register]');
    return 1;
  }

  return runInitProject(parsed);
}

function runWorkspaceAddCommand(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: glitch workspace add [path] --name <workspace-name>');
    return 0;
  }

  let parsed: WorkspaceAddOptions;
  try {
    parsed = parseWorkspaceAddArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch workspace add [path] --name <workspace-name>');
    return 1;
  }

  const cwd = process.cwd();
  const discoveredRoot = detectProjectRootFrom(cwd);
  const projectRoot = parsed.projectPath
    ? resolvePath(parsed.projectPath)
    : discoveredRoot ?? cwd;

  if (!parsed.projectPath && !discoveredRoot) {
    console.warn('WARNING: Could not detect project root from .git/package.json. Using current directory.');
  }

  if (!existsSync(projectRoot)) {
    console.error(`Project root does not exist: ${projectRoot}`);
    return 1;
  }

  const projectRootStat = statSync(projectRoot);
  if (!projectRootStat.isDirectory()) {
    console.error(`Project root is not a directory: ${projectRoot}`);
    return 1;
  }

  let registry: WorkspaceRegistryRecord;
  try {
    registry = loadWorkspaceRegistry();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const nowIso = new Date().toISOString();
    const upserted = upsertWorkspace(registry, parsed.workspaceName, projectRoot, nowIso);
    saveWorkspaceRegistry(upserted.next);
    if (upserted.created) {
      console.log(`Registered workspace "${upserted.workspace.name}" -> ${upserted.workspace.root}`);
    } else {
      console.log(`Workspace "${upserted.workspace.name}" already registered.`);
    }
    console.log(`Workspace registry: ${resolveWorkspacesPath()}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runWorkspaceListCommand(args: string[]): number {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch workspace list [--json]');
    return 1;
  }

  let registry: WorkspaceRegistryRecord;
  try {
    registry = loadWorkspaceRegistry();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(registry, null, 2));
  } else {
    printWorkspaceListTable(registry);
  }

  return 0;
}

function runWorkspaceUseCommand(args: string[]): number {
  const { json, extras } = parseJsonFlag(args);
  const [target] = extras;
  if (!target || extras.length !== 1) {
    console.error('Usage: glitch workspace use <name|path> [--json]');
    return 1;
  }

  let registry: WorkspaceRegistryRecord;
  try {
    registry = loadWorkspaceRegistry();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const resolved = findWorkspaceByNameOrPath(registry, target);
  if (!resolved) {
    console.error(`Workspace not found: ${target}`);
    return 1;
  }

  try {
    const nowIso = new Date().toISOString();
    const current = setWorkspaceCurrent(registry, resolved.name, nowIso);
    saveWorkspaceRegistry(current.next);
    if (json) {
      console.log(JSON.stringify(current.workspace, null, 2));
    } else {
      console.log(`Current workspace: ${current.workspace.name}`);
      console.log(`Root: ${current.workspace.root}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runWorkspaceCurrentCommand(args: string[]): number {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch workspace current [--json]');
    return 1;
  }

  let registry: WorkspaceRegistryRecord;
  try {
    registry = loadWorkspaceRegistry();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (!registry.current) {
    console.error('No current workspace is set.');
    return 1;
  }

  const workspace = findWorkspaceByName(registry, registry.current);
  if (!workspace) {
    console.error(`Current workspace "${registry.current}" is missing from registry.`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(workspace, null, 2));
  } else {
    console.log(`Current workspace: ${workspace.name}`);
    console.log(`Root: ${workspace.root}`);
  }
  return 0;
}

function parseJsonFlag(args: string[]): { json: boolean; extras: string[] } {
  const json = args.includes('--json');
  const extras = args.filter((arg) => arg !== '--json');
  return { json, extras };
}

function parseConfigOutputFlags(args: string[]): { json: boolean; showSecret: boolean; extras: string[] } {
  const json = args.includes('--json');
  const showSecret = args.includes('--show-secret');
  const extras = args.filter((arg) => arg !== '--json' && arg !== '--show-secret');
  return { json, showSecret, extras };
}

function formatConfigValueForOutput(
  key: ConfigKey,
  rawValue: unknown,
  options: {
    showSecret: boolean;
  }
): { value: string; configured?: boolean } {
  const value = typeof rawValue === 'string' ? rawValue : '';
  if (key !== 'api_key') {
    return { value };
  }

  const configured = value.trim().length > 0;
  if (!configured || options.showSecret) {
    return { value, configured };
  }

  return {
    value: '[REDACTED]',
    configured,
  };
}

function parseWorkspaceFlag(args: string[]): { workspace?: string; extras: string[] } {
  const extras: string[] = [];
  let workspace: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--workspace') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('Missing value for --workspace');
      }
      if (workspace) {
        throw new Error('Use --workspace only once.');
      }
      workspace = value;
      i += 1;
      continue;
    }
    extras.push(token);
  }

  return { workspace, extras };
}

function resolveWorkspaceRoot(workspaceToken?: string): string | null {
  if (workspaceToken) {
    let registry: WorkspaceRegistryRecord;
    try {
      registry = loadWorkspaceRegistry();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }

    const fromRegistry = findWorkspaceByNameOrPath(registry, workspaceToken);
    if (fromRegistry) {
      return fromRegistry.root;
    }

    const explicitPath = resolvePath(workspaceToken);
    if (existsSync(explicitPath) && statSync(explicitPath).isDirectory()) {
      return explicitPath;
    }

    throw new Error(`Workspace not found: ${workspaceToken}`);
  }

  let registry: WorkspaceRegistryRecord | null = null;
  try {
    registry = loadWorkspaceRegistry();
  } catch {
    registry = null;
  }

  if (registry?.current) {
    const current = findWorkspaceByName(registry, registry.current);
    if (current) {
      return current.root;
    }
  }

  return detectProjectRootFrom(process.cwd());
}

function resolveCloudRuntimeContext(config: ConfigRecord, requireApiKey: boolean): CloudRuntimeContext {
  const cloudUrlValue =
    typeof config.cloud_url === 'string' && config.cloud_url.trim()
      ? config.cloud_url.trim()
      : DEFAULT_CONFIG.cloud_url;

  const parsedCloudUrl = parseAndValidateCloudUrl(cloudUrlValue);
  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  if (requireApiKey && !apiKey) {
    throw new Error('No bearer token available. Set `api_key` via `glitch config set api_key <key>`.');
  }

  return {
    cloudUrl: parsedCloudUrl.toString(),
    apiKey,
  };
}

function parseHttpErrorDetail(bodyText: string, fallback: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return fallback || 'Request failed';
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Keep raw body.
  }

  return trimmed;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an unexpected payload.`);
  }

  return parsed as Record<string, unknown>;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getLoginWebUrlBase(): string {
  return normalizeBaseUrl(DEFAULT_WEB_URL);
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type BrowserOpenResult = {
  opened: boolean;
  method?: string;
  error?: string;
};

function openUrlInBrowser(url: string): BrowserOpenResult {
  if (process.env.GLITCH_NO_BROWSER_OPEN === '1') {
    return { opened: false, error: 'disabled by GLITCH_NO_BROWSER_OPEN=1' };
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('open', [url], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return { opened: true, method: 'open' };
    return {
      opened: false,
      error: result.error?.message || result.stderr?.toString()?.trim() || 'open failed',
    };
  }

  if (process.platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'start', '', url], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return { opened: true, method: 'start' };
    return {
      opened: false,
      error: result.error?.message || result.stderr?.toString()?.trim() || 'start failed',
    };
  }

  const result = spawnSync('xdg-open', [url], { encoding: 'utf8' });
  if (!result.error && result.status === 0) return { opened: true, method: 'xdg-open' };
  return {
    opened: false,
    error: result.error?.message || result.stderr?.toString()?.trim() || 'xdg-open failed',
  };
}

async function confirmPrompt(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${message} [y/N] `, (value) => {
      rl.close();
      resolve(value);
    });
  });

  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
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

async function runPull(args: string[], options: { cwd?: string } = {}): Promise<number> {
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
    cwd: options.cwd ?? process.cwd(),
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

function printWorkspaceUsage() {
  console.log(`glitch workspace <subcommand> [options]

Subcommands:
  init [path] [options]      Initialize .glitch/project.json, register workspace, and set current by default
  add [path] --name <name>   Register existing project root as workspace
  list [--json]              List saved workspaces
  use <name|path> [--json]   Set current workspace
  current [--json]           Show current workspace`);
}

async function runWorkspace(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.error('Usage: glitch workspace <init|add|list|use|current> ...');
    return 1;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printWorkspaceUsage();
    return 0;
  }

  if (subcommand === 'init') {
    return runWorkspaceInitCommand(rest);
  }
  if (subcommand === 'add') {
    return runWorkspaceAddCommand(rest);
  }
  if (subcommand === 'list') {
    return runWorkspaceListCommand(rest);
  }
  if (subcommand === 'use') {
    return runWorkspaceUseCommand(rest);
  }
  if (subcommand === 'current') {
    return runWorkspaceCurrentCommand(rest);
  }

  console.error(`Unknown workspace subcommand: ${subcommand}`);
  printWorkspaceUsage();
  return 1;
}

function printPacksUsage() {
  console.log(`glitch packs <subcommand> [options]

Subcommands:
  list [options]             List packs from cloud (/v1/packs)
  show <packRef> [options]   Show summary metadata for one pack
  pull <packRef> [options]   Alias for: glitch pull <packRef> [options]`);
}

type PacksListOptions = {
  json: boolean;
  host?: string;
  source?: PacksSourceFilter;
  active: boolean;
};

type PacksListItem = {
  id: string;
  timestamp: string;
  host: string;
  source: string;
  bugType: string | null;
  url: string;
  watchedElements: number;
  totalStateChanges: number;
  duration: number | null;
  active: boolean;
};

type PacksShowOptions = {
  packRef: string;
  json: boolean;
  mode?: PromptMode;
  workspace?: string;
};

type ActiveListOptions = {
  json: boolean;
};

type ActiveAddOptions = {
  packId: string;
  json: boolean;
  keepOrder: boolean;
};

type ActiveRemoveOptions = {
  packId: string;
  json: boolean;
};

type ActiveClearOptions = {
  json: boolean;
  yes: boolean;
};

function parsePacksListArgs(args: string[]): PacksListOptions {
  const parsed: PacksListOptions = {
    json: false,
    active: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--json') {
      parsed.json = true;
      continue;
    }

    if (token === '--host') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --host');
      parsed.host = value.trim();
      i += 1;
      continue;
    }

    if (token === '--source') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --source');
      if (value !== 'snapshot' && value !== 'recorder') {
        throw new Error(`Invalid --source "${value}". Expected "snapshot" or "recorder".`);
      }
      parsed.source = value;
      i += 1;
      continue;
    }

    if (token === '--active') {
      parsed.active = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function parsePacksShowArgs(args: string[]): PacksShowOptions {
  const { workspace, extras } = parseWorkspaceFlag(args);
  const parsed: PacksShowOptions = {
    packRef: '',
    json: false,
    workspace,
  };

  for (let i = 0; i < extras.length; i += 1) {
    const token = extras[i];
    if (token === '--json') {
      parsed.json = true;
      continue;
    }

    if (token === '--mode') {
      const value = extras[i + 1];
      if (!value) throw new Error('Missing value for --mode');
      if (value !== 'slim' && value !== 'full') {
        throw new Error(`Invalid --mode "${value}". Expected "slim" or "full".`);
      }
      parsed.mode = value;
      i += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (parsed.packRef) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    parsed.packRef = token;
  }

  if (!parsed.packRef) {
    throw new Error('Missing required <packRef> argument.');
  }

  return parsed;
}

function parseListPacksPayload(payload: Record<string, unknown>): PacksListItem[] {
  const websitesRaw = payload.websites;
  if (!Array.isArray(websitesRaw)) {
    throw new Error('Unexpected /v1/packs response: missing websites array.');
  }

  const items: PacksListItem[] = [];
  websitesRaw.forEach((websiteEntry) => {
    if (!websiteEntry || typeof websiteEntry !== 'object' || Array.isArray(websiteEntry)) {
      return;
    }
    const website = websiteEntry as Record<string, unknown>;
    const host = typeof website.hostname === 'string' ? website.hostname : 'unknown';
    const packs = Array.isArray(website.packs) ? website.packs : [];

    packs.forEach((packEntry) => {
      if (!packEntry || typeof packEntry !== 'object' || Array.isArray(packEntry)) {
        return;
      }
      const pack = packEntry as Record<string, unknown>;
      const id = typeof pack.id === 'string' ? pack.id : '';
      if (!id) return;

      items.push({
        id,
        timestamp: typeof pack.timestamp === 'string' ? pack.timestamp : '',
        host,
        source: typeof pack.source === 'string' ? pack.source : 'unknown',
        bugType: typeof pack.bugType === 'string' && pack.bugType.trim() ? pack.bugType : null,
        url: typeof pack.url === 'string' ? pack.url : '',
        watchedElements: typeof pack.watchedElements === 'number' ? pack.watchedElements : 0,
        totalStateChanges: typeof pack.totalStateChanges === 'number' ? pack.totalStateChanges : 0,
        duration: typeof pack.duration === 'number' ? pack.duration : null,
        active: false,
      });
    });
  });

  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function fetchActivePackIds(cloud: CloudRuntimeContext): Promise<Set<string>> {
  const snapshot = await listActiveIssuesRequest({
    cloudUrl: cloud.cloudUrl,
    apiKey: cloud.apiKey,
  });
  const ids = new Set<string>();
  snapshot.items.forEach((item) => {
    if (item.packId.trim()) {
      ids.add(item.packId.trim());
    }
  });
  return ids;
}

function printPacksListTable(items: PacksListItem[]): void {
  if (items.length === 0) {
    console.log('No packs found.');
    return;
  }

  const rows = items.map((item) => ({
    id: item.id,
    timestamp: item.timestamp,
    host: item.host,
    source: item.source,
    bugType: item.bugType ?? '-',
    watched: String(item.watchedElements),
    changes: String(item.totalStateChanges),
    duration: item.duration === null ? '-' : `${item.duration}`,
  }));

  const idWidth = Math.max('packId'.length, ...rows.map((row) => row.id.length));
  const timeWidth = Math.max('timestamp'.length, ...rows.map((row) => row.timestamp.length));
  const hostWidth = Math.max('host'.length, ...rows.map((row) => row.host.length));
  const sourceWidth = Math.max('source'.length, ...rows.map((row) => row.source.length));
  const bugWidth = Math.max('bugType'.length, ...rows.map((row) => row.bugType.length));
  const watchedWidth = Math.max('watched'.length, ...rows.map((row) => row.watched.length));
  const changesWidth = Math.max('changes'.length, ...rows.map((row) => row.changes.length));

  console.log(
    `${'packId'.padEnd(idWidth)}  ${'timestamp'.padEnd(timeWidth)}  ${'host'.padEnd(hostWidth)}  ${'source'.padEnd(sourceWidth)}  ${'bugType'.padEnd(bugWidth)}  ${'watched'.padStart(watchedWidth)}  ${'changes'.padStart(changesWidth)}  durationMs`
  );
  rows.forEach((row) => {
    console.log(
      `${row.id.padEnd(idWidth)}  ${row.timestamp.padEnd(timeWidth)}  ${row.host.padEnd(hostWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.bugType.padEnd(bugWidth)}  ${row.watched.padStart(watchedWidth)}  ${row.changes.padStart(changesWidth)}  ${row.duration}`
    );
  });
}

function printActiveUsage() {
  console.log(`glitch active <subcommand> [options]

Subcommands:
  list [--json]                       List current Active Issues newest-first
  add <packId> [--json] [--keep-order]
                                      Add or promote a pack in Active Issues
  remove <packId> [--json]           Remove a pack from Active Issues
  clear [--yes] [--json]             Remove all packs from Active Issues`);
}

function parseActiveListArgs(args: string[]): ActiveListOptions {
  const parsed: ActiveListOptions = {
    json: false,
  };

  args.forEach((token) => {
    if (token === '--json') {
      parsed.json = true;
      return;
    }
    throw new Error(`Unknown argument for active list: ${token}`);
  });

  return parsed;
}

function parseActiveAddArgs(args: string[]): ActiveAddOptions {
  const parsed: ActiveAddOptions = {
    packId: '',
    json: false,
    keepOrder: false,
  };

  args.forEach((token) => {
    if (token === '--json') {
      parsed.json = true;
      return;
    }
    if (token === '--keep-order') {
      parsed.keepOrder = true;
      return;
    }
    if (!parsed.packId) {
      parsed.packId = token;
      return;
    }
    throw new Error(`Unknown argument for active add: ${token}`);
  });

  if (!parsed.packId) {
    throw new Error('Usage: glitch active add <packId> [--json] [--keep-order]');
  }

  return parsed;
}

function parseActiveRemoveArgs(args: string[]): ActiveRemoveOptions {
  const parsed: ActiveRemoveOptions = {
    packId: '',
    json: false,
  };

  args.forEach((token) => {
    if (token === '--json') {
      parsed.json = true;
      return;
    }
    if (!parsed.packId) {
      parsed.packId = token;
      return;
    }
    throw new Error(`Unknown argument for active remove: ${token}`);
  });

  if (!parsed.packId) {
    throw new Error('Usage: glitch active remove <packId> [--json]');
  }

  return parsed;
}

function parseActiveClearArgs(args: string[]): ActiveClearOptions {
  const parsed: ActiveClearOptions = {
    json: false,
    yes: false,
  };

  args.forEach((token) => {
    if (token === '--json') {
      parsed.json = true;
      return;
    }
    if (token === '--yes') {
      parsed.yes = true;
      return;
    }
    throw new Error(`Unknown argument for active clear: ${token}`);
  });

  return parsed;
}

function printActiveIssuesTable(items: ActiveIssueSummary[], primaryPackId: string | null): void {
  if (items.length === 0) {
    console.log('No active issues found.');
    return;
  }

  const rows = items.map((item) => ({
    primary: item.isPrimary ? 'yes' : '',
    packId: item.packId,
    source: item.source ?? '-',
    bugType: item.bugType ?? '-',
    lastPromotedAt: item.lastPromotedAt ?? '-',
    url: item.url ?? '-',
  }));

  const primaryWidth = Math.max('primary'.length, ...rows.map((row) => row.primary.length));
  const packIdWidth = Math.max('packId'.length, ...rows.map((row) => row.packId.length));
  const sourceWidth = Math.max('source'.length, ...rows.map((row) => row.source.length));
  const bugTypeWidth = Math.max('bugType'.length, ...rows.map((row) => row.bugType.length));
  const promotedWidth = Math.max('lastPromotedAt'.length, ...rows.map((row) => row.lastPromotedAt.length));

  console.log(
    `${'primary'.padEnd(primaryWidth)}  ${'packId'.padEnd(packIdWidth)}  ${'source'.padEnd(sourceWidth)}  ${'bugType'.padEnd(bugTypeWidth)}  ${'lastPromotedAt'.padEnd(promotedWidth)}  url`
  );
  rows.forEach((row) => {
    console.log(
      `${row.primary.padEnd(primaryWidth)}  ${row.packId.padEnd(packIdWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.bugType.padEnd(bugTypeWidth)}  ${row.lastPromotedAt.padEnd(promotedWidth)}  ${row.url}`
    );
  });

  if (primaryPackId) {
    console.log(`Primary alias: contextpacks://active -> ${primaryPackId}`);
  }
}

function formatActiveIssueCount(count: number): string {
  return `${count} Active Issue${count === 1 ? '' : 's'}`;
}

function loadActiveCloudContext(): CloudRuntimeContext {
  const config = loadConfig();
  return resolveCloudRuntimeContext(config, true);
}

function serializePackSummary(pack: HydratedPack): Record<string, unknown> {
  return {
    packId: pack.packId,
    origin: pack.origin,
    source: pack.source,
    mode: pack.mode ?? null,
    url: pack.url,
    timestamp: pack.timestamp,
    bugType: pack.bugType,
    watchedElements: pack.watchedElements.length,
    totalStateChanges: pack.totalStateChanges,
    interactionsCount: pack.interactionsCount,
    prompt: pack.prompt,
    summary: pack.summary,
  };
}

async function runPacksList(args: string[]): Promise<number> {
  let parsed: PacksListOptions;
  try {
    parsed = parsePacksListArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch packs list [--json] [--host <hostname>] [--source <snapshot|recorder>] [--active]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const endpoint = new URL('/v1/packs', cloud.cloudUrl).toString();
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${cloud.apiKey}`,
      },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`packs list failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
    }

    const payload = parseJsonObject(bodyText, '/v1/packs');
    let items = parseListPacksPayload(payload);

    if (parsed.active) {
      const activePackIds = await fetchActivePackIds(cloud);
      items = items
        .filter((item) => activePackIds.has(item.id))
        .map((item) => ({ ...item, active: true }));
    }

    if (parsed.host) {
      items = items.filter((item) => item.host === parsed.host);
    }
    if (parsed.source) {
      items = items.filter((item) => item.source === parsed.source);
    }

    if (parsed.json) {
      console.log(JSON.stringify({ total: items.length, items }, null, 2));
    } else {
      printPacksListTable(items);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPacksShow(args: string[]): Promise<number> {
  let parsed: PacksShowOptions;
  try {
    parsed = parsePacksShowArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch packs show <packRef> [--mode slim|full] [--workspace <name|path>] [--json]');
    return 1;
  }

  let workspaceRoot: string | null = null;
  try {
    workspaceRoot = resolveWorkspaceRoot(parsed.workspace);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, false);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const localPackDirValue =
    typeof config.local_pack_dir === 'string' && config.local_pack_dir.trim()
      ? config.local_pack_dir.trim()
      : DEFAULT_CONFIG.local_pack_dir;

  try {
    const pack = await loadPackFromReference(parsed.packRef, {
      cloudUrl: cloud.cloudUrl,
      apiKey: cloud.apiKey,
      localPackDir: localPackDirValue,
      cwd: workspaceRoot ?? process.cwd(),
      workspaceRoot,
      mode: parsed.mode,
    });

    const data = serializePackSummary(pack);
    if (parsed.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Pack ID: ${String(data.packId)}`);
      console.log(`Origin: ${String(data.origin)}`);
      console.log(`Source: ${String(data.source)}`);
      console.log(`Mode: ${String(data.mode ?? '-')}`);
      console.log(`URL: ${String(data.url)}`);
      console.log(`Timestamp: ${String(data.timestamp)}`);
      console.log(`Bug type: ${String(data.bugType ?? '-')}`);
      console.log(`Watched elements: ${String(data.watchedElements)}`);
      console.log(`State changes: ${String(data.totalStateChanges ?? '-')}`);
      console.log(`Interactions: ${String(data.interactionsCount ?? '-')}`);
      if (typeof data.prompt === 'string' && data.prompt.trim()) {
        console.log(`Prompt: ${data.prompt.trim()}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPacks(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.error('Usage: glitch packs <list|show|pull> ...');
    return 1;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printPacksUsage();
    return 0;
  }

  if (subcommand === 'list') {
    return await runPacksList(rest);
  }

  if (subcommand === 'show') {
    return await runPacksShow(rest);
  }

  if (subcommand === 'pull') {
    let workspace: string | undefined;
    let extras: string[] = [];
    try {
      const parsed = parseWorkspaceFlag(rest);
      workspace = parsed.workspace;
      extras = parsed.extras;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error('Usage: glitch packs pull <packRef> [--workspace <name|path>] [options]');
      return 1;
    }

    let workspaceRoot: string | null = null;
    if (!extras.includes('--to')) {
      try {
        workspaceRoot = resolveWorkspaceRoot(workspace);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    return await runPull(extras, {
      cwd: workspaceRoot ?? process.cwd(),
    });
  }

  console.error(`Unknown packs subcommand: ${subcommand}`);
  printPacksUsage();
  return 1;
}

function printPromptUsage() {
  console.log(`glitch prompt <subcommand> [options]

Subcommands:
  generate <packRef> [options]  Generate prompt text from a pack
  copy <packRef> [options]      Generate and copy prompt text to clipboard`);
}

function parsePromptGenerateArgs(args: string[], command: 'generate' | 'copy'): PromptGenerateOptions {
  const { workspace, extras } = parseWorkspaceFlag(args);

  const parsed: PromptGenerateOptions = {
    packRef: '',
    target: 'cursor',
    framework: 'auto',
    style: 'concise',
    includeCode: true,
    json: false,
    workspace,
  };

  for (let i = 0; i < extras.length; i += 1) {
    const token = extras[i];

    if (token === '--target') {
      const value = extras[i + 1];
      if (!value) throw new Error('Missing value for --target');
      if (!['cursor', 'claude', 'copilot', 'chatgpt'].includes(value)) {
        throw new Error(`Invalid --target "${value}". Expected cursor|claude|copilot|chatgpt.`);
      }
      parsed.target = value as PromptTargetOption;
      i += 1;
      continue;
    }

    if (token === '--framework') {
      const value = extras[i + 1];
      if (!value) throw new Error('Missing value for --framework');
      if (!['auto', 'react', 'vue', 'angular', 'svelte'].includes(value)) {
        throw new Error(`Invalid --framework "${value}". Expected auto|react|vue|angular|svelte.`);
      }
      parsed.framework = value as PromptFramework;
      i += 1;
      continue;
    }

    if (token === '--style') {
      const value = extras[i + 1];
      if (!value) throw new Error('Missing value for --style');
      if (value !== 'concise' && value !== 'detailed') {
        throw new Error(`Invalid --style "${value}". Expected concise|detailed.`);
      }
      parsed.style = value;
      i += 1;
      continue;
    }

    if (token === '--include-code') {
      parsed.includeCode = true;
      continue;
    }

    if (token === '--no-code') {
      parsed.includeCode = false;
      continue;
    }

    if (token === '--mode') {
      const value = extras[i + 1];
      if (!value) throw new Error('Missing value for --mode');
      if (value !== 'slim' && value !== 'full') {
        throw new Error(`Invalid --mode "${value}". Expected "slim" or "full".`);
      }
      parsed.mode = value;
      i += 1;
      continue;
    }

    if (token === '--json') {
      if (command === 'copy') {
        throw new Error('--json is only supported by `glitch prompt generate`.');
      }
      parsed.json = true;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (parsed.packRef) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    parsed.packRef = token;
  }

  if (!parsed.packRef) {
    throw new Error('Missing required <packRef> argument.');
  }

  return parsed;
}

async function generatePromptFromPack(options: PromptGenerateOptions): Promise<{ promptText: string; pack: HydratedPack }> {
  let workspaceRoot: string | null = null;
  try {
    workspaceRoot = resolveWorkspaceRoot(options.workspace);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const cloud = resolveCloudRuntimeContext(config, false);
  const localPackDirValue =
    typeof config.local_pack_dir === 'string' && config.local_pack_dir.trim()
      ? config.local_pack_dir.trim()
      : DEFAULT_CONFIG.local_pack_dir;

  const pack = await loadPackFromReference(options.packRef, {
    cloudUrl: cloud.cloudUrl,
    apiKey: cloud.apiKey,
    localPackDir: localPackDirValue,
    cwd: workspaceRoot ?? process.cwd(),
    workspaceRoot,
    mode: options.mode,
  });

  const promptText = generatePrompt(pack, {
    target: options.target,
    framework: options.framework,
    style: options.style,
    includeCode: options.includeCode,
  });

  return { promptText, pack };
}

async function runPromptGenerate(args: string[]): Promise<number> {
  let parsed: PromptGenerateOptions;
  try {
    parsed = parsePromptGenerateArgs(args, 'generate');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch prompt generate <packRef> [--target <cursor|claude|copilot|chatgpt>] [--framework <auto|react|vue|angular|svelte>] [--style <concise|detailed>] [--include-code|--no-code] [--mode slim|full] [--workspace <name|path>] [--json]');
    return 1;
  }

  try {
    const result = await generatePromptFromPack(parsed);
    if (parsed.json) {
      console.log(JSON.stringify({
        packId: result.pack.packId,
        origin: result.pack.origin,
        target: parsed.target,
        framework: parsed.framework,
        style: parsed.style,
        includeCode: parsed.includeCode,
        prompt: result.promptText,
      }, null, 2));
    } else {
      console.log(result.promptText);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPromptCopy(args: string[]): Promise<number> {
  let parsed: PromptCopyOptions;
  try {
    parsed = parsePromptGenerateArgs(args, 'copy') as PromptCopyOptions;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch prompt copy <packRef> [--target <cursor|claude|copilot|chatgpt>] [--framework <auto|react|vue|angular|svelte>] [--style <concise|detailed>] [--include-code|--no-code] [--mode slim|full] [--workspace <name|path>]');
    return 1;
  }

  try {
    const result = await generatePromptFromPack(parsed);
    const copied = copyToClipboard(result.promptText);
    if (copied.ok) {
      console.log(`Copied prompt to clipboard${copied.method ? ` (${copied.method})` : ''}.`);
      return 0;
    }

    console.log(result.promptText);
    console.error(`Clipboard copy failed: ${copied.error || 'unknown error'}`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPrompt(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.error('Usage: glitch prompt <generate|copy> ...');
    return 1;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printPromptUsage();
    return 0;
  }

  if (subcommand === 'generate') {
    return await runPromptGenerate(rest);
  }
  if (subcommand === 'copy') {
    return await runPromptCopy(rest);
  }

  console.error(`Unknown prompt subcommand: ${subcommand}`);
  printPromptUsage();
  return 1;
}

type LoginStartResponse = {
  handoffToken: string;
  expiresAt?: string | null;
};

async function startLoginHandoff(cloudUrl: string): Promise<LoginStartResponse> {
  const endpoint = new URL('/v1/auth/firebase/handoff/start', cloudUrl).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`login start failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
  }

  const payload = parseJsonObject(bodyText, '/v1/auth/firebase/handoff/start');
  const handoffToken = typeof payload.handoffToken === 'string' ? payload.handoffToken.trim() : '';
  if (!handoffToken) {
    throw new Error('Login start response did not include handoffToken.');
  }

  return {
    handoffToken,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}

type LoginPollResult = {
  apiKey: string | null;
  email: string | null;
  emailVerified: boolean;
};

async function pollLoginHandoff(
  cloudUrl: string,
  handoffToken: string
): Promise<LoginPollResult> {
  const pollIntervalMs = parseIntegerEnv('GLITCH_LOGIN_POLL_INTERVAL_MS', 2500);
  const maxPollMs = parseIntegerEnv('GLITCH_LOGIN_MAX_POLL_MS', 10 * 60 * 1000);
  const startedAt = Date.now();
  const endpoint = new URL('/v1/auth/firebase/handoff/poll', cloudUrl).toString();

  while (Date.now() - startedAt < maxPollMs) {
    await sleep(pollIntervalMs);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handoffToken,
        issueApiKey: true,
        label: 'cli-login',
      }),
    });

    const bodyText = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = parseJsonObject(bodyText, '/v1/auth/firebase/handoff/poll');
    } catch {
      payload = {};
    }

    if (response.ok && payload.ok === true) {
      const status = typeof payload.status === 'string' ? payload.status : '';
      if (status === 'pending') {
        continue;
      }

      if (status === 'completed') {
        const apiKeyRecord = payload.apiKey as Record<string, unknown> | undefined;
        const apiKey = typeof apiKeyRecord?.plaintext === 'string'
          ? apiKeyRecord.plaintext.trim()
          : '';
        return {
          apiKey: apiKey || null,
          email: typeof payload.email === 'string' ? payload.email : null,
          emailVerified: payload.emailVerified === true,
        };
      }

      throw new Error(`Unexpected handoff poll status: ${status || 'unknown'}`);
    }

    const code = typeof payload.code === 'string' ? payload.code : '';
    if (code === 'HANDOFF_EXPIRED' || response.status === 410) {
      throw new Error('Login handoff expired. Run `glitch login` again.');
    }
    if (code === 'HANDOFF_NOT_FOUND' || response.status === 404) {
      throw new Error('Login handoff was not found.');
    }
    if (code === 'HANDOFF_ALREADY_CONSUMED' || response.status === 409) {
      throw new Error('Login handoff was already consumed.');
    }

    throw new Error(`login poll failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
  }

  throw new Error('Login timed out while waiting for browser authentication.');
}

async function runLogin(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch login [--json]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, false);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const started = await startLoginHandoff(cloud.cloudUrl);
    const webBaseUrl = getLoginWebUrlBase();
    const signInUrl = `${webBaseUrl.replace(/\/+$/, '')}/signin?source=extension&handoffToken=${encodeURIComponent(started.handoffToken)}`;
    const opened = openUrlInBrowser(signInUrl);

    if (opened.opened) {
      console.log(`Opened browser for login (${opened.method}).`);
    } else {
      console.log(`Open this URL to continue login:\n${signInUrl}`);
      if (opened.error) {
        console.warn(`Browser auto-open failed: ${opened.error}`);
      }
    }

    console.log('Waiting for login confirmation...');
    const completed = await pollLoginHandoff(cloud.cloudUrl, started.handoffToken);
    if (!completed.apiKey) {
      if (completed.emailVerified === false) {
        console.error('Login completed, but email is not verified. Verify email, then run `glitch login` again.');
      } else {
        console.error('Login completed, but no API key was issued.');
      }
      return 1;
    }

    const next = setMissingDefaults({
      ...config,
      api_key: completed.apiKey,
    }).next;
    saveConfig(next);

    const payload = {
      ok: true,
      cloudUrl: cloud.cloudUrl,
      email: completed.email,
      emailVerified: completed.emailVerified,
      configPath: resolveConfigPath(),
      apiKeyStored: true,
    };

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Login successful. API key stored in ${resolveConfigPath()}`);
      if (completed.email) {
        console.log(`User: ${completed.email}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runLogout(args: string[]): number {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch logout [--json]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const hadApiKey = typeof config.api_key === 'string' && config.api_key.trim().length > 0;
  const next = setMissingDefaults({
    ...config,
    api_key: '',
  }).next;
  saveConfig(next);

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      hadApiKey,
      configPath: resolveConfigPath(),
    }, null, 2));
  } else if (hadApiKey) {
    console.log(`Cleared api_key in ${resolveConfigPath()}`);
  } else {
    console.log('No API key was configured.');
  }

  return 0;
}

type WhoamiOutput = {
  ok: boolean;
  apiKeyConfigured: boolean;
  cloudUrl: string;
  authMode: 'none' | 'api-key' | 'firebase-id-token';
  userId: string | null;
  email: string | null;
  plan: string | null;
  status: string | null;
  emailVerified: boolean | null;
  usage?: {
    remaining?: number;
    limit?: number;
    used?: number;
  };
};

async function runWhoami(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch whoami [--json]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, false);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  const output: WhoamiOutput = {
    ok: true,
    apiKeyConfigured: Boolean(apiKey),
    cloudUrl: cloud.cloudUrl,
    authMode: apiKey ? 'api-key' : 'none',
    userId: null,
    email: null,
    plan: null,
    status: null,
    emailVerified: null,
  };

  if (!apiKey) {
    if (json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('Not authenticated.');
      console.log('API key configured: no');
      console.log('Run `glitch login` or `glitch config set api_key <key>`.');
    }
    return 0;
  }

  const authMeEndpoint = new URL('/v1/auth/me', cloud.cloudUrl).toString();
  let shouldFallbackToUsage = false;
  try {
    const authMeResponse = await fetch(authMeEndpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const authMeBodyText = await authMeResponse.text();
    if (authMeResponse.ok) {
      const payload = parseJsonObject(authMeBodyText, '/v1/auth/me');
      const user = (payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user))
        ? payload.user as Record<string, unknown>
        : {};
      output.authMode = 'firebase-id-token';
      output.userId = typeof user.id === 'string' ? user.id : null;
      output.email = typeof user.email === 'string' ? user.email : null;
      output.plan = typeof user.plan === 'string' ? user.plan : null;
      output.status = typeof user.status === 'string' ? user.status : null;
      output.emailVerified = typeof user.emailVerified === 'boolean' ? user.emailVerified : null;
    } else {
      let payload: Record<string, unknown> = {};
      try {
        payload = parseJsonObject(authMeBodyText, '/v1/auth/me error');
      } catch {
        payload = {};
      }
      const code = typeof payload.code === 'string' ? payload.code : '';
      shouldFallbackToUsage =
        authMeResponse.status === 404 ||
        authMeResponse.status === 405 ||
        code === 'FIREBASE_ID_TOKEN_REQUIRED' ||
        code === 'INVALID_FIREBASE_ID_TOKEN' ||
        code === 'UNAUTHORIZED';
    }
  } catch {
    shouldFallbackToUsage = true;
  }

  if (shouldFallbackToUsage || output.authMode === 'api-key') {
    const usageEndpoint = new URL('/v1/usage', cloud.cloudUrl).toString();
    const usageResponse = await fetch(usageEndpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const usageBodyText = await usageResponse.text();
    if (!usageResponse.ok) {
      console.error(`whoami failed (${usageResponse.status}): ${parseHttpErrorDetail(usageBodyText, usageResponse.statusText)}`);
      return 1;
    }

    const usagePayload = parseJsonObject(usageBodyText, '/v1/usage');
    output.authMode = 'api-key';
    output.userId = typeof usagePayload.userId === 'string' ? usagePayload.userId : output.userId;
    output.plan = typeof usagePayload.plan === 'string' ? usagePayload.plan : output.plan;
    output.usage = {
      remaining: typeof usagePayload.remaining === 'number' ? usagePayload.remaining : undefined,
      limit: typeof usagePayload.limit === 'number' ? usagePayload.limit : undefined,
      used: typeof usagePayload.used === 'number' ? usagePayload.used : undefined,
    };
  }

  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Auth mode: ${output.authMode}`);
    console.log(`API key configured: ${output.apiKeyConfigured ? 'yes' : 'no'}`);
    console.log(`User ID: ${output.userId ?? 'unknown'}`);
    console.log(`Email: ${output.email ?? 'unavailable'}`);
    console.log(`Plan: ${output.plan ?? 'unknown'}`);
    console.log(`Status: ${output.status ?? 'unknown'}`);
    if (output.usage && typeof output.usage.remaining === 'number' && typeof output.usage.limit === 'number') {
      console.log(`Usage: ${output.usage.remaining}/${output.usage.limit} remaining`);
    }
  }

  return 0;
}

type KeysListOutput = {
  ok: boolean;
  keys: Array<Record<string, unknown>>;
  activeKeyId: string | null;
};

async function fetchKeysList(cloud: CloudRuntimeContext): Promise<KeysListOutput> {
  const endpoint = new URL('/v1/keys', cloud.cloudUrl).toString();
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${cloud.apiKey}`,
    },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`keys list failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
  }

  const payload = parseJsonObject(bodyText, '/v1/keys');
  const keys = Array.isArray(payload.keys) ? payload.keys.filter((row) => !!row && typeof row === 'object') as Array<Record<string, unknown>> : [];
  const activeKeyId = typeof payload.activeKeyId === 'string' ? payload.activeKeyId : null;
  return {
    ok: payload.ok === true,
    keys,
    activeKeyId,
  };
}

function printKeysTable(keys: Array<Record<string, unknown>>, activeKeyId: string | null): void {
  if (keys.length === 0) {
    console.log('No API keys found.');
    return;
  }

  const rows = keys.map((key) => {
    const id = typeof key.id === 'string' ? key.id : '';
    const keyPrefix = typeof key.keyPrefix === 'string' ? key.keyPrefix : '';
    const label = typeof key.label === 'string' ? key.label : '';
    const scopes = Array.isArray(key.scopes) ? key.scopes.filter((scope): scope is string => typeof scope === 'string').join(',') : '';
    const createdAt = typeof key.createdAt === 'string' ? key.createdAt : '';
    const lastUsedAt = typeof key.lastUsedAt === 'string' ? key.lastUsedAt : '-';
    const active = activeKeyId && id === activeKeyId ? '*' : '';
    return { active, id, keyPrefix, label, scopes, createdAt, lastUsedAt };
  });

  const activeWidth = 1;
  const idWidth = Math.max('id'.length, ...rows.map((row) => row.id.length));
  const prefixWidth = Math.max('prefix'.length, ...rows.map((row) => row.keyPrefix.length));
  const labelWidth = Math.max('label'.length, ...rows.map((row) => row.label.length));
  const scopesWidth = Math.max('scopes'.length, ...rows.map((row) => row.scopes.length));
  const createdWidth = Math.max('createdAt'.length, ...rows.map((row) => row.createdAt.length));

  console.log(
    `${' '.repeat(activeWidth)}  ${'id'.padEnd(idWidth)}  ${'prefix'.padEnd(prefixWidth)}  ${'label'.padEnd(labelWidth)}  ${'scopes'.padEnd(scopesWidth)}  ${'createdAt'.padEnd(createdWidth)}  lastUsedAt`
  );
  rows.forEach((row) => {
    console.log(
      `${row.active.padEnd(activeWidth)}  ${row.id.padEnd(idWidth)}  ${row.keyPrefix.padEnd(prefixWidth)}  ${row.label.padEnd(labelWidth)}  ${row.scopes.padEnd(scopesWidth)}  ${row.createdAt.padEnd(createdWidth)}  ${row.lastUsedAt}`
    );
  });
}

async function runKeysList(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 0) {
    console.error('Usage: glitch keys list [--json]');
    return 1;
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const listed = await fetchKeysList(cloud);
    if (json) {
      console.log(JSON.stringify(listed, null, 2));
    } else {
      printKeysTable(listed.keys, listed.activeKeyId);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runKeysCreate(args: string[]): Promise<number> {
  const { json, extras } = parseJsonFlag(args);
  if (extras.length > 1) {
    console.error('Usage: glitch keys create [label] [--json]');
    return 1;
  }

  const [label] = extras;

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const endpoint = new URL('/v1/keys', cloud.cloudUrl).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloud.apiKey}`,
      },
      body: JSON.stringify(label ? { label } : {}),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`keys create failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
    }

    const payload = parseJsonObject(bodyText, '/v1/keys');
    const key = (payload.key && typeof payload.key === 'object' && !Array.isArray(payload.key))
      ? payload.key as Record<string, unknown>
      : null;
    if (!key) {
      throw new Error('keys create response was missing key payload.');
    }

    const plaintext = typeof key.plaintext === 'string' ? key.plaintext.trim() : '';
    if (!plaintext) {
      throw new Error('keys create response did not include plaintext key.');
    }

    if (json) {
      console.log(JSON.stringify({ ok: true, key }, null, 2));
    } else {
      console.log(`Created key: ${String(key.id ?? '')}`);
      console.log(`Label: ${String(key.label ?? '')}`);
      console.log(`Prefix: ${String(key.keyPrefix ?? '')}`);
      console.log(`Plaintext: ${plaintext}`);
      console.log('This plaintext key is shown once. Store it now.');
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseYesFlag(args: string[]): { yes: boolean; extras: string[] } {
  const yes = args.includes('--yes');
  const extras = args.filter((token) => token !== '--yes');
  return { yes, extras };
}

async function runKeysRevoke(args: string[]): Promise<number> {
  const { yes, extras } = parseYesFlag(args);
  const [keyId] = extras;
  if (!keyId || extras.length !== 1) {
    console.error('Usage: glitch keys revoke <keyId> [--yes]');
    return 1;
  }

  if (!yes) {
    const confirmed = await confirmPrompt(`Revoke key "${keyId}"?`);
    if (!confirmed) {
      console.error('Cancelled.');
      return 1;
    }
  }

  let config: ConfigRecord = {};
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let cloud: CloudRuntimeContext;
  try {
    cloud = resolveCloudRuntimeContext(config, true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let revokingActiveKey = false;
  try {
    const listed = await fetchKeysList(cloud);
    revokingActiveKey = listed.activeKeyId === keyId;
  } catch {
    revokingActiveKey = false;
  }

  try {
    const endpoint = new URL(`/v1/keys/${encodeURIComponent(keyId)}`, cloud.cloudUrl).toString();
    const response = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${cloud.apiKey}`,
      },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`keys revoke failed (${response.status}): ${parseHttpErrorDetail(bodyText, response.statusText)}`);
    }

    if (revokingActiveKey) {
      const next = setMissingDefaults({
        ...config,
        api_key: '',
      }).next;
      saveConfig(next);
      console.log(`Revoked key "${keyId}" and cleared local api_key.`);
    } else {
      console.log(`Revoked key "${keyId}".`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printKeysUsage() {
  console.log(`glitch keys <subcommand> [options]

Subcommands:
  list [--json]                 List API keys
  create [label] [--json]       Create a new API key
  revoke <keyId> [--yes]        Revoke an API key`);
}

async function runKeys(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.error('Usage: glitch keys <list|create|revoke> ...');
    return 1;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printKeysUsage();
    return 0;
  }

  if (subcommand === 'list') {
    return await runKeysList(rest);
  }
  if (subcommand === 'create') {
    return await runKeysCreate(rest);
  }
  if (subcommand === 'revoke') {
    return await runKeysRevoke(rest);
  }

  console.error(`Unknown keys subcommand: ${subcommand}`);
  printKeysUsage();
  return 1;
}

async function runActiveList(args: string[]): Promise<number> {
  let parsed: ActiveListOptions;
  try {
    parsed = parseActiveListArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch active list [--json]');
    return 1;
  }

  try {
    const cloud = loadActiveCloudContext();
    const result = await listActiveIssuesRequest({
      cloudUrl: cloud.cloudUrl,
      apiKey: cloud.apiKey,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printActiveIssuesTable(result.items, result.primaryPackId);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runActiveAdd(args: string[]): Promise<number> {
  let parsed: ActiveAddOptions;
  try {
    parsed = parseActiveAddArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch active add <packId> [--json] [--keep-order]');
    return 1;
  }

  try {
    const cloud = loadActiveCloudContext();
    const result = await addActiveIssueRequest({
      packId: parsed.packId,
      cloudUrl: cloud.cloudUrl,
      apiKey: cloud.apiKey,
      mode: parsed.keepOrder ? 'keep-order' : 'promote',
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (result.added) {
      console.log(`Added "${result.packId}" to Active Issues.`);
    } else if (result.promoted) {
      console.log(`Promoted "${result.packId}" to the primary Active Issue.`);
    } else {
      console.log(`"${result.packId}" is already in Active Issues.`);
    }

    if (result.primaryPackId) {
      console.log(`Primary active pack: ${result.primaryPackId}`);
      console.log('Resource URI: contextpacks://active');
    }
    console.log(`Total: ${formatActiveIssueCount(result.total)}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runActiveRemove(args: string[]): Promise<number> {
  let parsed: ActiveRemoveOptions;
  try {
    parsed = parseActiveRemoveArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch active remove <packId> [--json]');
    return 1;
  }

  try {
    const cloud = loadActiveCloudContext();
    const result = await removeActiveIssueRequest({
      packId: parsed.packId,
      cloudUrl: cloud.cloudUrl,
      apiKey: cloud.apiKey,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    console.log(`Removed "${result.removedPackId}" from Active Issues.`);
    if (result.primaryPackId) {
      console.log(`Primary active pack: ${result.primaryPackId}`);
      console.log('Resource URI: contextpacks://active');
    } else {
      console.log('No active issues remain.');
    }
    console.log(`Total: ${formatActiveIssueCount(result.total)}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runActiveClear(args: string[]): Promise<number> {
  let parsed: ActiveClearOptions;
  try {
    parsed = parseActiveClearArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch active clear [--yes] [--json]');
    return 1;
  }

  if (!parsed.yes) {
    const confirmed = await confirmPrompt('Clear all Active Issues?');
    if (!confirmed) {
      console.error('Cancelled.');
      return 1;
    }
  }

  try {
    const cloud = loadActiveCloudContext();
    const result = await clearActiveIssuesRequest({
      cloudUrl: cloud.cloudUrl,
      apiKey: cloud.apiKey,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    console.log(`Cleared ${formatActiveIssueCount(result.cleared)}.`);
    console.log('No active issues remain.');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runActive(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.error('Usage: glitch active <list|add|remove|clear> ...');
    return 1;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printActiveUsage();
    return 0;
  }

  if (subcommand === 'list') {
    return await runActiveList(rest);
  }
  if (subcommand === 'add') {
    return await runActiveAdd(rest);
  }
  if (subcommand === 'remove') {
    return await runActiveRemove(rest);
  }
  if (subcommand === 'clear') {
    return await runActiveClear(rest);
  }

  console.error(`Unknown active subcommand: ${subcommand}`);
  printActiveUsage();
  return 1;
}

async function runCaptureShortcut(
  commandName: 'snapshot' | 'record',
  mode: 'snapshot' | 'recorder',
  args: string[]
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    return await runCaptureCli(['--help']);
  }

  const [url, ...rest] = args;
  if (!url || url.startsWith('--')) {
    console.error(`Missing required <url> argument for "${commandName}".`);
    console.error(`Usage: glitch ${commandName} <url> [options]`);
    return 1;
  }

  return await runCaptureCli(['--url', url, ...rest, '--mode', mode]);
}

function buildCommandLookup(commands: CliCommand[]): Map<string, CliCommand> {
  const lookup = new Map<string, CliCommand>();
  for (const command of commands) {
    const keys = [command.name, ...(command.aliases ?? [])];
    keys.forEach((key) => {
      if (lookup.has(key)) {
        throw new Error(`Duplicate command key in registry: ${key}`);
      }
      lookup.set(key, command);
    });
  }
  return lookup;
}

function getCommandHelpRows(): Array<{ label: string; summary: string }> {
  return COMMAND_REGISTRY.map((command) => ({
    label: command.usage,
    summary: command.summary,
  }));
}

const COMMAND_REGISTRY: CliCommand[] = [
  {
    name: 'snapshot',
    usage: 'snapshot <url> [options]',
    summary: 'Capture snapshot shorthand (capture --mode snapshot)',
    run: async (args) => await runCaptureShortcut('snapshot', 'snapshot', args),
  },
  {
    name: 'record',
    usage: 'record <url> [options]',
    summary: 'Capture recorder shorthand (capture --mode recorder)',
    run: async (args) => await runCaptureShortcut('record', 'recorder', args),
  },
  {
    name: 'capture',
    usage: 'capture [url] [options]',
    summary: 'Run capture workflow (snapshot/recorder)',
    run: async (args) => await runCaptureCli(args),
  },
  {
    name: 'packs',
    usage: 'packs <subcommand> [options]',
    summary: 'List/show/pull packs',
    run: async (args) => await runPacks(args),
  },
  {
    name: 'active',
    usage: 'active <subcommand> [options]',
    summary: 'Manage Active Issues (list|add|remove|clear)',
    run: async (args) => await runActive(args),
  },
  {
    name: 'prompt',
    usage: 'prompt <subcommand> [options]',
    summary: 'Generate/copy AI prompts from packs',
    run: async (args) => await runPrompt(args),
  },
  {
    name: 'pull',
    usage: 'pull <packId> [options]',
    summary: 'Download a cloud pack bundle and unpack locally',
    run: async (args) => await runPull(args),
  },
  {
    name: 'workspace',
    usage: 'workspace <subcommand> [options]',
    summary: 'Manage workspaces (init|add|list|use|current)',
    run: async (args) => await runWorkspace(args),
  },
  {
    name: 'init',
    usage: 'init [--project [path]]',
    summary: 'Init global config or .glitch/project.json',
    run: (args) => runInit(args),
  },
  {
    name: 'config',
    usage: 'config <subcommand> [options]',
    summary: 'Manage config values (set|get|list)',
    run: (args) => runConfig(args),
  },
  {
    name: 'login',
    usage: 'login [--json]',
    summary: 'Sign in via browser handoff and store api_key',
    run: async (args) => await runLogin(args),
  },
  {
    name: 'logout',
    usage: 'logout [--json]',
    summary: 'Clear stored api_key',
    run: (args) => runLogout(args),
  },
  {
    name: 'whoami',
    usage: 'whoami [--json]',
    summary: 'Show current account/auth info',
    run: async (args) => await runWhoami(args),
  },
  {
    name: 'keys',
    usage: 'keys <subcommand> [options]',
    summary: 'Manage API keys (list|create|revoke)',
    run: async (args) => await runKeys(args),
  },
  {
    name: 'connect',
    usage: 'connect <target> [options]',
    summary: 'Write MCP config for cursor|claude|windsurf',
    run: async (args) => await runConnect(args),
  },
  {
    name: 'doctor',
    usage: 'doctor [--json]',
    summary: 'Run local/cloud diagnostics',
    run: async (args) => await runDoctor(args),
  },
  {
    name: 'status',
    usage: 'status [--json]',
    summary: 'Show cloud/auth status',
    run: async (args) => await runStatus(args),
  },
  {
    name: 'help',
    aliases: ['--help', '-h'],
    usage: 'help',
    summary: 'Show this message',
    run: () => {
      printUsage();
      return 0;
    },
  },
];

const COMMAND_LOOKUP = buildCommandLookup(COMMAND_REGISTRY);

export async function runGlitchCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [commandToken, ...rest] = argv;

  if (!commandToken) {
    printUsage();
    return 0;
  }

  const command = COMMAND_LOOKUP.get(commandToken);
  if (!command) {
    console.error(`Unknown command: ${commandToken}`);
    printUsage();
    return 1;
  }

  try {
    return await command.run(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isExecutedAsCliEntry(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const entryPath = realpathSync(resolve(entryArg));
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    return entryPath === selfPath;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entryArg)).href;
  }
}

if (isExecutedAsCliEntry()) {
  const exitCode = await runGlitchCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
