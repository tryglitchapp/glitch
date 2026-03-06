import { captureCoreStyles } from '../src/lib/capture/styles';
import { computeStateDelta } from '../src/lib/context-pack/delta';
import { redactAttributes, redactString } from '../src/lib/security/redaction';

type PickerPurpose = 'watch' | 'prompt';

interface PickedElementInfo {
  tag: string;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  classes: string[];
  selector: string;
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

interface CaptureViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

interface ParentChainEntry {
  selector: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  coreStyles?: Record<string, string>;
  computedStyles?: Record<string, string>;
  scrollSize?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
}

interface ElementState {
  timestamp: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  styles: {
    display: string;
    visibility: string;
    opacity: string;
    transform: string;
    position: string;
    zIndex: string;
    overflow: string;
    overflowX: string;
    overflowY: string;
  };
  classes: string[];
  attributes: Record<string, string>;
  isVisible: boolean;
  computedStyles?: Record<string, string>;
  transition?: {
    transition: string;
    transitionProperty: string;
    transitionDuration: string;
    transitionTimingFunction: string;
    transitionDelay: string;
  };
  animation?: {
    animationName: string;
    animationDuration: string;
    animationTimingFunction: string;
    animationDelay: string;
    animationIterationCount: string;
    animationPlayState: string;
  };
  transformOrigin?: string;
  viewport?: CaptureViewport;
  scrollOffsets?: {
    window: { x: number; y: number };
    nearestScrollAncestor?: { x: number; y: number; selector: string };
  };
  parentChain?: ParentChainEntry[];
  scrollSize?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  textContent?: string;
  selector?: string;
  tag?: string;
}

interface Interaction {
  type: string;
  timestamp: number;
  target: {
    selector: string;
    tag: string;
    isWatchedElement: boolean;
    targetRefId?: string;
  };
  coordinates?: { x: number; y: number };
}

interface ElementRecordingState {
  selector: string;
  targetRef?: PickedTargetRef;
  initialState: ElementState | null;
  fullStyles: Record<string, string>;
  stateDeltas: ReturnType<typeof computeStateDelta>[];
}

interface WatcherResult {
  selector: string | null;
  initialState: ElementState | null;
  fullStyles: Record<string, string> | null;
  stateDeltas: ReturnType<typeof computeStateDelta>[];
  watchedElements: ElementRecordingState[];
  interactions: Interaction[];
  duration: number;
}

interface CaptureApi {
  captureElementState: (
    element: Element,
    options?: { includeParentComputedStyles?: boolean }
  ) => ElementState;
  captureViewport: () => CaptureViewport;
}

interface PickerApi {
  start: (multi?: boolean, purpose?: PickerPurpose) => Promise<PickedTargetRef[]>;
  stop: () => void;
  finishMulti: () => PickedTargetRef[];
  getSelection: () => PickedTargetRef[];
  synthesizeRefsFromSelectors: (selectors: string[]) => PickedTargetRef[];
  resolveTargetRef: (ref: PickedTargetRef) => Element | null;
  explainUnresolvedRef: (ref: PickedTargetRef) => string;
}

interface WatcherStatus {
  isWatching: boolean;
  selector: string | null;
  selectors: string[];
  watchedCount: number;
  interactionCount: number;
  stateChangeCount: number;
}

interface WatcherApi {
  start: (targetRefs: PickedTargetRef[] | string[]) => {
    selector: string;
    selectors: string[];
    watchedCount: number;
    targetRefs: PickedTargetRef[];
  };
  stop: () => WatcherResult;
  getStatus: () => WatcherStatus;
}

declare global {
  interface Window {
    __glitchCapture: CaptureApi;
    __glitchPicker: PickerApi;
    __glitchWatcher: WatcherApi;
  }
}

function captureComputedStyles(element: Element): Record<string, string> {
  const computed = window.getComputedStyle(element);
  const styles: Record<string, string> = {};
  for (let i = 0; i < computed.length; i += 1) {
    const prop = computed.item(i);
    if (!prop) continue;
    styles[prop] = computed.getPropertyValue(prop);
  }
  return styles;
}

function captureTransition(computed: CSSStyleDeclaration) {
  return {
    transition: computed.getPropertyValue('transition'),
    transitionProperty: computed.getPropertyValue('transition-property'),
    transitionDuration: computed.getPropertyValue('transition-duration'),
    transitionTimingFunction: computed.getPropertyValue('transition-timing-function'),
    transitionDelay: computed.getPropertyValue('transition-delay'),
  };
}

function captureAnimation(computed: CSSStyleDeclaration) {
  return {
    animationName: computed.getPropertyValue('animation-name'),
    animationDuration: computed.getPropertyValue('animation-duration'),
    animationTimingFunction: computed.getPropertyValue('animation-timing-function'),
    animationDelay: computed.getPropertyValue('animation-delay'),
    animationIterationCount: computed.getPropertyValue('animation-iteration-count'),
    animationPlayState: computed.getPropertyValue('animation-play-state'),
  };
}

function captureViewport(): CaptureViewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function isElementVisible(element: Element, rect: DOMRect): boolean {
  const computed = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    computed.display !== 'none' &&
    computed.visibility !== 'hidden' &&
    parseFloat(computed.opacity) > 0
  );
}

function getStableSelector(element: Element): string | null {
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
  if (element.id) return `#${CSS.escape(element.id)}`;
  return null;
}

function getFallbackSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const classes = Array.from(element.classList);
  return `${tag}${classes.length > 0 ? `.${classes.slice(0, 2).map((c) => CSS.escape(c)).join('.')}` : ''}`;
}

function elementMatchesSelector(element: Element, selector: string | null | undefined): boolean {
  if (!selector) return false;
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function generateSelector(element: Element): string {
  const stable = getStableSelector(element);
  if (stable) return stable;

  const path: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && path.length < 4) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      path.unshift(selector);
      break;
    }
    if (current.classList.length > 0) {
      selector += `.${Array.from(current.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(' > ');
}

function generateRefId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ref_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function getElementDomPath(element: Element): number[] {
  const path: number[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    const parent = current.parentElement;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.children, current);
    if (index < 0) break;
    path.unshift(index);
    current = parent;
  }

  return path;
}

function resolveDomPath(domPath: number[]): Element | null {
  let current: Element | null = document.documentElement;
  for (const part of domPath) {
    if (!current || !Number.isInteger(part) || part < 0) return null;
    const next = current.children.item(part);
    if (!(next instanceof Element)) return null;
    current = next;
  }
  return current;
}

function safeQuerySelectorAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function getOccurrenceIndex(element: Element, selector: string): number {
  const matches = safeQuerySelectorAll(selector);
  const index = matches.findIndex((candidate) => candidate === element);
  return index >= 0 ? index : 0;
}

function buildTargetFingerprint(element: Element): PickedTargetFingerprint {
  const textPrefix = redactString((element.textContent || '').trim().slice(0, 160));
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classList: Array.from(element.classList),
    textPrefix: textPrefix || undefined,
  };
}

function doesFingerprintMatch(element: Element, fingerprint: PickedTargetFingerprint): boolean {
  if (fingerprint.tag && element.tagName.toLowerCase() !== fingerprint.tag.toLowerCase()) {
    return false;
  }

  if (fingerprint.id && element.id && fingerprint.id !== element.id) {
    return false;
  }

  if (Array.isArray(fingerprint.classList) && fingerprint.classList.length > 0) {
    const elementClasses = new Set(Array.from(element.classList));
    for (const className of fingerprint.classList) {
      if (!elementClasses.has(className)) return false;
    }
  }

  return true;
}

function createTargetRefFromElement(
  element: Element,
  refId: string = generateRefId(),
  selectorOverride?: string
): PickedTargetRef {
  const selector = selectorOverride || getStableSelector(element) || getFallbackSelector(element);
  return {
    refId,
    selector,
    occurrenceIndex: getOccurrenceIndex(element, selector),
    domPath: getElementDomPath(element),
    fingerprint: buildTargetFingerprint(element),
  };
}

function resolveTargetRefWithReason(ref: PickedTargetRef): { element: Element | null; reason?: string } {
  const domPathCandidate = resolveDomPath(ref.domPath ?? []);
  if (domPathCandidate && doesFingerprintMatch(domPathCandidate, ref.fingerprint)) {
    return { element: domPathCandidate };
  }

  const selectorCandidates = safeQuerySelectorAll(ref.selector);
  if (selectorCandidates.length > 0) {
    const byOccurrence = selectorCandidates[ref.occurrenceIndex];
    if (byOccurrence && doesFingerprintMatch(byOccurrence, ref.fingerprint)) {
      return { element: byOccurrence };
    }

    const byFingerprint = selectorCandidates.find((candidate) => doesFingerprintMatch(candidate, ref.fingerprint));
    if (byFingerprint) {
      return { element: byFingerprint };
    }
  }

  const reasonParts: string[] = [];
  if (!domPathCandidate) {
    reasonParts.push('domPath unresolved');
  } else if (!doesFingerprintMatch(domPathCandidate, ref.fingerprint)) {
    reasonParts.push('domPath fingerprint mismatch');
  }
  if (selectorCandidates.length === 0) {
    reasonParts.push('selector returned 0 matches');
  } else if (!selectorCandidates[ref.occurrenceIndex]) {
    reasonParts.push(`selector occurrence ${ref.occurrenceIndex} missing`);
  } else {
    reasonParts.push('selector candidate fingerprint mismatch');
  }
  return { element: null, reason: reasonParts.join('; ') };
}

function findNearestScrollAncestor(element: Element): Element | null {
  let current = element.parentElement;
  while (current) {
    const computed = window.getComputedStyle(current);
    const overflowY = computed.overflowY;
    const overflowX = computed.overflowX;
    const scrollableY =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      current.scrollHeight > current.clientHeight;
    const scrollableX =
      (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
      current.scrollWidth > current.clientWidth;
    if (scrollableY || scrollableX) return current;
    current = current.parentElement;
  }
  return null;
}

function captureScrollOffsets(element: Element) {
  const scrollOffsets: {
    window: { x: number; y: number };
    nearestScrollAncestor?: { x: number; y: number; selector: string };
  } = {
    window: { x: window.scrollX, y: window.scrollY },
  };

  const scrollAncestor = findNearestScrollAncestor(element);
  if (scrollAncestor) {
    scrollOffsets.nearestScrollAncestor = {
      x: scrollAncestor.scrollLeft,
      y: scrollAncestor.scrollTop,
      selector: getStableSelector(scrollAncestor) || getFallbackSelector(scrollAncestor),
    };
  }

  return scrollOffsets;
}

function captureParentChain(
  element: Element,
  depth = 5,
  includeComputedStyles = false
): ParentChainEntry[] {
  const chain: ParentChainEntry[] = [];
  let current = element.parentElement;
  let level = 0;

  while (current && level < depth) {
    const rect = current.getBoundingClientRect();
    chain.push({
      selector: getStableSelector(current) || getFallbackSelector(current),
      boundingBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      coreStyles: captureCoreStyles(current),
      computedStyles: includeComputedStyles ? captureComputedStyles(current) : undefined,
      scrollSize: {
        scrollWidth: current.scrollWidth,
        scrollHeight: current.scrollHeight,
        clientWidth: current.clientWidth,
        clientHeight: current.clientHeight,
      },
    });
    current = current.parentElement;
    level += 1;
  }

  return chain;
}

function captureAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  const importantAttrs = ['aria-expanded', 'aria-hidden', 'disabled', 'hidden', 'open'];
  for (const attr of element.attributes) {
    if (attr.name.startsWith('data-') || importantAttrs.includes(attr.name)) {
      attrs[attr.name] = attr.value;
    }
  }
  return redactAttributes(attrs);
}

function captureElementState(
  element: Element,
  options: { includeParentComputedStyles?: boolean; startTime?: number } = {}
): ElementState {
  const rect = element.getBoundingClientRect();
  const computed = window.getComputedStyle(element);
  const computedStyles = captureComputedStyles(element);
  const transition = captureTransition(computed);
  const animation = captureAnimation(computed);
  const transformOrigin = computed.getPropertyValue('transform-origin');
  const viewport = captureViewport();
  const scrollOffsets = captureScrollOffsets(element);
  const parentChain = captureParentChain(element, 5, options.includeParentComputedStyles);
  const startTime = options.startTime ?? 0;

  return {
    timestamp: startTime > 0 ? Date.now() - startTime : 0,
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    styles: {
      display: computed.display,
      visibility: computed.visibility,
      opacity: computed.opacity,
      transform: computed.transform,
      position: computed.position,
      zIndex: computed.zIndex,
      overflow: computed.overflow,
      overflowX: computed.overflowX,
      overflowY: computed.overflowY,
    },
    classes: Array.from(element.classList),
    attributes: captureAttributes(element),
    isVisible: isElementVisible(element, rect),
    computedStyles,
    transition,
    animation,
    transformOrigin,
    viewport,
    scrollOffsets,
    parentChain,
    scrollSize: {
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
    },
    textContent: redactString((element.textContent || '').slice(0, 500)),
  };
}

let lastPickedElement: Element | null = null;
let lastPickedElements: Element[] = [];
let lastPickedInfos: PickedElementInfo[] = [];
let lastPickedTargetRefs: PickedTargetRef[] = [];

const glitchPicker: PickerApi = (() => {
  const PICKER_ATTRIBUTE = 'data-glitch-selected';

  interface PickerState {
    active: boolean;
    multiMode: boolean;
    purpose: PickerPurpose;
    pickedElements: PickedElementInfo[];
    pickedElementRefs: Element[];
    pickedTargetRefs: PickedTargetRef[];
    overlay: HTMLDivElement | null;
    label: HTMLDivElement | null;
    lastTarget: Element | null;
    previousCursor: string | null;
    pendingPromise: Promise<PickedTargetRef[]> | null;
    resolve: ((refs: PickedTargetRef[]) => void) | null;
    reject: ((error: Error) => void) | null;
  }

  const state: PickerState = {
    active: false,
    multiMode: false,
    purpose: 'watch',
    pickedElements: [],
    pickedElementRefs: [],
    pickedTargetRefs: [],
    overlay: null,
    label: null,
    lastTarget: null,
    previousCursor: null,
    pendingPromise: null,
    resolve: null,
    reject: null,
  };

  function createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'glitch-element-picker-overlay';
    overlay.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      border: 2px solid #a855f7;
      background: rgba(168, 85, 247, 0.12);
      pointer-events: none;
      box-sizing: border-box;
      display: none;
      border-radius: 2px;
    `;
    return overlay;
  }

  function createLabel(): HTMLDivElement {
    const label = document.createElement('div');
    label.id = 'glitch-element-picker-label';
    label.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      padding: 4px 8px;
      background: #111827;
      color: #f9fafb;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      border-radius: 4px;
      pointer-events: none;
      display: none;
    `;
    return label;
  }

  function getElementInfo(element: Element): PickedElementInfo {
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      testId: element.getAttribute('data-testid') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      classes: Array.from(element.classList),
      selector: getStableSelector(element) || getFallbackSelector(element),
    };
  }

  function clearPreviousSelection() {
    const previous = document.querySelector(`[${PICKER_ATTRIBUTE}="true"]`);
    if (previous) previous.removeAttribute(PICKER_ATTRIBUTE);
  }

  function clearMultiSelection() {
    document.querySelectorAll(`[${PICKER_ATTRIBUTE}="true"]`).forEach((node) => {
      node.removeAttribute(PICKER_ATTRIBUTE);
    });
  }

  function updateOverlay(target: Element) {
    if (!state.overlay || !state.label) return;
    const rect = target.getBoundingClientRect();

    state.overlay.style.display = 'block';
    state.overlay.style.top = `${rect.top}px`;
    state.overlay.style.left = `${rect.left}px`;
    state.overlay.style.width = `${rect.width}px`;
    state.overlay.style.height = `${rect.height}px`;

    state.label.textContent = `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}`;
    state.label.style.display = 'block';
    state.label.style.top = `${Math.max(0, rect.top - 22)}px`;
    state.label.style.left = `${Math.max(0, rect.left)}px`;
  }

  function teardown() {
    if (!state.active) return;

    state.active = false;
    state.multiMode = false;
    state.purpose = 'watch';
    state.pickedElements = [];
    state.pickedElementRefs = [];
    state.pickedTargetRefs = [];

    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('click', handleClick, true);
    window.removeEventListener('keydown', handleKeydown, true);

    state.overlay?.remove();
    state.label?.remove();
    state.overlay = null;
    state.label = null;
    state.lastTarget = null;
    document.body.style.cursor = state.previousCursor || '';
    state.previousCursor = null;
  }

  function settle(resolveWith: PickedTargetRef[] | null, errorMessage: string | null = null) {
    const resolve = state.resolve;
    const reject = state.reject;
    state.resolve = null;
    state.reject = null;
    state.pendingPromise = null;
    teardown();

    if (resolveWith) {
      resolve?.(resolveWith);
      return;
    }
    reject?.(new Error(errorMessage || 'Picker cancelled'));
  }

  function handleMouseMove(event: MouseEvent) {
    if (!state.active) return;
    const target = event.target as Element | null;
    if (!target || target === state.overlay || target === state.label) return;
    if (state.lastTarget === target) return;
    state.lastTarget = target;
    updateOverlay(target);
  }

  function handleClick(event: MouseEvent) {
    if (!state.active) return;
    event.preventDefault();
    event.stopPropagation();

    const target = event.target as Element | null;
    if (!target) return;

    const info = getElementInfo(target);
    const targetRef = createTargetRefFromElement(target);

    if (state.multiMode) {
      if (state.pickedElementRefs.includes(target)) return;
      state.pickedElements.push(info);
      state.pickedElementRefs.push(target);
      state.pickedTargetRefs.push(targetRef);
      target.setAttribute(PICKER_ATTRIBUTE, 'true');
      if (state.label) {
        state.label.textContent = `${state.pickedTargetRefs.length} selected • press Enter in terminal to finish`;
        state.label.style.display = 'block';
      }
      return;
    }

    clearPreviousSelection();
    target.setAttribute(PICKER_ATTRIBUTE, 'true');

    if (state.purpose !== 'prompt') {
      lastPickedElement = target;
      lastPickedElements = [target];
      lastPickedInfos = [info];
      lastPickedTargetRefs = [targetRef];
    }

    settle([targetRef]);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!state.active) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      settle(null, 'Picker cancelled');
      return;
    }

  }

  function start(multi = false, purpose: PickerPurpose = 'watch'): Promise<PickedTargetRef[]> {
    if (state.active && state.pendingPromise) return state.pendingPromise;

    state.active = true;
    state.multiMode = multi;
    state.purpose = purpose;
    state.pickedElements = [];
    state.pickedElementRefs = [];
    state.pickedTargetRefs = [];
    if (multi) clearMultiSelection();

    state.overlay = createOverlay();
    state.label = createLabel();
    document.documentElement.appendChild(state.overlay);
    document.documentElement.appendChild(state.label);

    state.previousCursor = document.body.style.cursor || null;
    document.body.style.cursor = 'crosshair';

    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleKeydown, true);

    state.pendingPromise = new Promise<PickedTargetRef[]>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });

    if (multi && state.label) {
      state.label.textContent = '0 selected • press Enter in terminal to finish';
      state.label.style.display = 'block';
      state.label.style.top = '8px';
      state.label.style.left = '8px';
    }

    return state.pendingPromise;
  }

  function finishMulti(): PickedTargetRef[] {
    if (!state.active || !state.multiMode) return [];
    const refs = [...state.pickedTargetRefs];
    if (refs.length === 0) {
      settle(null, 'No elements selected');
      return [];
    }

    if (state.purpose !== 'prompt') {
      lastPickedElements = [...state.pickedElementRefs];
      lastPickedInfos = [...state.pickedElements];
      lastPickedTargetRefs = refs;
      lastPickedElement = state.pickedElementRefs[0] || null;
    }

    settle(refs);
    return refs;
  }

  function getSelection(): PickedTargetRef[] {
    return [...state.pickedTargetRefs];
  }

  function synthesizeRefsFromSelectors(selectors: string[]): PickedTargetRef[] {
    const selectorUseCount = new Map<string, number>();

    return selectors.map((rawSelector, index) => {
      const selector = rawSelector.trim();
      if (!selector) {
        throw new Error(`Selector at index ${index} is empty.`);
      }

      const matches = safeQuerySelectorAll(selector);
      const useCount = selectorUseCount.get(selector) ?? 0;
      const element = matches[useCount];
      if (!element) {
        const suffix = useCount > 0 ? ` (occurrence ${useCount})` : '';
        throw new Error(`Element not found for selector: ${selector}${suffix}`);
      }
      selectorUseCount.set(selector, useCount + 1);

      const targetRef = createTargetRefFromElement(element, `selector_${index}_${generateRefId()}`, selector);
      targetRef.occurrenceIndex = useCount;
      return targetRef;
    });
  }

  function resolveTargetRef(ref: PickedTargetRef): Element | null {
    return resolveTargetRefWithReason(ref).element;
  }

  function explainUnresolvedRef(ref: PickedTargetRef): string {
    const resolved = resolveTargetRefWithReason(ref);
    return resolved.reason || 'Target ref could not be resolved.';
  }

  function stop() {
    if (!state.active) return;
    settle(null, 'Picker stopped');
  }

  return {
    start,
    stop,
    finishMulti,
    getSelection,
    synthesizeRefsFromSelectors,
    resolveTargetRef,
    explainUnresolvedRef,
  };
})();

const glitchWatcher: WatcherApi = (() => {
  interface WatchedElementEntry {
    element: Element;
    selector: string;
    targetRef: PickedTargetRef;
    initialState: ElementState | null;
    fullStyles: Record<string, string>;
    stateDeltas: ReturnType<typeof computeStateDelta>[];
    lastCapturedState: string;
    lastState: ElementState | null;
  }

  interface WatcherState {
    isWatching: boolean;
    watchedElement: Element | null;
    watchedSelector: string | null;
    initialState: ElementState | null;
    fullStyles: Record<string, string> | null;
    stateDeltas: ReturnType<typeof computeStateDelta>[];
    watchedElements: WatchedElementEntry[];
    interactions: Interaction[];
    startTime: number;
    lastSampleTime: number;
    rafId: number | null;
    mutationObserver: MutationObserver | null;
    lastCapturedState: string;
    lastState: ElementState | null;
  }

  const state: WatcherState = {
    isWatching: false,
    watchedElement: null,
    watchedSelector: null,
    initialState: null,
    fullStyles: null,
    stateDeltas: [],
    watchedElements: [],
    interactions: [],
    startTime: 0,
    lastSampleTime: 0,
    rafId: null,
    mutationObserver: null,
    lastCapturedState: '',
    lastState: null,
  };

  let watchIndicators: Array<{ element: Element; node: HTMLDivElement }> = [];
  let scrollTimeout: number | null = null;
  const SAMPLE_INTERVAL_MS = 1000 / 30;

  function stripComputedStyles(snapshot: ElementState): ElementState {
    const next = { ...snapshot };
    delete next.computedStyles;
    return next;
  }

  function getStateFingerprint(currentState: ElementState): string {
    const visualStyles = currentState.computedStyles
      ? {
          color: currentState.computedStyles.color,
          backgroundColor: currentState.computedStyles['background-color'],
          boxShadow: currentState.computedStyles['box-shadow'],
          filter: currentState.computedStyles.filter,
          borderColor: currentState.computedStyles['border-color'],
          borderWidth: currentState.computedStyles['border-width'],
          outlineColor: currentState.computedStyles['outline-color'],
          outlineWidth: currentState.computedStyles['outline-width'],
          fontSize: currentState.computedStyles['font-size'],
          lineHeight: currentState.computedStyles['line-height'],
        }
      : {};

    const { timestamp: _timestamp, computedStyles: _computed, parentChain: _parents, ...rest } = currentState;
    return JSON.stringify({ ...rest, visualStyles });
  }

  function recordStateDelta(entry: WatchedElementEntry, currentState: ElementState) {
    const fingerprint = getStateFingerprint(currentState);
    if (fingerprint === entry.lastCapturedState) return;

    const previousState = entry.lastState ?? currentState;
    const delta = computeStateDelta(
      previousState as unknown as Record<string, unknown>,
      currentState as unknown as Record<string, unknown>
    );

    entry.lastCapturedState = fingerprint;
    entry.lastState = currentState;
    if (Object.keys(delta.delta).length === 0) return;

    entry.stateDeltas.push(delta);
    if (entry.element === state.watchedElement) {
      state.stateDeltas = entry.stateDeltas;
      state.lastCapturedState = fingerprint;
      state.lastState = currentState;
    }
  }

  function trackPositionChanges() {
    if (!state.isWatching || state.watchedElements.length === 0) return;

    const now = performance.now();
    if (now - state.lastSampleTime >= SAMPLE_INTERVAL_MS) {
      state.lastSampleTime = now;
      state.watchedElements.forEach((entry) => {
        const currentState = captureElementState(entry.element, { startTime: state.startTime });
        recordStateDelta(entry, currentState);
      });
    }

    state.rafId = requestAnimationFrame(trackPositionChanges);
  }

  function startMutationObserver() {
    state.mutationObserver = new MutationObserver((mutations) => {
      if (!state.isWatching || state.watchedElements.length === 0) return;

      for (const mutation of mutations) {
        for (const entry of state.watchedElements) {
          if (mutation.target === entry.element || entry.element.contains(mutation.target as Node)) {
            const currentState = captureElementState(entry.element, { startTime: state.startTime });
            recordStateDelta(entry, currentState);
            break;
          }
        }
      }
    });

    state.mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-state', 'aria-expanded', 'aria-hidden', 'hidden', 'disabled'],
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function trackInteraction(event: Event) {
    if (!state.isWatching) return;

    const target = event.target as Element | null;
    if (!target) return;

    const watchedEntry = state.watchedElements.find(
      (entry) => target === entry.element || entry.element.contains(target)
    );
    const isWatchedElement = Boolean(watchedEntry);

    const interaction: Interaction = {
      type: event.type,
      timestamp: Date.now() - state.startTime,
      target: {
        selector: generateSelector(target),
        tag: target.tagName.toLowerCase(),
        isWatchedElement,
        targetRefId: watchedEntry?.targetRef.refId,
      },
    };

    if (event instanceof MouseEvent) {
      interaction.coordinates = { x: event.clientX, y: event.clientY };
    }
    state.interactions.push(interaction);

    if (state.watchedElements.length > 0) {
      setTimeout(() => {
        if (!state.isWatching) return;
        state.watchedElements.forEach((entry) => {
          const currentState = captureElementState(entry.element, { startTime: state.startTime });
          recordStateDelta(entry, currentState);
        });
      }, 0);
    }
  }

  function trackScroll(event: Event) {
    if (!state.isWatching) return;
    if (scrollTimeout) clearTimeout(scrollTimeout);

    scrollTimeout = window.setTimeout(() => {
      const target = event.target as EventTarget | null;
      const isDocument = target === document;
      const targetElement = target instanceof Element ? target : null;
      if (!isDocument && !targetElement) return;

      state.interactions.push({
        type: 'scroll',
        timestamp: Date.now() - state.startTime,
        target: {
          selector: isDocument ? 'document' : generateSelector(targetElement),
          tag: isDocument ? 'document' : targetElement.tagName.toLowerCase(),
          isWatchedElement: !isDocument
            ? state.watchedElements.some(
                (entry) => targetElement === entry.element || entry.element.contains(targetElement)
              )
            : false,
        },
      });

      state.watchedElements.forEach((entry) => {
        const currentState = captureElementState(entry.element, { startTime: state.startTime });
        recordStateDelta(entry, currentState);
      });
    }, 100);
  }

  function trackResize() {
    if (!state.isWatching) return;

    state.interactions.push({
      type: 'resize',
      timestamp: Date.now() - state.startTime,
      target: { selector: 'window', tag: 'window', isWatchedElement: false },
    });

    state.watchedElements.forEach((entry) => {
      const currentState = captureElementState(entry.element, { startTime: state.startTime });
      recordStateDelta(entry, currentState);
    });
  }

  function startInteractionTracking() {
    document.addEventListener('click', trackInteraction, true);
    document.addEventListener('scroll', trackScroll, true);
    document.addEventListener('input', trackInteraction, true);
    document.addEventListener('change', trackInteraction, true);
    window.addEventListener('resize', trackResize, true);
  }

  function stopInteractionTracking() {
    document.removeEventListener('click', trackInteraction, true);
    document.removeEventListener('scroll', trackScroll, true);
    document.removeEventListener('input', trackInteraction, true);
    document.removeEventListener('change', trackInteraction, true);
    window.removeEventListener('resize', trackResize, true);
  }

  function addWatchIndicators(entries: WatchedElementEntry[]) {
    removeWatchIndicators();

    watchIndicators = entries.map((entry, index) => {
      const rect = entry.element.getBoundingClientRect();
      const indicator = document.createElement('div');
      indicator.id = `glitch-watch-indicator-${index}`;
      indicator.style.cssText = `
        position: fixed;
        z-index: 2147483646;
        border: 2px dashed #f97316;
        background: transparent;
        pointer-events: none;
        box-sizing: border-box;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
      `;

      const badge = document.createElement('div');
      badge.style.cssText = `
        position: absolute;
        top: -24px;
        left: 0;
        background: #f97316;
        color: white;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 3px;
        font-family: sans-serif;
        font-weight: 600;
      `;
      badge.textContent = entries.length > 1 ? `WATCHING #${index + 1}` : 'WATCHING';
      indicator.appendChild(badge);

      document.documentElement.appendChild(indicator);
      return { element: entry.element, node: indicator };
    });

    const updatePosition = () => {
      if (!state.isWatching || watchIndicators.length === 0) return;
      watchIndicators.forEach(({ element, node }) => {
        if (!document.contains(element)) return;
        const rect = element.getBoundingClientRect();
        node.style.top = `${rect.top}px`;
        node.style.left = `${rect.left}px`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
      });
      requestAnimationFrame(updatePosition);
    };
    requestAnimationFrame(updatePosition);
  }

  function removeWatchIndicators() {
    watchIndicators.forEach(({ node }) => node.remove());
    watchIndicators = [];
  }

  function normalizeTargetRefs(input: PickedTargetRef[] | string[]): PickedTargetRef[] {
    if (!Array.isArray(input) || input.length === 0) return [];

    if (typeof input[0] === 'string') {
      return glitchPicker.synthesizeRefsFromSelectors(input as string[]);
    }

    return (input as PickedTargetRef[]).map((ref) => ({
      refId: typeof ref.refId === 'string' && ref.refId.trim() ? ref.refId : generateRefId(),
      selector: typeof ref.selector === 'string' ? ref.selector : '',
      occurrenceIndex: Number.isFinite(ref.occurrenceIndex) && ref.occurrenceIndex >= 0
        ? Math.floor(ref.occurrenceIndex)
        : 0,
      domPath: Array.isArray(ref.domPath)
        ? ref.domPath.filter((part): part is number => Number.isInteger(part) && part >= 0)
        : [],
      fingerprint: {
        tag: ref.fingerprint?.tag || 'element',
        id: ref.fingerprint?.id,
        classList: Array.isArray(ref.fingerprint?.classList) ? ref.fingerprint.classList : [],
        textPrefix: ref.fingerprint?.textPrefix,
      },
    }));
  }

  function start(targetRefsInput: PickedTargetRef[] | string[]) {
    const targetRefs = normalizeTargetRefs(targetRefsInput);
    if (targetRefs.length === 0) {
      throw new Error('No target refs provided for watcher');
    }

    if (state.isWatching) {
      stop();
    }

    const entries: WatchedElementEntry[] = [];
    const unresolved: string[] = [];

    targetRefs.forEach((targetRef) => {
      const resolved = resolveTargetRefWithReason(targetRef);
      if (!resolved.element) {
        unresolved.push(`${targetRef.refId} (${resolved.reason || 'unresolved'})`);
        return;
      }
      entries.push({
        element: resolved.element,
        selector: targetRef.selector || generateSelector(resolved.element),
        targetRef,
        initialState: null,
        fullStyles: {},
        stateDeltas: [],
        lastCapturedState: '',
        lastState: null,
      });
    });

    if (entries.length === 0) {
      throw new Error(
        unresolved.length > 0
          ? `No elements found for provided target refs: ${unresolved.join(', ')}`
          : 'No elements found for provided target refs'
      );
    }

    if (unresolved.length > 0) {
      throw new Error(`Some target refs could not be resolved: ${unresolved.join(', ')}`);
    }

    state.isWatching = true;
    state.watchedElements = entries;
    state.watchedElement = entries[0].element;
    state.watchedSelector = entries[0].selector;
    state.startTime = Date.now();
    state.lastSampleTime = performance.now();
    state.stateDeltas = [];
    state.interactions = [];
    state.fullStyles = null;
    state.lastState = null;

    entries.forEach((entry) => {
      const fullState = captureElementState(entry.element, {
        includeParentComputedStyles: true,
        startTime: state.startTime,
      });
      entry.fullStyles = fullState.computedStyles
        ? { ...fullState.computedStyles }
        : captureComputedStyles(entry.element);
      entry.initialState = stripComputedStyles(fullState);
      entry.lastState = fullState;
      entry.lastCapturedState = getStateFingerprint(fullState);
    });

    state.initialState = entries[0].initialState;
    state.fullStyles = entries[0].fullStyles;
    state.stateDeltas = entries[0].stateDeltas;
    state.lastCapturedState = entries[0].lastCapturedState;
    state.lastState = entries[0].lastState;

    trackPositionChanges();
    startMutationObserver();
    startInteractionTracking();
    addWatchIndicators(entries);

    return {
      selector: entries[0].selector,
      selectors: entries.map((entry) => entry.selector),
      watchedCount: entries.length,
      targetRefs: entries.map((entry) => entry.targetRef),
    };
  }

  function stop(): WatcherResult {
    const watchedElements: ElementRecordingState[] = state.watchedElements.map((entry) => ({
      selector: entry.selector,
      targetRef: entry.targetRef,
      initialState: entry.initialState,
      fullStyles: entry.fullStyles,
      stateDeltas: [...entry.stateDeltas],
    }));

    const primary = watchedElements[0];
    const result: WatcherResult = {
      selector: primary?.selector ?? state.watchedSelector,
      initialState: primary?.initialState ?? state.initialState,
      fullStyles: primary?.fullStyles ?? state.fullStyles,
      stateDeltas: primary?.stateDeltas ?? [...state.stateDeltas],
      watchedElements,
      interactions: [...state.interactions],
      duration: state.startTime > 0 ? Date.now() - state.startTime : 0,
    };

    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.mutationObserver) state.mutationObserver.disconnect();
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }
    stopInteractionTracking();
    removeWatchIndicators();

    state.isWatching = false;
    state.watchedElement = null;
    state.watchedSelector = null;
    state.initialState = null;
    state.lastSampleTime = 0;
    state.rafId = null;
    state.mutationObserver = null;
    state.stateDeltas = [];
    state.fullStyles = null;
    state.lastCapturedState = '';
    state.lastState = null;
    state.watchedElements = [];
    state.interactions = [];
    state.startTime = 0;

    return result;
  }

  function getStatus(): WatcherStatus {
    return {
      isWatching: state.isWatching,
      selector: state.watchedSelector,
      selectors: state.watchedElements.map((entry) => entry.selector),
      watchedCount: state.watchedElements.length,
      interactionCount: state.interactions.length,
      stateChangeCount: state.stateDeltas.length,
    };
  }

  return { start, stop, getStatus };
})();

window.__glitchCapture = {
  captureElementState: (element: Element, options?: { includeParentComputedStyles?: boolean }) =>
    captureElementState(element, {
      includeParentComputedStyles: options?.includeParentComputedStyles,
      startTime: 0,
    }),
  captureViewport,
};

window.__glitchPicker = glitchPicker;
window.__glitchWatcher = glitchWatcher;
