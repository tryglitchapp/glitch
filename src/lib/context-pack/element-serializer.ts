import type {
  ElementCore,
  ElementState,
  FullStyles,
  MinimalParentChainEntry,
  ParentChainEntry,
  StateDelta,
} from './pack-types';

const CORE_PARENT_STYLE_KEYS = [
  'display',
  'position',
  'z-index',
  'overflow',
  'overflow-x',
  'overflow-y',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-content',
  'justify-content',
  'place-items',
  'place-content',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  'gap',
  'row-gap',
  'column-gap',
  'transform',
  'opacity',
  'pointer-events',
  'visibility',
];

export function serializeElementCore(state: ElementState): ElementCore {
  return {
    selector: state.selector ?? '',
    tag: state.tag ?? 'element',
    boundingBox: {
      x: state.boundingBox?.x ?? 0,
      y: state.boundingBox?.y ?? 0,
      width: state.boundingBox?.width ?? 0,
      height: state.boundingBox?.height ?? 0,
    },
    classes: Array.isArray(state.classes) ? state.classes : [],
    isVisible: Boolean(state.isVisible),
  };
}

export function serializeFullStyles(state: ElementState): FullStyles {
  return {
    computedStyles: state.computedStyles ?? state.styles ?? {},
    transition: state.transition,
    animation: state.animation,
    transformOrigin: state.transformOrigin,
  };
}

export function computeStateDeltas(states: ElementState[]): StateDelta[] {
  if (!states || states.length <= 1) return [];

  const deltas: StateDelta[] = [];
  let previous = states[0];

  for (let i = 1; i < states.length; i += 1) {
    const current = states[i];
    const delta: Record<string, any> = {};

    diffBoundingBox(previous.boundingBox, current.boundingBox, delta, 'boundingBox');
    diffRecord(previous.styles, current.styles, delta, 'styles');
    diffRecord(previous.computedStyles, current.computedStyles, delta, 'computedStyles');

    if (!arraysEqual(previous.classes, current.classes)) {
      delta.classes = current.classes ?? [];
    }

    if (previous.isVisible !== current.isVisible) {
      delta.isVisible = current.isVisible;
    }

    diffRecord(previous.attributes, current.attributes, delta, 'attributes');
    diffRecord(previous.transition as Record<string, any> | undefined, current.transition as Record<string, any> | undefined, delta, 'transition');
    diffRecord(previous.animation as Record<string, any> | undefined, current.animation as Record<string, any> | undefined, delta, 'animation');

    if (previous.transformOrigin !== current.transformOrigin) {
      delta.transformOrigin = current.transformOrigin;
    }

    diffRecord(previous.viewport as Record<string, any> | undefined, current.viewport as Record<string, any> | undefined, delta, 'viewport');
    diffRecord(previous.scrollOffsets?.window as Record<string, any> | undefined, current.scrollOffsets?.window as Record<string, any> | undefined, delta, 'scrollOffsets.window');
    diffRecord(
      previous.scrollOffsets?.nearestScrollAncestor as Record<string, any> | undefined,
      current.scrollOffsets?.nearestScrollAncestor as Record<string, any> | undefined,
      delta,
      'scrollOffsets.nearestScrollAncestor'
    );
    diffRecord(previous.scrollSize as Record<string, any> | undefined, current.scrollSize as Record<string, any> | undefined, delta, 'scrollSize');

    if (previous.textContent !== current.textContent) {
      delta.textContent = current.textContent;
    }

    if (Object.keys(delta).length > 0) {
      deltas.push({
        timestamp: current.timestamp,
        delta,
      });
    }

    previous = current;
  }

  return deltas;
}

export function serializeParentChain(chain: ParentChainEntry[]): MinimalParentChainEntry[] {
  if (!chain || chain.length === 0) return [];

  return chain.map((entry) => ({
    selector: entry.selector,
    boundingBox: entry.boundingBox,
    coreStyles: entry.coreStyles ?? pickCoreStyles(entry.computedStyles ?? {}),
    scrollSize: entry.scrollSize,
  }));
}

export function serializeParentChainFull(chain: ParentChainEntry[]): ParentChainEntry[] {
  if (!chain || chain.length === 0) return [];

  return chain.map((entry) => {
    const computedStyles = entry.computedStyles;
    const hasComputedStyles = computedStyles && Object.keys(computedStyles).length > 0;
    return {
      selector: entry.selector,
      boundingBox: entry.boundingBox,
      coreStyles: entry.coreStyles ?? pickCoreStyles(computedStyles ?? {}),
      computedStyles: hasComputedStyles ? computedStyles : undefined,
      scrollSize: entry.scrollSize,
    };
  });
}

function pickCoreStyles(styles: Record<string, string>): Record<string, string> {
  const core: Record<string, string> = {};
  CORE_PARENT_STYLE_KEYS.forEach((key) => {
    if (key in styles) {
      core[key] = styles[key];
    }
  });
  return core;
}

function diffBoundingBox(
  prev: { x: number; y: number; width: number; height: number } | undefined,
  curr: { x: number; y: number; width: number; height: number } | undefined,
  changes: Record<string, any>,
  prefix: string
) {
  if (!prev && !curr) return;
  const prevBox = prev ?? { x: 0, y: 0, width: 0, height: 0 };
  const currBox = curr ?? { x: 0, y: 0, width: 0, height: 0 };

  if (prevBox.x !== currBox.x) changes[`${prefix}.x`] = currBox.x;
  if (prevBox.y !== currBox.y) changes[`${prefix}.y`] = currBox.y;
  if (prevBox.width !== currBox.width) changes[`${prefix}.width`] = currBox.width;
  if (prevBox.height !== currBox.height) changes[`${prefix}.height`] = currBox.height;
}

function diffRecord(
  prev: Record<string, any> | undefined,
  curr: Record<string, any> | undefined,
  changes: Record<string, any>,
  prefix: string
) {
  if (!prev && !curr) return;
  const prevRecord = prev ?? {};
  const currRecord = curr ?? {};
  const keys = new Set([...Object.keys(prevRecord), ...Object.keys(currRecord)]);
  keys.forEach((key) => {
    const prevValue = prevRecord[key];
    const currValue = currRecord[key];
    if (prevValue !== currValue) {
      changes[`${prefix}.${key}`] = currValue;
    }
  });
}

function arraysEqual(a?: string[], b?: string[]) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
