import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { parseAndVerifyBundlePayload, type PullBundleMode, type VerifiedPullBundle } from '../bundle';
import type { PromptPackInput, PromptWatchedElement } from '../../src/lib/prompt/generator';

type PackOrigin = 'local-directory' | 'local-bundle' | 'cloud-bundle';

export type HydratedPack = PromptPackInput & {
  origin: PackOrigin;
  reference: string;
  mode?: PullBundleMode;
  manifest: Record<string, unknown>;
};

export type PackLoaderOptions = {
  cloudUrl: string;
  apiKey: string;
  localPackDir: string;
  cwd?: string;
  workspaceRoot?: string | null;
  mode?: PullBundleMode;
  fetchImpl?: typeof fetch;
};

type ProjectConfig = {
  contextPacksDir?: string;
};

type DirectoryPackManifest = {
  id?: string;
  source?: string;
  bugType?: string;
  url?: string;
  timestamp?: string;
  watchedElements?: Array<{
    id?: string;
    selector?: string;
    dir?: string;
    targetRefId?: string;
  }>;
  stats?: {
    totalStateChanges?: number;
  };
};

const PACK_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export async function loadPackFromReference(
  packRefRaw: string,
  options: PackLoaderOptions
): Promise<HydratedPack> {
  const packRef = packRefRaw.trim();
  if (!packRef) {
    throw new Error('Pack reference cannot be empty.');
  }

  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  if (looksLikePath(packRef)) {
    const explicitPath = resolvePathLike(packRef, cwd);
    if (!existsSync(explicitPath)) {
      throw new Error(`Pack path not found: ${explicitPath}`);
    }
    return loadFromExplicitPath(explicitPath, packRef, options.mode);
  }

  const packId = validatePackId(packRef);
  const local = resolveLocalPackForId(packId, {
    workspaceRoot: options.workspaceRoot ?? null,
    cwd,
    localPackDir: options.localPackDir,
  });
  if (local) {
    return local.kind === 'directory'
      ? loadDirectoryPack(local.path, 'local-directory', packRef)
      : loadBundleFile(local.path, 'local-bundle', packRef);
  }

  return await loadCloudBundle(packId, options);
}

function loadFromExplicitPath(pathLike: string, reference: string, mode?: PullBundleMode): HydratedPack {
  const stat = statSync(pathLike);
  if (stat.isDirectory()) {
    return loadDirectoryPack(pathLike, 'local-directory', reference);
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported pack reference path: ${pathLike}`);
  }

  const loaded = loadBundleFile(pathLike, 'local-bundle', reference);
  if (mode && loaded.mode && loaded.mode !== mode) {
    throw new Error(`Bundle mode mismatch. Requested "${mode}" but file contains "${loaded.mode}".`);
  }
  return loaded;
}

function loadDirectoryPack(directoryPath: string, origin: PackOrigin, reference: string): HydratedPack {
  const manifestPath = resolve(directoryPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Directory pack missing manifest.json: ${directoryPath}`);
  }

  const manifest = readJsonFile(manifestPath, 'manifest.json') as DirectoryPackManifest;
  const packId = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : basename(directoryPath);
  const source = typeof manifest.source === 'string' && manifest.source.trim() ? manifest.source.trim() : 'snapshot';
  const bugType = typeof manifest.bugType === 'string' && manifest.bugType.trim() ? manifest.bugType.trim() : null;
  const url = typeof manifest.url === 'string' ? manifest.url : '';
  const timestamp = typeof manifest.timestamp === 'string' ? manifest.timestamp : '';
  const promptPath = resolve(directoryPath, 'prompt.md');
  const summaryPath = resolve(directoryPath, 'summary.json');
  const interactionsPath = resolve(directoryPath, 'interactions.json');

  const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';
  const summary = existsSync(summaryPath)
    ? asObject(readJsonFile(summaryPath, 'summary.json'), 'summary.json')
    : {};
  const interactionsCount = existsSync(interactionsPath)
    ? readArrayFileLength(interactionsPath, 'interactions.json')
    : null;

  const watchedEntries = Array.isArray(manifest.watchedElements) ? manifest.watchedElements : [];
  const watchedElements: PromptWatchedElement[] = [];
  watchedEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const selector = typeof entry.selector === 'string' ? entry.selector : '';
    const id = typeof entry.id === 'string' ? entry.id : `el_${index}`;
    const dir = typeof entry.dir === 'string' ? entry.dir : '';
    if (!selector || !dir) return;

    const elementPath = resolve(directoryPath, dir);
    const corePath = resolve(elementPath, 'core.json');
    const fullStylesPath = resolve(elementPath, 'full-styles.json');
    const core = existsSync(corePath) ? asObject(readJsonFile(corePath, `${dir}/core.json`), `${dir}/core.json`) : undefined;
    const fullStyles = existsSync(fullStylesPath)
      ? asObject(readJsonFile(fullStylesPath, `${dir}/full-styles.json`), `${dir}/full-styles.json`)
      : undefined;

    watchedElements.push({
      id,
      selector,
      targetRefId: typeof entry.targetRefId === 'string' ? entry.targetRefId : undefined,
      core,
      fullStyles,
    });
  });

  const totalStateChanges = Number.isFinite(manifest.stats?.totalStateChanges)
    ? Number(manifest.stats?.totalStateChanges)
    : null;

  return {
    origin,
    reference,
    packId,
    source,
    bugType,
    url,
    timestamp,
    prompt,
    summary,
    watchedElements,
    totalStateChanges,
    interactionsCount,
    manifest: asObject(manifest as unknown, 'manifest.json'),
  };
}

function loadBundleFile(filePath: string, origin: PackOrigin, reference: string): HydratedPack {
  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Bundle JSON parse failed (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
  }

  let bundle: VerifiedPullBundle;
  try {
    bundle = parseAndVerifyBundlePayload(parsed);
  } catch (error) {
    throw new Error(`Invalid bundle payload (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
  }

  return hydrateFromBundle(bundle, origin, reference);
}

async function loadCloudBundle(packId: string, options: PackLoaderOptions): Promise<HydratedPack> {
  const token = options.apiKey.trim();
  if (!token) {
    throw new Error('No bearer token available. Set `api_key` via `glitch config set api_key <key>`.');
  }

  const endpoint = new URL(`/v1/packs/${encodeURIComponent(packId)}/bundle`, options.cloudUrl);
  if (options.mode) {
    endpoint.searchParams.set('mode', options.mode);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Pack fetch failed (${response.status}): ${extractErrorDetail(bodyText, response.statusText)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Bundle response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const bundle = parseAndVerifyBundlePayload(parsed);
  if (options.mode && bundle.mode !== options.mode) {
    throw new Error(`Bundle mode mismatch. Requested "${options.mode}" but server returned "${bundle.mode}".`);
  }

  return hydrateFromBundle(bundle, 'cloud-bundle', packId);
}

function hydrateFromBundle(bundle: VerifiedPullBundle, origin: PackOrigin, reference: string): HydratedPack {
  const fileMap = new Map<string, string>();
  bundle.files.forEach((file) => {
    fileMap.set(file.path, file.decodedBytes.toString('utf8'));
  });

  const manifestFromFile = parseOptionalObjectFile(fileMap.get('manifest.json'), 'manifest.json');
  const summaryFromFile = parseOptionalObjectFile(fileMap.get('summary.json'), 'summary.json');
  const interactions = parseOptionalArrayFile(fileMap.get('interactions.json'), 'interactions.json');
  const manifest = asObject(
    manifestFromFile ?? (bundle.manifest as Record<string, unknown>),
    'bundle.manifest'
  ) as DirectoryPackManifest;
  const summary = asObject(
    summaryFromFile ?? (bundle.summary as Record<string, unknown>),
    'bundle.summary'
  );
  const packId = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : bundle.packId;
  const source = typeof manifest.source === 'string' && manifest.source.trim() ? manifest.source.trim() : 'snapshot';
  const bugType = typeof manifest.bugType === 'string' && manifest.bugType.trim() ? manifest.bugType.trim() : null;
  const url = typeof manifest.url === 'string' ? manifest.url : '';
  const timestamp = typeof manifest.timestamp === 'string' ? manifest.timestamp : bundle.createdAt;
  const prompt = (fileMap.get('prompt.md') ?? '').trimEnd();

  const watchedEntries = Array.isArray(manifest.watchedElements) ? manifest.watchedElements : [];
  const watchedElements: PromptWatchedElement[] = [];
  watchedEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const selector = typeof entry.selector === 'string' ? entry.selector : '';
    const id = typeof entry.id === 'string' ? entry.id : `el_${index}`;
    const dir = typeof entry.dir === 'string' ? entry.dir : '';
    if (!selector || !dir) return;

    const core = parseOptionalObjectFile(fileMap.get(`${dir}/core.json`), `${dir}/core.json`);
    const fullStyles = parseOptionalObjectFile(fileMap.get(`${dir}/full-styles.json`), `${dir}/full-styles.json`);

    watchedElements.push({
      id,
      selector,
      targetRefId: typeof entry.targetRefId === 'string' ? entry.targetRefId : undefined,
      core: core ?? undefined,
      fullStyles: fullStyles ?? undefined,
    });
  });

  const totalStateChanges = Number.isFinite(manifest.stats?.totalStateChanges)
    ? Number(manifest.stats?.totalStateChanges)
    : null;

  return {
    origin,
    reference,
    packId,
    source,
    bugType,
    url,
    timestamp,
    mode: bundle.mode,
    prompt,
    summary,
    watchedElements,
    totalStateChanges,
    interactionsCount: interactions ? interactions.length : null,
    manifest: asObject(manifest as unknown, 'manifest'),
  };
}

function parseOptionalObjectFile(raw: string | undefined, label: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseJson(raw, label);
  return asObject(parsed, label);
}

function parseOptionalArrayFile(raw: string | undefined, label: string): unknown[] | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseJson(raw, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON array.`);
  }
  return parsed;
}

function readArrayFileLength(filePath: string, label: string): number {
  const parsed = readJsonFile(filePath, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON array.`);
  }
  return parsed.length;
}

function readJsonFile(filePath: string, label: string): unknown {
  const raw = readFileSync(filePath, 'utf8');
  return parseJson(raw, label);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function extractErrorDetail(body: string, fallback: string): string {
  const trimmed = body.trim();
  if (!trimmed) return fallback || 'Request failed';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // fall through
  }
  return trimmed;
}

function validatePackId(value: string): string {
  if (!PACK_ID_RE.test(value)) {
    throw new Error(`Invalid pack reference: ${value}`);
  }
  return value;
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value === '~' ||
    value.startsWith('/') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.endsWith('.json')
  );
}

function resolvePathLike(pathLike: string, cwd: string): string {
  const expanded = expandHomePath(pathLike);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(cwd, expanded);
}

function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

function resolveLocalPackForId(
  packId: string,
  options: { workspaceRoot: string | null; cwd: string; localPackDir: string }
): { kind: 'directory' | 'bundle'; path: string } | null {
  const searchRoots = collectSearchRoots(options);
  for (const root of searchRoots) {
    const dirCandidate = resolve(root, packId);
    if (existsSync(resolve(dirCandidate, 'manifest.json'))) {
      return { kind: 'directory', path: dirCandidate };
    }

    const bundleCandidate = resolve(root, `glitchpack_${packId}.json`);
    if (existsSync(bundleCandidate)) {
      return { kind: 'bundle', path: bundleCandidate };
    }
  }
  return null;
}

function collectSearchRoots(options: { workspaceRoot: string | null; cwd: string; localPackDir: string }): string[] {
  const roots: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = resolve(value);
    if (!roots.includes(normalized)) {
      roots.push(normalized);
    }
  };

  if (options.workspaceRoot) {
    add(resolveContextPacksRoot(options.workspaceRoot));
  }

  const nearest = findNearestProjectRoot(options.cwd);
  if (nearest) {
    add(resolveContextPacksRoot(nearest));
  }

  add(resolvePathLike(options.localPackDir, options.cwd));
  return roots;
}

function resolveContextPacksRoot(projectRoot: string): string {
  const configPath = resolve(projectRoot, '.glitch', 'project.json');
  if (!existsSync(configPath)) {
    return resolve(projectRoot, 'context-packs');
  }

  let config: ProjectConfig = {};
  try {
    const parsed = parseJson(readFileSync(configPath, 'utf8'), configPath);
    const row = asObject(parsed, configPath);
    if (typeof row.contextPacksDir === 'string' && row.contextPacksDir.trim()) {
      config.contextPacksDir = row.contextPacksDir.trim();
    }
  } catch {
    // Fall back to default root if config parsing fails.
  }

  const contextDir = config.contextPacksDir || './context-packs';
  const expanded = expandHomePath(contextDir);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(projectRoot, expanded);
}

function findNearestProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const projectConfigPath = resolve(current, '.glitch', 'project.json');
    if (existsSync(projectConfigPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
