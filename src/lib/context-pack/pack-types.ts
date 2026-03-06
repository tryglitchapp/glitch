import type { BugPattern } from '../analysis/patterns';
import type { BugType as ContextBugType } from '../../types/context-pack';

export type BugType = ContextBugType;

export interface PackManifest {
  id: string;
  version: string;
  timestamp: string;
  source: 'snapshot' | 'recorder';
  bugType?: BugType;
  bugDescription?: string;
  redactionPolicyVersion?: string;
  url: string;
  watchedElements: Array<{
    id: string;
    selector: string;
    dir: string;
    targetRefId?: string;
  }>;
  stats: {
    totalStateChanges: number;
    propertiesChanged: string[];
    duration?: number;
  };
}

export interface PickedTargetFingerprint {
  tag: string;
  id?: string;
  classList: string[];
  textPrefix?: string;
}

export interface PickedTargetRef {
  refId: string;
  selector: string;
  occurrenceIndex: number;
  domPath: number[];
  fingerprint: PickedTargetFingerprint;
}

export interface PackSummary {
  detectedBugPatterns: BugPattern[];
  keyFindings: string[];
  recommendedMCPQueries: string[];
}

export interface PackFile {
  path: string;
  contents: string;
}

export interface ElementCore {
  selector: string;
  tag: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  classes: string[];
  isVisible: boolean;
}

export interface FullStyles {
  computedStyles: Record<string, string>;
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
}

export interface StateDelta {
  timestamp: number;
  delta: Record<string, any>;
}

export interface MinimalParentChainEntry {
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
  coreStyles: Record<string, string>;
  scrollSize?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
}

export interface DirectoryPackElement {
  id: string;
  selector: string;
  tag: string;
  dir: string;
  targetRef?: PickedTargetRef;
  core: ElementCore;
  fullStyles: FullStyles;
  stateDeltas: StateDelta[];
  parents: MinimalParentChainEntry[];
  parentsFull?: ParentChainEntry[];
}

export interface DirectoryPack {
  id: string;
  manifest: PackManifest;
  summary: PackSummary;
  prompt: string;
  interactions: Interaction[];
  viewport: ViewportState | null;
  watchedElements: DirectoryPackElement[];
  contextElements: ElementCore[];
}

export interface DirectoryPackOptions {
  packId?: string;
  timestamp?: string;
  source?: 'snapshot' | 'recorder';
  bugType?: BugType;
  bugDescription?: string;
  url?: string;
  prompt?: string;
  contextElements?: ElementCore[];
}

export interface ElementState {
  timestamp: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  classes: string[];
  isVisible: boolean;
  attributes?: Record<string, string>;
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
  viewport?: { width: number; height: number; devicePixelRatio: number };
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

export interface ParentChainEntry {
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

export interface Interaction {
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

export interface RecordingResult {
  selector: string;
  initialState: ElementState;
  fullStyles?: Record<string, string>;
  stateDeltas?: StateDelta[];
  stateHistory?: ElementState[];
  watchedElements?: Array<{
    selector: string;
    targetRef?: PickedTargetRef;
    initialState: ElementState;
    fullStyles?: Record<string, string>;
    stateDeltas?: StateDelta[];
    stateHistory?: ElementState[];
  }>;
  interactions: Interaction[];
  duration: number;
}

export interface ViewportState {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollOffsets?: {
    window: { x: number; y: number };
    nearestScrollAncestor?: { x: number; y: number; selector: string };
  };
  scrollSize?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
}
