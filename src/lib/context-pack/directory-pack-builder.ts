import type { ContextPack } from '../../types/context-pack';
import {
  computeStateDeltas,
  serializeElementCore,
  serializeFullStyles,
  serializeParentChain,
  serializeParentChainFull,
} from './element-serializer';
import { generatePackSummary } from './summary-generator';
import type {
  DirectoryPack,
  DirectoryPackElement,
  DirectoryPackOptions,
  ElementState,
  Interaction,
  PackFile,
  PackManifest,
  PickedTargetRef,
  RecordingResult,
  ViewportState,
} from './pack-types';

const DIRECTORY_PACK_VERSION = '3.0';

export async function buildDirectoryPack(
  recordingResult: RecordingResult,
  options: DirectoryPackOptions = {}
): Promise<DirectoryPack> {
  const packId = options.packId ?? generatePackId();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const source = options.source ?? 'recorder';
  const url = options.url ?? getCurrentUrl();
  const prompt = options.prompt ?? options.bugDescription ?? '';
  const bugDescription = options.bugDescription ?? (prompt.trim() ? prompt : undefined);

  const watchedEntries =
    recordingResult.watchedElements && recordingResult.watchedElements.length > 0
      ? recordingResult.watchedElements
      : [
          {
            selector: recordingResult.selector,
            initialState: recordingResult.initialState,
            fullStyles: recordingResult.fullStyles,
            stateDeltas: recordingResult.stateDeltas,
            stateHistory: recordingResult.stateHistory,
          },
        ];

  const watchedElements: DirectoryPackElement[] = watchedEntries.map((entry, index) => {
    const id = `el_${String(index).padStart(2, '0')}`;
    const slug = deriveSelectorSlug(entry.selector, `element-${index + 1}`);
    const dir = `watched/${id}_${slug}`;
    const tag = deriveTagFromSelector(entry.selector, 'element');
    const enrichedInitialState: ElementState = {
      ...entry.initialState,
      selector: entry.selector,
      tag,
    };
    const stateHistory = entry.stateHistory ?? [];
    const computedStyles = entry.fullStyles ?? enrichedInitialState.computedStyles ?? enrichedInitialState.styles ?? {};
    const deltaBaseState: ElementState = { ...enrichedInitialState, computedStyles };
    const deltas = entry.stateDeltas ?? computeStateDeltas([deltaBaseState, ...stateHistory]);
    const fallbackTargetRef = buildFallbackTargetRef(id, entry.selector, tag, enrichedInitialState);
    const targetRef = normalizeTargetRef(entry.targetRef, fallbackTargetRef);
    return {
      id,
      selector: entry.selector,
      tag,
      dir,
      targetRef,
      core: serializeElementCore(enrichedInitialState),
      fullStyles: serializeFullStyles({ ...enrichedInitialState, computedStyles }),
      stateDeltas: deltas,
      parents: serializeParentChain(entry.initialState?.parentChain ?? []),
      parentsFull: serializeParentChainFull(entry.initialState?.parentChain ?? []),
    };
  });

  const manifest: PackManifest = {
    id: packId,
    version: DIRECTORY_PACK_VERSION,
    timestamp,
    source,
    bugType: options.bugType,
    bugDescription,
    url,
    watchedElements: watchedElements.map((entry) => ({
      id: entry.id,
      selector: entry.selector,
      dir: entry.dir,
      targetRefId: entry.targetRef?.refId,
    })),
    stats: {
      totalStateChanges: watchedEntries.reduce(
        (sum, entry) => sum + (entry.stateDeltas?.length ?? entry.stateHistory?.length ?? 0),
        0
      ),
      propertiesChanged: collectPropertiesChanged(watchedElements),
      duration: recordingResult.duration,
    },
  };

  const pack: DirectoryPack = {
    id: packId,
    manifest,
    summary: {
      detectedBugPatterns: [],
      keyFindings: [],
      recommendedMCPQueries: [],
    },
    prompt,
    interactions: recordingResult.interactions ?? [],
    viewport: extractViewportState(recordingResult, watchedEntries[0]?.initialState ?? null),
    watchedElements,
    contextElements: options.contextElements ?? [],
  };

  pack.summary = generatePackSummary(pack);

  return pack;
}

export async function buildDirectoryPackFromContextPack(
  contextPack: ContextPack,
  options: DirectoryPackOptions = {}
): Promise<DirectoryPack> {
  const targets = contextPack.targets && contextPack.targets.length > 0
    ? contextPack.targets
    : [contextPack.target];

  const watchedElements = targets.map((target) => {
    const classes = extractClassesFromAttributes(target.dom.attributes);
    const isVisible = target.layout.boundingBox.width > 0 && target.layout.boundingBox.height > 0;
    const baseState: ElementState = {
      timestamp: 0,
      boundingBox: {
        x: target.layout.boundingBox.x,
        y: target.layout.boundingBox.y,
        width: target.layout.boundingBox.width,
        height: target.layout.boundingBox.height,
      },
      styles: target.styles.computed ?? {},
      classes,
      isVisible,
      attributes: target.dom.attributes,
      computedStyles: target.styles.computed ?? {},
      transition: target.styles.transition,
      animation: target.styles.animation,
      transformOrigin: target.styles.transformOrigin,
      viewport: {
        width: contextPack.meta.viewport.width,
        height: contextPack.meta.viewport.height,
        devicePixelRatio: contextPack.meta.devicePixelRatio,
      },
      scrollOffsets: target.layout.scrollOffsets,
      scrollSize: target.layout.scrollSize,
      parentChain: target.layout.parentChain,
      textContent: target.dom.textContent,
      selector: target.selectors.css,
      tag: target.dom.tag,
    };

    return {
      selector: target.selectors.css,
      initialState: baseState,
      fullStyles: target.styles.computed ?? {},
      stateDeltas: [],
      stateHistory: [],
    };
  });

  const interactions: Interaction[] = contextPack.interactionTrace?.events
    ? contextPack.interactionTrace.events.map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        target: {
          selector: event.target.selector,
          tag: event.target.tag,
          isWatchedElement: watchedElements.some((entry) => entry.selector === event.target.selector),
        },
      }))
    : [];

  const primary = watchedElements[0];
  if (!primary) {
    throw new Error('Context pack has no targets to export.');
  }

  const recordingResult: RecordingResult = {
    selector: primary.selector,
    initialState: primary.initialState,
    fullStyles: primary.fullStyles,
    stateDeltas: [],
    stateHistory: [],
    watchedElements,
    interactions,
    duration: contextPack.interactionTrace?.duration ?? 0,
  };

  return await buildDirectoryPack(recordingResult, {
    ...options,
    source: options.source ?? 'snapshot',
    url: options.url ?? contextPack.url,
    timestamp: options.timestamp ?? contextPack.timestamp,
  });
}

export async function exportDirectoryPack(pack: DirectoryPack): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const files = getPackFiles(pack);

  files.forEach((file) => {
    zip.file(file.path, file.contents);
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${pack.id}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 100);
}

export function getPackFiles(pack: DirectoryPack): PackFile[] {
  const files: PackFile[] = [];
  const root = pack.id;

  files.push({
    path: `${root}/manifest.json`,
    contents: JSON.stringify(pack.manifest, null, 2),
  });
  files.push({
    path: `${root}/prompt.md`,
    contents: pack.prompt ?? '',
  });
  files.push({
    path: `${root}/summary.json`,
    contents: JSON.stringify(pack.summary, null, 2),
  });
  files.push({
    path: `${root}/interactions.json`,
    contents: JSON.stringify(pack.interactions ?? [], null, 2),
  });
  files.push({
    path: `${root}/viewport.json`,
    contents: JSON.stringify(pack.viewport ?? {}, null, 2),
  });
  files.push({
    path: `${root}/context/elements.json`,
    contents: JSON.stringify(pack.contextElements ?? [], null, 2),
  });

  pack.watchedElements.forEach((element) => {
    files.push({
      path: `${root}/${element.dir}/core.json`,
      contents: JSON.stringify(element.core, null, 2),
    });
    files.push({
      path: `${root}/${element.dir}/full-styles.json`,
      contents: JSON.stringify(element.fullStyles, null, 2),
    });
    files.push({
      path: `${root}/${element.dir}/state-deltas.json`,
      contents: JSON.stringify(element.stateDeltas ?? [], null, 2),
    });
    files.push({
      path: `${root}/${element.dir}/parents.json`,
      contents: JSON.stringify(element.parents ?? [], null, 2),
    });
    if (element.targetRef) {
      files.push({
        path: `${root}/${element.dir}/target-ref.json`,
        contents: JSON.stringify(element.targetRef, null, 2),
      });
    }
    const hasFullParents = element.parentsFull?.some(
      (entry) => entry.computedStyles && Object.keys(entry.computedStyles).length > 0
    );
    if (hasFullParents) {
      files.push({
        path: `${root}/${element.dir}/parents-full.json`,
        contents: JSON.stringify(element.parentsFull, null, 2),
      });
    }
  });

  return files;
}

function generatePackId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `pack_${timestamp}${random}`;
}

function getCurrentUrl(): string {
  try {
    return window.location.href;
  } catch {
    return '';
  }
}

function deriveSelectorSlug(selector: string, fallback: string): string {
  if (!selector) return sanitizeFilenamePart(fallback);

  const dataTestMatch = selector.match(/\[data-testid=['\"]?([^'\"]+)/i);
  if (dataTestMatch?.[1]) return sanitizeFilenamePart(dataTestMatch[1]);

  const ariaMatch = selector.match(/\[aria-label=['\"]?([^'\"]+)/i);
  if (ariaMatch?.[1]) return sanitizeFilenamePart(ariaMatch[1]);

  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch?.[1]) return sanitizeFilenamePart(idMatch[1]);

  const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
  if (classMatch?.[1]) return sanitizeFilenamePart(classMatch[1]);

  const tagMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  return sanitizeFilenamePart(tagMatch?.[0] ?? fallback);
}

function deriveTagFromSelector(selector: string, fallback: string): string {
  if (!selector) return fallback;
  const tagMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  return tagMatch?.[0] ?? fallback;
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return sanitized || 'element';
}

function collectPropertiesChanged(watchedElements: DirectoryPackElement[]): string[] {
  const props = new Set<string>();
  watchedElements.forEach((element) => {
    element.stateDeltas.forEach((delta) => {
      Object.keys(delta.delta).forEach((key) => {
        props.add(normalizePropertyKey(key));
      });
    });
  });
  return Array.from(props);
}

function normalizePropertyKey(key: string): string {
  if (key.startsWith('styles.')) return key.replace('styles.', '');
  if (key.startsWith('computedStyles.')) return key.replace('computedStyles.', '');
  return key;
}

function extractViewportState(
  recordingResult: RecordingResult,
  initialState: ElementState | null
): ViewportState | null {
  if (initialState?.viewport) {
    return {
      width: initialState.viewport.width,
      height: initialState.viewport.height,
      devicePixelRatio: initialState.viewport.devicePixelRatio,
      scrollOffsets: initialState.scrollOffsets,
      scrollSize: initialState.scrollSize,
    };
  }

  const firstInteraction = recordingResult.interactions?.[0];
  if (!firstInteraction || typeof window === 'undefined') return null;

  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function extractClassesFromAttributes(attributes: Record<string, string>): string[] {
  const classAttr = attributes?.class ?? attributes?.className;
  if (!classAttr) return [];
  return classAttr.split(/\s+/).filter(Boolean);
}

function sanitizeDomPath(path: unknown): number[] {
  if (!Array.isArray(path)) return [];
  return path
    .map((part) => (typeof part === 'number' ? Math.floor(part) : Number(part)))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

function normalizeTargetRef(
  input: PickedTargetRef | undefined,
  fallback: PickedTargetRef
): PickedTargetRef {
  if (!input) return fallback;

  const refId = typeof input.refId === 'string' && input.refId.trim() ? input.refId.trim() : fallback.refId;
  const selector = typeof input.selector === 'string' && input.selector.trim()
    ? input.selector.trim()
    : fallback.selector;
  const occurrenceIndexRaw = Number(input.occurrenceIndex);
  const occurrenceIndex = Number.isFinite(occurrenceIndexRaw) && occurrenceIndexRaw >= 0
    ? Math.floor(occurrenceIndexRaw)
    : fallback.occurrenceIndex;
  const domPath = sanitizeDomPath(input.domPath);

  const fingerprintTag = typeof input.fingerprint?.tag === 'string' && input.fingerprint.tag.trim()
    ? input.fingerprint.tag.trim().toLowerCase()
    : fallback.fingerprint.tag;
  const fingerprintId = typeof input.fingerprint?.id === 'string' && input.fingerprint.id.trim()
    ? input.fingerprint.id.trim()
    : fallback.fingerprint.id;
  const fingerprintClasses = Array.isArray(input.fingerprint?.classList)
    ? input.fingerprint.classList.filter((entry): entry is string => typeof entry === 'string')
    : fallback.fingerprint.classList;
  const textPrefix = typeof input.fingerprint?.textPrefix === 'string'
    ? input.fingerprint.textPrefix.slice(0, 160)
    : fallback.fingerprint.textPrefix;

  return {
    refId,
    selector,
    occurrenceIndex,
    domPath: domPath.length > 0 ? domPath : fallback.domPath,
    fingerprint: {
      tag: fingerprintTag,
      id: fingerprintId,
      classList: fingerprintClasses,
      textPrefix,
    },
  };
}

function buildFallbackTargetRef(
  elementId: string,
  selector: string,
  tag: string,
  state: ElementState
): PickedTargetRef {
  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  const textPrefix = typeof state.textContent === 'string' ? state.textContent.slice(0, 160) : undefined;
  return {
    refId: elementId,
    selector,
    occurrenceIndex: 0,
    domPath: [],
    fingerprint: {
      tag,
      id: idMatch?.[1],
      classList: Array.isArray(state.classes) ? state.classes : [],
      textPrefix,
    },
  };
}
