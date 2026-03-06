import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import type { PullBundleMode, VerifiedPullBundle } from './bundle';
import { parseAndVerifyBundlePayload } from './bundle';

type PullBundleFormat = 'dir' | 'bundle';
type PullParsedArgs = {
  packId: string;
  mode?: PullBundleMode;
  format?: PullBundleFormat;
  to?: string;
  token?: string;
  help: boolean;
};

type PullCommandContext = {
  cloudUrl: string;
  apiKey: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
};

type ProjectConfig = {
  contextPacksDir?: string;
  defaultBundleMode?: PullBundleMode;
  defaultFormat?: PullBundleFormat;
};
type NearestProjectConfig = {
  projectRoot: string;
  config: ProjectConfig;
};

const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const DEFAULT_TO_DIR = './context-packs';
const DEFAULT_MODE: PullBundleMode = 'slim';
const DEFAULT_FORMAT: PullBundleFormat = 'dir';

export async function runPullCommand(args: string[], context: PullCommandContext): Promise<number> {
  let parsed: PullParsedArgs;
  try {
    parsed = parsePullArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: glitch pull <packId> [--to <dir>] [--mode slim|full] [--format dir|bundle] [--token <bearer>]');
    return 1;
  }

  if (parsed.help) {
    printPullUsage();
    return 0;
  }

  const authToken = parsed.token?.trim() || context.apiKey.trim();
  if (!authToken) {
    console.error('No bearer token available. Set `api_key` via `glitch config set api_key <key>` or pass `--token <bearer>`.');
    return 1;
  }

  const cwd = context.cwd ? resolve(context.cwd) : process.cwd();
  let nearestProjectConfig: NearestProjectConfig | null = null;
  let projectConfig: ProjectConfig | null = null;
  let toDirRaw: string;
  let outputBaseDir = cwd;
  try {
    nearestProjectConfig = readNearestProjectConfig(cwd);
    projectConfig = nearestProjectConfig?.config ?? null;

    if (parsed.to?.trim()) {
      toDirRaw = parsed.to.trim();
    } else if (projectConfig?.contextPacksDir) {
      toDirRaw = projectConfig.contextPacksDir;
      outputBaseDir = nearestProjectConfig?.projectRoot ?? cwd;
    } else {
      toDirRaw = DEFAULT_TO_DIR;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const mode = parsed.mode ?? projectConfig?.defaultBundleMode ?? DEFAULT_MODE;
  const format = parsed.format ?? projectConfig?.defaultFormat ?? DEFAULT_FORMAT;
  const outputRoot = resolveOutputDirectory(toDirRaw, outputBaseDir);

  let responseText: string;
  let bundle: VerifiedPullBundle;
  try {
    const endpoint = new URL(`/v1/packs/${encodeURIComponent(parsed.packId)}/bundle`, context.cloudUrl);
    endpoint.searchParams.set('mode', mode);

    const fetchImpl = context.fetchImpl ?? fetch;
    const response = await fetchImpl(endpoint.toString(), {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    responseText = await response.text();
    if (!response.ok) {
      throw new Error(formatPullHttpError(response.status, response.statusText, responseText));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`Bundle response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    bundle = parseAndVerifyBundlePayload(payload);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (bundle.packId !== parsed.packId) {
    console.error(`Bundle packId mismatch. Requested "${parsed.packId}" but server returned "${bundle.packId}".`);
    return 1;
  }

  if (bundle.mode !== mode) {
    console.error(`Bundle mode mismatch. Requested "${mode}" but server returned "${bundle.mode}".`);
    return 1;
  }

  try {
    if (format === 'bundle') {
      const targetFile = writeBundleArtifact(bundle.packId, outputRoot, responseText);
      console.log(`Pulled bundle: ${targetFile}`);
      return 0;
    }

    const targetDir = unpackBundleToDirectory(bundle, outputRoot);
    console.log(`Pulled pack: ${targetDir}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printPullUsage() {
  console.log(`glitch pull <packId> [options]

Options:
  --to <dir>               Output directory root (default: project config or ./context-packs)
  --mode <slim|full>       Bundle mode (default: project config or slim)
  --format <dir|bundle>    Write unpacked directory or raw bundle JSON (default: project config or dir)
  --token <bearer>         Override auth token (defaults to config api_key)
  --help                   Show this message`);
}

function parsePullArgs(argv: string[]): PullParsedArgs {
  const args: PullParsedArgs = {
    packId: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--to') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --to');
      args.to = value;
      i += 1;
      continue;
    }

    if (token === '--mode') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --mode');
      if (value !== 'slim' && value !== 'full') {
        throw new Error(`Invalid --mode "${value}". Expected "slim" or "full".`);
      }
      args.mode = value;
      i += 1;
      continue;
    }

    if (token === '--format') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --format');
      if (value !== 'dir' && value !== 'bundle') {
        throw new Error(`Invalid --format "${value}". Expected "dir" or "bundle".`);
      }
      args.format = value;
      i += 1;
      continue;
    }

    if (token === '--token') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --token');
      args.token = value;
      i += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (args.packId) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    args.packId = validatePackIdToken(token);
  }

  if (!args.help && !args.packId) {
    throw new Error('Missing required <packId> argument.');
  }

  return args;
}

function validatePackIdToken(packIdRaw: string): string {
  const packId = packIdRaw.trim();
  if (!packId) {
    throw new Error('Pack id cannot be empty.');
  }
  if (packId === '.' || packId === '..' || packId.includes('/') || packId.includes('\\') || /^[a-zA-Z]:/.test(packId)) {
    throw new Error(`Invalid pack id: ${packIdRaw}`);
  }
  return packId;
}

function readNearestProjectConfig(cwd: string): NearestProjectConfig | null {
  const resolved = findNearestProjectConfigPath(cwd);
  if (!resolved) return null;
  const { configPath: projectConfigPath, projectRoot } = resolved;

  try {
    const raw = readFileSync(projectConfigPath, 'utf8').trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('.glitch/project.json must contain a JSON object.');
    }

    const config: ProjectConfig = {};
    if (typeof parsed.contextPacksDir !== 'undefined') {
      if (typeof parsed.contextPacksDir !== 'string' || !parsed.contextPacksDir.trim()) {
        throw new Error('contextPacksDir must be a non-empty string when provided.');
      }
      config.contextPacksDir = parsed.contextPacksDir.trim();
    }

    if (typeof parsed.defaultBundleMode !== 'undefined') {
      if (parsed.defaultBundleMode !== 'slim' && parsed.defaultBundleMode !== 'full') {
        throw new Error('defaultBundleMode must be "slim" or "full" when provided.');
      }
      config.defaultBundleMode = parsed.defaultBundleMode;
    }

    if (typeof parsed.defaultFormat !== 'undefined') {
      if (parsed.defaultFormat !== 'dir' && parsed.defaultFormat !== 'bundle') {
        throw new Error('defaultFormat must be "dir" or "bundle" when provided.');
      }
      config.defaultFormat = parsed.defaultFormat;
    }

    return { projectRoot, config };
  } catch (error) {
    throw new Error(
      `Invalid project config at ${projectConfigPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function findNearestProjectConfigPath(startDir: string): { configPath: string; projectRoot: string } | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = resolve(current, '.glitch', 'project.json');
    if (existsSync(candidate)) {
      return { configPath: candidate, projectRoot: current };
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveOutputDirectory(pathLike: string, cwd: string): string {
  const expanded = expandHomePath(pathLike);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(cwd, expanded);
}

function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

function unpackBundleToDirectory(bundle: VerifiedPullBundle, rootDir: string): string {
  const safePackId = validatePackIdToken(bundle.packId);
  mkdirSync(rootDir, { recursive: true, mode: SECURE_DIR_MODE });
  hardenDirMode(rootDir);

  const packRoot = resolve(rootDir, safePackId);
  mkdirSync(packRoot, { recursive: true, mode: SECURE_DIR_MODE });
  hardenDirMode(packRoot);

  for (const file of bundle.files) {
    const outputPath = resolve(packRoot, file.path);
    assertPathWithinRoot(packRoot, outputPath, `Invalid output path: ${file.path}`);
    mkdirSync(dirname(outputPath), { recursive: true, mode: SECURE_DIR_MODE });
    writeFileSync(outputPath, file.decodedBytes, { mode: SECURE_FILE_MODE });
    hardenFileMode(outputPath);
  }

  return packRoot;
}

function writeBundleArtifact(packId: string, rootDir: string, payloadText: string): string {
  const safePackId = validatePackIdToken(packId);
  mkdirSync(rootDir, { recursive: true, mode: SECURE_DIR_MODE });
  hardenDirMode(rootDir);

  const filename = `glitchpack_${safePackId}.json`;
  const outputPath = resolve(rootDir, filename);
  assertPathWithinRoot(rootDir, outputPath, `Invalid output path: ${filename}`);

  const outputText = payloadText.endsWith('\n') ? payloadText : `${payloadText}\n`;
  writeFileSync(outputPath, outputText, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  hardenFileMode(outputPath);
  return outputPath;
}

function formatPullHttpError(status: number, statusText: string, bodyText: string): string {
  let detail = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      detail = parsed.error.trim();
    } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
      detail = parsed.message.trim();
    }
  } catch {
    // Keep raw text detail.
  }

  if (!detail) {
    detail = statusText || 'Request failed';
  }
  return `Pull failed (${status}): ${detail}`;
}

function assertPathWithinRoot(root: string, candidate: string, errorMessage: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;

  if (!normalizedCandidate.startsWith(rootWithSep) && normalizedCandidate !== normalizedRoot) {
    throw new Error(errorMessage);
  }

  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(errorMessage);
  }
}

function hardenDirMode(dirPath: string): void {
  try {
    chmodSync(dirPath, SECURE_DIR_MODE);
  } catch {
    // Ignore unsupported chmod environments.
  }
}

function hardenFileMode(filePath: string): void {
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // Ignore unsupported chmod environments.
  }
}
