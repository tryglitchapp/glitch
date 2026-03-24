import type { Browser } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { buildDirectoryPack, getPackFiles } from '../src/lib/context-pack/directory-pack-builder';
import type { BugType } from '../src/lib/context-pack/pack-types';
import type { ElementState, RecordingResult } from '../src/lib/context-pack/pack-types';
import {
  formatUploadValidationErrors,
  type UploadValidationIssue,
  validateUploadRequestPayload,
} from '../src/lib/context-pack/upload-schema';
import { redactUploadPayload } from '../src/lib/security/redact-pack';
import {
  activateUploadedPack,
  decidePostUploadActivation,
  resolveCaptureActivationPreference,
} from './active-issues';
import { confirmYesNo, isInteractiveSession, type ConfirmFn } from './confirm';

const DEFAULT_CONFIG_PATH = process.env.GLITCH_CONFIG_PATH?.trim() || '~/.glitch/config.json';
const DEFAULT_LOCAL_PACK_DIR = '~/.glitch/context-packs';
const DEFAULT_CLOUD_URL = 'https://mcp-server-production-b57a.up.railway.app';
const DEFAULT_NAV_SETTLE_MS = 350;
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const CAPTURE_URL_PROTOCOLS = new Set(['http:', 'https:']);
const PROMPT_ALIAS_RE = /^[A-Za-z0-9_-]+$/;

type Destination = 'local' | 'cloud';
type CaptureMode = 'snapshot' | 'recorder';
type NavigationWaitMode = 'domcontentloaded' | 'load' | 'networkidle';

interface CliArgs {
  url: string;
  mode: CaptureMode;
  bugType?: BugType;
  selectors: string[];
  multi: boolean;
  headless: boolean;
  cloud: boolean;
  local: boolean;
  out?: string;
  screenshot?: string;
  wait: NavigationWaitMode;
  noClose: boolean;
  prompt?: string;
  promptTagBindings: PromptTagBinding[];
  promptPickAliases: string[];
  activate: boolean;
  noActivate: boolean;
  help: boolean;
}

interface CliConfig {
  default_destination?: Destination;
  local_pack_dir?: string;
  cloud_url?: string;
  api_key?: string;
}

interface CapturedElementState {
  selector: string;
  targetRef: PickedTargetRef;
  state: ElementState;
}

interface PickedTargetFingerprint {
  tag: string;
  id?: string;
  classList: string[];
  textPrefix?: string;
}

interface PickedTargetRef {
  refId: string;
  selector: string;
  occurrenceIndex: number;
  domPath: number[];
  fingerprint: PickedTargetFingerprint;
}

interface RecorderStartInfo {
  selector: string;
  selectors: string[];
  watchedCount: number;
  targetRefs: PickedTargetRef[];
}

interface PromptTagBinding {
  alias: string;
  selector: string;
}

interface PromptAliasTarget {
  alias: string;
  selector: string;
  targetRef: PickedTargetRef;
  source: 'tag' | 'pick';
}

type CaptureRuntimeContext = {
  fetchImpl?: typeof fetch;
  confirmImpl?: ConfirmFn;
  interactive?: boolean;
};

function printUsage() {
  // Keep aligned with NON_EXTENSION_WORKFLOW Phase 2/CLI surface.
  console.log(`glitch capture [url] [options]

URL:
  <url>                        Positional page URL to capture
  --url <url>                  Equivalent explicit URL flag

Options:
  --mode <snapshot|recorder>   Capture mode (default: snapshot)
  --bug-type <type>            animation | layout-shift | overlap-zindex | color-visibility | overflow-clipping | other
  --selector <css>             Capture a selector directly (repeatable)
  --multi                      Picker allows selecting multiple elements
  --headless                   Run without visible browser (requires --selector)
  --screenshot <path>          Save screenshot path
  --cloud                      Upload to cloud MCP server
  --local                      Save pack locally
  --out <dir>                  Local pack output directory
  --prompt <text>              Attach a prompt/problem statement to the pack
  --prompt-tag <alias>=<css>   Bind a prompt alias to a selector (repeatable)
  --prompt-pick <alias>        Pick an element for a prompt alias (repeatable)
  --activate                   Add uploaded pack to Active Issues (best-effort)
  --no-activate                Skip Active Issues activation
  --wait <mode>                Navigation wait mode: domcontentloaded | load | networkidle (default: domcontentloaded)
  --no-close                   Keep browser open after success
  --help                       Show help`);
}

function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function resolveConfigPath(pathLike: string): string {
  return resolve(expandHomePath(pathLike));
}

function parseBugType(value: string): BugType {
  const normalized = value.trim().toLowerCase();
  const aliasMap: Record<string, BugType> = {
    animation: 'animation',
    'layout-shift': 'layout-shift',
    'overlap-zindex': 'z-index',
    'color-visibility': 'visibility',
    'overflow-clipping': 'overflow',
    'z-index': 'z-index',
    visibility: 'visibility',
    overflow: 'overflow',
    other: 'other',
  };

  const resolved = aliasMap[normalized];
  if (!resolved) {
    throw new Error(
      `Invalid --bug-type "${value}". Expected one of: animation, layout-shift, overlap-zindex, color-visibility, overflow-clipping, other`
    );
  }

  return resolved;
}

function parseMode(value: string): CaptureMode {
  if (value === 'snapshot' || value === 'recorder') return value;
  throw new Error(`Invalid --mode "${value}". Expected "snapshot" or "recorder".`);
}

function parseNavigationWaitMode(value: string): NavigationWaitMode {
  if (value === 'domcontentloaded' || value === 'load' || value === 'networkidle') {
    return value;
  }
  throw new Error(
    `Invalid --wait "${value}". Expected "domcontentloaded", "load", or "networkidle".`
  );
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

function parseAndValidateUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  if (!CAPTURE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Invalid ${label}: only http/https URLs are supported.`);
  }

  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateCloudUrl(value: string): string {
  const parsed = parseAndValidateUrl(value, 'cloud_url');
  if (parsed.protocol === 'https:' || isLoopbackHost(parsed.hostname)) {
    return parsed.toString();
  }

  throw new Error('cloud_url must use https unless the host is localhost/127.0.0.1/::1.');
}

function sanitizeUrlForLogs(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function printNextStepArtifact(packId: string, useActiveAlias = false): void {
  const resourceUri = useActiveAlias ? 'contextpacks://active' : `contextpacks://${packId}`;
  console.log(`Resource URI: ${resourceUri}`);
  console.log('Next step: paste this URI into Cursor/Claude with the Glitch MCP server enabled.');
  console.log('Ask your agent to load this resource and start analysis.');
}

function parsePromptTagBinding(value: string): PromptTagBinding {
  const eqIndex = value.indexOf('=');
  if (eqIndex <= 0 || eqIndex === value.length - 1) {
    throw new Error(`Invalid --prompt-tag "${value}". Expected <alias>=<selector>.`);
  }

  const alias = value.slice(0, eqIndex).trim();
  const selector = value.slice(eqIndex + 1).trim();
  if (!PROMPT_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid prompt alias "${alias}". Use letters, numbers, "_" or "-".`);
  }
  if (!selector) {
    throw new Error(`Invalid --prompt-tag "${value}". Selector cannot be empty.`);
  }

  return { alias, selector };
}

function parsePromptAlias(value: string, flag: '--prompt-pick' | '--prompt-tag'): string {
  const alias = value.trim();
  if (!PROMPT_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid alias for ${flag}: "${value}". Use letters, numbers, "_" or "-".`);
  }
  return alias;
}

function extractPromptTokens(promptText: string): string[] {
  const tokens: string[] = [];
  const regex = /@([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(promptText)) !== null) {
    tokens.push(match[1]);
  }
  return tokens;
}

export function parseCaptureArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: '',
    mode: 'snapshot',
    selectors: [],
    multi: false,
    headless: false,
    cloud: false,
    local: false,
    wait: 'domcontentloaded',
    noClose: false,
    promptTagBindings: [],
    promptPickAliases: [],
    activate: false,
    noActivate: false,
    help: false,
  };

  const tokens = [...argv];
  if (tokens[0] === 'capture') {
    tokens.shift();
  }

  let urlSource: 'none' | 'positional' | 'flag' = 'none';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--url') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --url');
      if (urlSource !== 'none') {
        throw new Error('Specify URL either as positional <url> or --url <url>, not both.');
      }
      args.url = value;
      urlSource = 'flag';
      i += 1;
      continue;
    }

    if (token === '--mode') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --mode');
      args.mode = parseMode(value);
      i += 1;
      continue;
    }

    if (token === '--bug-type') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --bug-type');
      args.bugType = parseBugType(value);
      i += 1;
      continue;
    }

    if (token === '--selector') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --selector');
      args.selectors.push(value);
      i += 1;
      continue;
    }

    if (token === '--cloud') {
      args.cloud = true;
      continue;
    }

    if (token === '--local') {
      args.local = true;
      continue;
    }

    if (token === '--out') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --out');
      args.out = value;
      i += 1;
      continue;
    }

    if (token === '--screenshot') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --screenshot');
      args.screenshot = value;
      i += 1;
      continue;
    }

    if (token === '--prompt') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --prompt');
      args.prompt = value;
      i += 1;
      continue;
    }

    if (token === '--prompt-tag') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --prompt-tag');
      args.promptTagBindings.push(parsePromptTagBinding(value));
      i += 1;
      continue;
    }

    if (token === '--prompt-pick') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --prompt-pick');
      args.promptPickAliases.push(parsePromptAlias(value, '--prompt-pick'));
      i += 1;
      continue;
    }

    if (token === '--activate') {
      args.activate = true;
      continue;
    }

    if (token === '--no-activate') {
      args.noActivate = true;
      continue;
    }

    if (token === '--wait') {
      const value = tokens[i + 1];
      if (!value) throw new Error('Missing value for --wait');
      args.wait = parseNavigationWaitMode(value);
      i += 1;
      continue;
    }

    if (token === '--multi') {
      args.multi = true;
      continue;
    }

    if (token === '--headless') {
      args.headless = true;
      continue;
    }

    if (token === '--no-close') {
      args.noClose = true;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    if (urlSource !== 'none') {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    args.url = token;
    urlSource = 'positional';
  }

  if (!args.help && !args.url) {
    throw new Error('Missing required URL. Provide <url> or --url <url>.');
  }

  if (args.cloud && args.local) {
    throw new Error('Use either --cloud or --local, not both.');
  }

  if (args.headless && args.selectors.length === 0) {
    throw new Error('--headless requires at least one --selector.');
  }

  if (args.activate && args.noActivate) {
    throw new Error('Use either --activate or --no-activate, not both.');
  }

  const promptAliases = new Set<string>();
  for (const binding of args.promptTagBindings) {
    if (promptAliases.has(binding.alias)) {
      throw new Error(`Duplicate prompt alias: @${binding.alias}`);
    }
    promptAliases.add(binding.alias);
  }
  for (const alias of args.promptPickAliases) {
    if (promptAliases.has(alias)) {
      throw new Error(`Duplicate prompt alias: @${alias}`);
    }
    promptAliases.add(alias);
  }

  const promptText = args.prompt?.trim() ?? '';
  if (!promptText && promptAliases.size > 0) {
    throw new Error('Prompt aliases require --prompt "<text>".');
  }

  if (promptText) {
    const tokens = extractPromptTokens(promptText);
    const missing = Array.from(new Set(tokens.filter((token) => !promptAliases.has(token))));
    if (missing.length > 0) {
      throw new Error(`Unknown prompt tags: ${missing.map((token) => `@${token}`).join(', ')}`);
    }
  }

  if (!args.help) {
    const parsed = parseAndValidateUrl(args.url, '--url');
    args.url = parsed.toString();
  }

  return args;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH): CliConfig {
  const resolvedPath = resolveConfigPath(configPath);
  if (!existsSync(resolvedPath)) return {};

  const raw = readFileSync(resolvedPath, 'utf8').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as CliConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid JSON in config file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveDestination(args: CliArgs, config: CliConfig): Destination {
  if (args.cloud) return 'cloud';
  if (args.local) return 'local';
  return config.default_destination === 'cloud' ? 'cloud' : 'local';
}

function resolveInjectBundlePath(): string {
  const filename = fileURLToPath(import.meta.url);
  const currentDir = dirname(filename);

  const candidates = [
    resolve(currentDir, 'capture-inject.js'),
    resolve(currentDir, 'dist/capture-inject.js'),
    resolve(process.cwd(), 'cli/dist/capture-inject.js'),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    'Missing injector bundle (cli/dist/capture-inject.js). Run: npm run build:cli-inject'
  );
}

function formatUnresolvedRefs(
  unresolved: Array<{ refId: string; selector: string; reason: string }>
): string {
  return unresolved
    .map((entry) => `${entry.refId} (${entry.selector}): ${entry.reason}`)
    .join('; ');
}

async function pickTargetRefs(
  page: Awaited<ReturnType<Browser['newPage']>>,
  multi: boolean
): Promise<PickedTargetRef[]> {
  if (!multi) {
    console.log('Picker active. Click one element in the browser to capture.');
    return await page.evaluate(async () => {
      const picker = (
        window as typeof window & {
          __glitchPicker?: {
            start: (multi?: boolean, purpose?: 'watch' | 'prompt') => Promise<PickedTargetRef[]>;
          };
        }
      ).__glitchPicker;
      if (!picker) throw new Error('Glitch picker API not found after injector load.');
      return await picker.start(false, 'watch');
    });
  }

  console.log('Picker active. Click elements in the browser, then press Enter in this terminal to finish.');
  await page.evaluate(() => {
    const picker = (
      window as typeof window & {
        __glitchPicker?: {
          start: (multi?: boolean, purpose?: 'watch' | 'prompt') => Promise<PickedTargetRef[]>;
        };
      }
    ).__glitchPicker;
    if (!picker) throw new Error('Glitch picker API not found after injector load.');
    void picker.start(true, 'watch').catch(() => {});
  });

  await waitForTerminalEnter('Press Enter in this terminal to finish selecting elements.');

  const refs = await page.evaluate(() => {
    const picker = (
      window as typeof window & {
        __glitchPicker?: {
          finishMulti: () => PickedTargetRef[];
        };
      }
    ).__glitchPicker;
    if (!picker) throw new Error('Glitch picker API not found after injector load.');
    return picker.finishMulti();
  });

  if (refs.length === 0) {
    throw new Error('No elements selected.');
  }
  return refs;
}

async function pickPromptTargetRef(
  page: Awaited<ReturnType<Browser['newPage']>>,
  alias: string
): Promise<PickedTargetRef> {
  console.log(`Prompt picker active for @${alias}. Click one element in the browser.`);
  const refs = await page.evaluate(async () => {
    const picker = (
      window as typeof window & {
        __glitchPicker?: {
          start: (multi?: boolean, purpose?: 'watch' | 'prompt') => Promise<PickedTargetRef[]>;
        };
      }
    ).__glitchPicker;
    if (!picker) throw new Error('Glitch picker API not found after injector load.');
    return await picker.start(false, 'prompt');
  });

  const picked = refs[0];
  if (!picked) {
    throw new Error(`No element selected for prompt alias @${alias}.`);
  }
  return picked;
}

async function synthesizeTargetRefsFromSelectors(
  page: Awaited<ReturnType<Browser['newPage']>>,
  selectors: string[]
): Promise<PickedTargetRef[]> {
  return await page.evaluate((inputSelectors) => {
    const picker = (
      window as typeof window & {
        __glitchPicker?: {
          synthesizeRefsFromSelectors: (selectors: string[]) => PickedTargetRef[];
        };
      }
    ).__glitchPicker;
    if (!picker) throw new Error('Glitch picker API not found after injector load.');
    return picker.synthesizeRefsFromSelectors(inputSelectors);
  }, selectors);
}

async function captureElementsByRefs(
  page: Awaited<ReturnType<Browser['newPage']>>,
  targetRefs: PickedTargetRef[]
): Promise<CapturedElementState[]> {
  const result = await page.evaluate((inputRefs) => {
    const api = (
      window as typeof window & {
        __glitchCapture?: { captureElementState: (element: Element) => ElementState };
      }
    ).__glitchCapture;
    const picker = (
      window as typeof window & {
        __glitchPicker?: {
          resolveTargetRef: (ref: PickedTargetRef) => Element | null;
          explainUnresolvedRef: (ref: PickedTargetRef) => string;
        };
      }
    ).__glitchPicker;

    if (!api) throw new Error('Glitch capture API not found after injector load.');
    if (!picker) throw new Error('Glitch picker API not found after injector load.');

    const captured: CapturedElementState[] = [];
    const unresolved: Array<{ refId: string; selector: string; reason: string }> = [];

    inputRefs.forEach((targetRef) => {
      const element = picker.resolveTargetRef(targetRef);
      if (!element) {
        unresolved.push({
          refId: targetRef.refId,
          selector: targetRef.selector,
          reason: picker.explainUnresolvedRef(targetRef),
        });
        return;
      }

      captured.push({
        selector: targetRef.selector,
        targetRef,
        state: api.captureElementState(element),
      });
    });

    return { captured, unresolved };
  }, targetRefs);

  if (result.unresolved.length > 0) {
    throw new Error(`Failed to resolve selected targets: ${formatUnresolvedRefs(result.unresolved)}`);
  }

  return result.captured;
}

async function captureViewport(
  page: Awaited<ReturnType<Browser['newPage']>>
): Promise<{ width: number; height: number; devicePixelRatio: number }> {
  return await page.evaluate(() => {
    const api = (
      window as typeof window & {
        __glitchCapture?: { captureViewport: () => { width: number; height: number; devicePixelRatio: number } };
      }
    ).__glitchCapture;
    if (!api) throw new Error('Glitch capture API not found after injector load.');
    return api.captureViewport();
  });
}

async function startWatcher(
  page: Awaited<ReturnType<Browser['newPage']>>,
  targetRefs: PickedTargetRef[]
): Promise<RecorderStartInfo> {
  return await page.evaluate((inputTargetRefs) => {
    const watcher = (
      window as typeof window & {
        __glitchWatcher?: {
          start: (targetRefs: PickedTargetRef[]) => {
            selector: string;
            selectors: string[];
            watchedCount: number;
            targetRefs: PickedTargetRef[];
          };
        };
      }
    ).__glitchWatcher;

    if (!watcher) throw new Error('Glitch watcher API not found after injector load.');
    return watcher.start(inputTargetRefs);
  }, targetRefs);
}

async function stopWatcher(
  page: Awaited<ReturnType<Browser['newPage']>>
): Promise<RecordingResult> {
  const raw = await page.evaluate(() => {
    const watcher = (
      window as typeof window & {
        __glitchWatcher?: {
          stop: () => {
            selector: string | null;
            initialState: ElementState | null;
            fullStyles: Record<string, string> | null;
            stateDeltas: Array<{ timestamp: number; delta: Record<string, unknown> }>;
            watchedElements: Array<{
              selector: string;
              targetRef?: PickedTargetRef;
              initialState: ElementState | null;
              fullStyles: Record<string, string>;
              stateDeltas: Array<{ timestamp: number; delta: Record<string, unknown> }>;
            }>;
            interactions: Array<{
              type: string;
              timestamp: number;
              target: { selector: string; tag: string; isWatchedElement: boolean; targetRefId?: string };
              coordinates?: { x: number; y: number };
            }>;
            duration: number;
          };
        };
      }
    ).__glitchWatcher;

    if (!watcher) throw new Error('Glitch watcher API not found after injector load.');
    return watcher.stop();
  });

  if (!raw.initialState || !raw.selector) {
    throw new Error('Recorder returned invalid data: missing selector or initial state.');
  }

  const watchedElements =
    raw.watchedElements && raw.watchedElements.length > 0
      ? raw.watchedElements
          .filter((entry) => !!entry.initialState)
          .map((entry) => ({
            selector: entry.selector,
            targetRef: entry.targetRef,
            initialState: entry.initialState as ElementState,
            fullStyles: entry.fullStyles ?? {},
            stateDeltas: entry.stateDeltas ?? [],
            stateHistory: [],
          }))
      : [
          {
            selector: raw.selector,
            initialState: raw.initialState,
            fullStyles: raw.fullStyles ?? raw.initialState.computedStyles ?? {},
            stateDeltas: raw.stateDeltas ?? [],
            stateHistory: [],
          },
        ];

  if (watchedElements.length === 0) {
    throw new Error('Recorder returned no watched elements.');
  }

  return {
    selector: raw.selector,
    initialState: raw.initialState,
    fullStyles: raw.fullStyles ?? raw.initialState.computedStyles ?? {},
    stateDeltas: raw.stateDeltas ?? [],
    watchedElements,
    interactions: raw.interactions ?? [],
    duration: raw.duration ?? 0,
  };
}

async function waitForTerminalEnter(prompt: string) {
  console.log(prompt);
  await new Promise<void>((resolve, reject) => {
    const stdin = process.stdin;
    const canToggleRawMode = stdin.isTTY && typeof stdin.setRawMode === 'function';
    const previousRaw = canToggleRawMode ? Boolean((stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) : false;

    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString();
      if (text.includes('\u0003')) {
        cleanup();
        reject(new Error('Recording cancelled by user (Ctrl+C).'));
        return;
      }
      if (text.includes('\n') || text.includes('\r')) {
        cleanup();
        resolve();
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    function cleanup() {
      stdin.off('data', onData);
      stdin.off('error', onError);
      if (canToggleRawMode) {
        stdin.setRawMode(previousRaw);
      }
      stdin.pause();
    }

    if (canToggleRawMode) {
      stdin.setRawMode(true);
    }

    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

function toRecordingResult(captured: CapturedElementState[]): RecordingResult {
  if (captured.length === 0) {
    throw new Error('No elements captured');
  }

  const watchedElements = captured.map((entry) => ({
    selector: entry.selector,
    targetRef: entry.targetRef,
    initialState: entry.state,
    fullStyles: entry.state.computedStyles ?? {},
    stateDeltas: [],
    stateHistory: [],
  }));

  const primary = watchedElements[0];
  return {
    selector: primary.selector,
    initialState: primary.initialState,
    fullStyles: primary.fullStyles,
    stateDeltas: [],
    stateHistory: [],
    watchedElements,
    interactions: [],
    duration: 0,
  };
}

function writePackToDirectory(
  pack: Awaited<ReturnType<typeof buildDirectoryPack>>,
  outputRoot: string
): string {
  const outDir = resolveConfigPath(outputRoot);
  mkdirSync(outDir, { recursive: true, mode: SECURE_DIR_MODE });
  for (const file of getPackFiles(pack)) {
    const filePath = resolve(outDir, file.path);
    assertPathWithinRoot(outDir, filePath, `Invalid output path: ${file.path}`);
    mkdirSync(dirname(filePath), { recursive: true, mode: SECURE_DIR_MODE });
    writeFileSync(filePath, file.contents, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  }
  return join(outDir, pack.id);
}

async function uploadPack(
  pack: Awaited<ReturnType<typeof buildDirectoryPack>>,
  cloudUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ packId: string }> {
  const endpoint = new URL('/packs', cloudUrl).toString();
  const redactedPayload = redactUploadPayload({ pack });
  const validation = validateUploadRequestPayload(redactedPayload);
  if (!validation.ok) {
    throw new Error(`Upload blocked: invalid pack payload.\n${formatUploadValidationErrors(validation.errors)}`);
  }

  const body = JSON.stringify(redactedPayload);
  const idempotencyKey = `glitch-upload-${crypto.randomUUID()}`;
  const maxAttempts = 5;

  const parseRetryAfterMs = (response: Response): number | null => {
    const retryAfter = response.headers.get('Retry-After');
    if (!retryAfter) return null;

    const asSeconds = Number(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.ceil(asSeconds * 1000);
    }

    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
    return null;
  };

  const computeBackoffMs = (attempt: number): number => {
    const base = Math.min(12_000, 500 * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 400);
    return base + jitter;
  };

  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  const coerceValidationIssues = (value: unknown): UploadValidationIssue[] => {
    if (!Array.isArray(value)) return [];
    const issues: UploadValidationIssue[] = [];

    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const path = typeof row.path === 'string' ? row.path : '';
      const message = typeof row.message === 'string' ? row.message : '';
      if (!path || !message) continue;
      issues.push({
        path,
        message,
        expected: typeof row.expected === 'string' ? row.expected : undefined,
        received: typeof row.received === 'string' ? row.received : undefined,
        hint: typeof row.hint === 'string' ? row.hint : undefined,
      });
    }

    return issues;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        body,
      });
    } catch (error) {
      if (attempt >= maxAttempts - 1) {
        throw new Error(
          `Upload failed after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(computeBackoffMs(attempt));
      continue;
    }

    if (response.ok) {
      let parsedBody: Record<string, unknown> | null = null;
      try {
        parsedBody = await response.json() as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }

      const packId =
        typeof parsedBody?.packId === 'string' && parsedBody.packId.trim().length > 0
          ? parsedBody.packId.trim()
          : pack.id;

      return { packId };
    }

    const errorBody = await response.text();
    let parsedError: Record<string, unknown> | null = null;
    try {
      parsedError = JSON.parse(errorBody) as Record<string, unknown>;
    } catch {
      parsedError = null;
    }

    const errorCode = typeof parsedError?.code === 'string' ? parsedError.code : '';
    if (response.status === 422 && errorCode === 'INVALID_PACK_SCHEMA') {
      const issues = coerceValidationIssues(parsedError?.errors);
      const detail = issues.length > 0
        ? formatUploadValidationErrors(issues)
        : (typeof parsedError?.error === 'string' ? parsedError.error : 'Upload payload validation failed.');
      throw new Error(`Upload rejected: invalid pack payload.\n${detail}`);
    }

    if (response.status === 401) {
      if (errorCode === 'API_KEY_REVOKED_OR_INVALID') {
        throw new Error(
          'Upload failed: API key is revoked or invalid.\n' +
          'Regenerate a key in Glitch, then run:\n' +
          'glitch config set api_key <new>'
        );
      }
      throw new Error(`Upload failed (401): ${errorBody || 'Unauthorized'}`);
    }

    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 409 && errorCode === 'IDEMPOTENCY_IN_PROGRESS');

    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Upload failed (${response.status}): ${errorBody || response.statusText}`);
    }

    const retryAfterMs = parseRetryAfterMs(response);
    await sleep(retryAfterMs ?? computeBackoffMs(attempt));
  }

  return { packId: pack.id };
}

function formatPromptAliasTargets(targets: PromptAliasTarget[]): string {
  if (targets.length === 0) {
    return '';
  }

  const rows = targets
    .slice()
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => {
      const source = entry.source === 'pick' ? 'picked' : 'selector';
      return `- @${entry.alias}: ${entry.selector} (${source}, ref=${entry.targetRef.refId})`;
    });
  return `\n\nPrompt tags:\n${rows.join('\n')}`;
}

async function runCapture(
  args: CliArgs,
  config: CliConfig,
  context: CaptureRuntimeContext = {},
) {
  const destination = resolveDestination(args, config);
  if (destination === 'cloud' && !config.api_key) {
    throw new Error(
      `Cloud upload requires api_key in ${resolveConfigPath(DEFAULT_CONFIG_PATH)} or use --local.`
    );
  }

  const bundlePath = resolveInjectBundlePath();
  const injectJs = readFileSync(bundlePath, 'utf8');

  let browser: Browser | null = null;
  let completedSuccessfully = false;

  try {
    let chromium: { launch: (options: { headless: boolean }) => Promise<Browser> };
    try {
      const playwrightModule = await import('playwright');
      chromium = { launch: playwrightModule.chromium.launch.bind(playwrightModule.chromium) };
    } catch {
      throw new Error(
        'Playwright is required for capture mode. Install it with: npm install playwright'
      );
    }

    browser = await chromium.launch({ headless: args.headless });
    const page = await browser.newPage();

    console.log(`Navigating to ${sanitizeUrlForLogs(args.url)} (wait: ${args.wait})`);
    await page.goto(args.url, { waitUntil: args.wait });
    if (args.wait !== 'networkidle') {
      await page.waitForTimeout(DEFAULT_NAV_SETTLE_MS);
    }

    await page.evaluate(injectJs);

    const promptAliasTargets: PromptAliasTarget[] = [];
    if (args.promptTagBindings.length > 0) {
      const selectors = args.promptTagBindings.map((binding) => binding.selector);
      const refs = await synthesizeTargetRefsFromSelectors(page, selectors);
      refs.forEach((ref, index) => {
        const binding = args.promptTagBindings[index];
        if (!binding) return;
        promptAliasTargets.push({
          alias: binding.alias,
          selector: binding.selector,
          targetRef: ref,
          source: 'tag',
        });
      });
    }

    for (const alias of args.promptPickAliases) {
      const picked = await pickPromptTargetRef(page, alias);
      promptAliasTargets.push({
        alias,
        selector: picked.selector,
        targetRef: picked,
        source: 'pick',
      });
    }

    const targetRefs =
      args.selectors.length > 0
        ? await synthesizeTargetRefsFromSelectors(page, args.selectors)
        : await pickTargetRefs(page, args.multi);

    if (targetRefs.length === 0) {
      throw new Error('No elements were provided or selected.');
    }

    let recordingResult: RecordingResult;
    let source: 'snapshot' | 'recorder' = 'snapshot';

    if (args.mode === 'snapshot') {
      const capturedElements = await captureElementsByRefs(page, targetRefs);
      const viewport = await captureViewport(page);
      console.log(
        `Captured ${capturedElements.length} element(s) at ${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}x`
      );
      recordingResult = toRecordingResult(capturedElements);
    } else {
      let watcherStarted = false;
      try {
        const started = await startWatcher(page, targetRefs);
        watcherStarted = true;
        console.log(
          `Watching ${started.watchedCount} element(s): ${started.selectors.join(', ')}`
        );
        await waitForTerminalEnter('Recording started. Interact with the page, then press Enter in this terminal to stop.');
        recordingResult = await stopWatcher(page);
        watcherStarted = false;
      } catch (error) {
        if (watcherStarted) {
          try {
            await stopWatcher(page);
          } catch {
            // Best-effort cleanup only.
          }
        }
        throw error;
      }

      source = 'recorder';
      const totalDeltas = recordingResult.watchedElements?.reduce(
        (sum, entry) => sum + (entry.stateDeltas?.length ?? 0),
        0
      ) ?? recordingResult.stateDeltas?.length ?? 0;

      console.log(
        `Recorded ${recordingResult.duration}ms with ${recordingResult.interactions.length} interaction(s) and ${totalDeltas} state delta(s)`
      );
    }

    if (args.screenshot) {
      const screenshotPath = resolveConfigPath(args.screenshot);
      mkdirSync(dirname(screenshotPath), { recursive: true, mode: SECURE_DIR_MODE });
      await page.screenshot({ path: screenshotPath });
      console.log(`Screenshot saved: ${screenshotPath}`);
    }

    const pack = await buildDirectoryPack(recordingResult, {
      source,
      bugType: args.bugType,
      url: page.url(),
      prompt: `${args.prompt?.trim() ?? ''}${formatPromptAliasTargets(promptAliasTargets)}`.trim(),
    });

    if (destination === 'cloud') {
      const cloudUrl = validateCloudUrl(config.cloud_url || DEFAULT_CLOUD_URL);
      const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
      const uploadResult = await uploadPack(pack, cloudUrl, apiKey, context.fetchImpl ?? fetch);
      console.log(`Uploaded pack: ${uploadResult.packId}`);

      const activationDecision = await decidePostUploadActivation({
        destination,
        activationPreference: resolveCaptureActivationPreference(args),
        hasApiKey: apiKey.length > 0,
        interactive: context.interactive ?? isInteractiveSession(),
        confirmImpl: context.confirmImpl ?? confirmYesNo,
      });

      if (activationDecision.note) {
        console.warn(activationDecision.note);
      }

      let useActiveAlias = false;
      if (activationDecision.shouldActivate) {
        const activationResult = await activateUploadedPack({
          packId: uploadResult.packId,
          cloudUrl,
          apiKey,
          fetchImpl: context.fetchImpl ?? fetch,
        });
        if (activationResult.activated) {
          console.log('Added to Active Issues');
          useActiveAlias = true;
        } else if (activationResult.message) {
          console.warn(activationResult.message);
        }
      }

      printNextStepArtifact(uploadResult.packId, useActiveAlias);
    } else {
      const outputRoot = args.out || config.local_pack_dir || DEFAULT_LOCAL_PACK_DIR;
      const packPath = writePackToDirectory(pack, outputRoot);
      console.log(`Saved pack: ${packPath}`);

      const activationDecision = await decidePostUploadActivation({
        destination,
        activationPreference: resolveCaptureActivationPreference(args),
        hasApiKey: typeof config.api_key === 'string' && config.api_key.trim().length > 0,
        interactive: context.interactive ?? isInteractiveSession(),
        confirmImpl: context.confirmImpl ?? confirmYesNo,
      });
      if (activationDecision.note) {
        console.warn(activationDecision.note);
      }

      printNextStepArtifact(pack.id);
    }

    completedSuccessfully = true;

    if (args.noClose) {
      console.log('Browser left open (--no-close). Close it manually when done.');
      return;
    }

    await browser.close();
    browser = null;
  } finally {
    if (browser && !completedSuccessfully) {
      await browser.close();
    }
  }
}

export async function runCaptureCli(
  argv: string[] = process.argv.slice(2),
  context: CaptureRuntimeContext = {},
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCaptureArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 1;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  let config: CliConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    await runCapture(args, config, context);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
