/**
 * Context Pack Type Definitions
 * Complete type definitions for all phases including Phase 5 advanced features
 */

import type { BugPattern } from '../lib/analysis/patterns';
import type { FrameworkContext } from '../lib/framework/detector';
export type { BugPattern };

/**
 * Core Context Pack structure (Phase 1-3)
 */
/** Single target (element) capture for context pack */
export interface ContextPackTarget {
  selectors: ElementSelectors;
  dom: DOMCapture;
  styles: StyleCapture;
  layout: LayoutCapture;
}

export interface ContextPack {
  version: string;
  timestamp: string;
  url: string;

  target: ContextPackTarget;

  /** Multiple elements in one pack (when capturing multiple) */
  targets?: ContextPackTarget[];

  meta: {
    userAgent: string;
    viewport: {
      width: number;
      height: number;
    };
    devicePixelRatio: number;
    recordingMethod?: string;
  };

  // Phase 2: Interaction trace
  interactionTrace?: InteractionTrace;

  // Phase 4+: Recorder-based flows (Chrome DevTools Recorder)
  recording?: RecordingContext;

  // Phase 5: Framework detection
  framework?: FrameworkContext;

  // Phase 5: Bug patterns
  detectedBugPatterns?: BugPattern[];

  // Prompt-attached snapshot (optional)
  prompt?: PromptBlock;
}

/**
 * Element selectors (Phase 1)
 */
export interface ElementSelectors {
  css: string;
  xpath: string;
  testId?: string;
  id?: string;
  uniqueSelector: string;
}

/**
 * DOM capture (Phase 1)
 */
export interface DOMCapture {
  tag: string;
  outerHTML: string;
  innerHTML: string;
  textContent: string;
  attributes: Record<string, string>;
  ancestors: Array<{
    tag: string;
    classes: string[];
    id?: string;
    position: number;
  }>;
  children: {
    count: number;
    summary: string[];
  };
}

/**
 * Style capture (Phase 1)
 */
export interface StyleCapture {
  computed: Record<string, string>;
  inline: Record<string, string> | string;
  inherited?: Array<{
    property: string;
    value: string;
    source: string;
  }>;
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

/**
 * Layout capture (Phase 1)
 */
export interface LayoutCapture {
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
  boxModel: {
    margin: BoxEdges;
    border: BoxEdges;
    padding: BoxEdges;
    content: { width: number; height: number };
  };
  overflow: {
    self: { x: boolean; y: boolean };
    parent: { x: boolean; y: boolean };
    clippedBy?: string;
  };
  stackingContext: {
    zIndex: number | 'auto';
    createsContext: boolean;
    ancestors: Array<{
      selector: string;
      zIndex: number | 'auto';
    }>;
  };
  scrollPosition: {
    x: number;
    y: number;
  };
  viewport?: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
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
  parentChain?: CoreParentChainEntry[];
}

export interface BoxEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// Core parent chain entry (minimal set)
export interface CoreParentChainEntry {
  selector: string;
  boundingBox: LayoutCapture['boundingBox'];
  coreStyles: Record<string, string>;
  scrollSize?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
}

// State delta representation for recorder exports
export interface StateDelta {
  timestamp: number;
  delta: Record<string, any>;
}

// Minimal element capture for non-watched elements
export interface MinimalElementCapture {
  selector: string;
  tag: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  classes: string[];
  isVisible: boolean;
}

export type BugType =
  | 'animation'
  | 'layout-shift'
  | 'z-index'
  | 'visibility'
  | 'overflow'
  | 'other';

/**
 * Interaction trace (Phase 2)
 */
export interface InteractionTrace {
  duration: number;
  events: CapturedEvent[];
  layoutShifts: LayoutShiftEntry[];
  timeline: TimelineSegment[];
  detectedIssues: string[];
}

/**
 * Recorder-based interaction summary
 */
export interface RecordingContext {
  title?: string;
  duration?: number;
  totalSteps?: number;
  steps?: RecordingStep[];
}

export interface RecordingStep {
  type: string;
  timestamp?: number;
  target?: {
    selector: string;
    coordinates?: { x: number; y: number };
  };
  properties?: Record<string, any>;
}

export interface CapturedEvent {
  type: string;
  timestamp: number;
  target: {
    selector: string;
    tag: string;
    textContent?: string;
  };
  details: Record<string, any>;
}

export interface LayoutShiftEntry {
  timestamp: number;
  value: number;
  sources: Array<{
    node: string;
    previousRect: DOMRect;
    currentRect: DOMRect;
  }>;
  hadRecentInput: boolean;
}

export interface TimelineSegment {
  startTime: number;
  endTime: number;
  type: 'stable' | 'transition' | 'event';
  changes?: Array<{
    property: string;
    from: any;
    to: any;
  }>;
  events?: CapturedEvent[];
  layoutShifts?: LayoutShiftEntry[];
}

/**
 * Element snapshot for regression testing (Phase 5)
 */
export interface ElementSnapshot {
  timestamp: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  styles: Record<string, any>;
}

/**
 * Prompt generation options (Phase 3)
 */
export interface PromptOptions {
  style: 'concise' | 'detailed' | 'diagnostic';
  includeCode: boolean;
  targetAI?: 'cursor' | 'claude' | 'copilot' | 'chatgpt';
  framework?: string;
  requestType: 'diagnosis' | 'fix' | 'explanation';
}

/**
 * Prompt tagging (Snapshot + Prompt)
 */
export interface PromptTag {
  alias: string;
  selector: string;
  name: string;
  targetIndex: number;
  ref: string;
  target: any;
}

export interface PromptBlock {
  raw: string;
  resolved: string;
  tags: Record<string, PromptTag>;
}

/**
 * Export formats (Phase 3-4)
 */
export type ExportFormat = 'json' | 'markdown' | 'html' | 'pdf';

export interface ExportOptions {
  format: ExportFormat;
  includeScreenshot?: boolean;
  includeTimeline?: boolean;
  includeCode?: boolean;
}

/**
 * Chrome extension specific types
 */
export interface ChromeMessage {
  type: string;
  payload?: any;
}

export interface DevToolsContext {
  tabId: number;
  inspectedWindow: typeof chrome.devtools.inspectedWindow;
}

/**
 * Error types
 */
export interface GlitchError {
  code: string;
  message: string;
  context?: any;
}

/**
 * Settings and configuration
 */
export interface GlitchSettings {
  defaultTargetAI: string;
  defaultFramework: string;
  autoIncludeCode: boolean;
  theme: 'light' | 'dark' | 'auto';
  enableKeyboardShortcuts: boolean;
  
  // Phase 5: Advanced settings
  enableFrameworkDetection: boolean;
  enableBugPatternAnalysis: boolean;
  enableAIAssistant: boolean;
  enableCloudSync: boolean;
  enableRegressionTesting: boolean;
  enableTicketIntegration: boolean;
}

/**
 * Storage keys for persistence
 */
export const STORAGE_KEYS = {
  SETTINGS: 'glitch-settings',
  API_KEY: 'glitch-api-key',
  USER_ID: 'glitch-user-id',
  TEAM_ID: 'glitch-team-id',
  LAST_SYNC: 'glitch-last-sync',
  ONBOARDING_COMPLETE: 'glitch-onboarding-complete',
  RECENT_PACKS: 'glitch-recent-packs',
  REGRESSION_TESTS: 'glitch-regression-tests',
} as const;

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: GlitchSettings = {
  defaultTargetAI: 'cursor',
  defaultFramework: 'react',
  autoIncludeCode: true,
  theme: 'auto',
  enableKeyboardShortcuts: true,
  enableFrameworkDetection: true,
  enableBugPatternAnalysis: true,
  enableAIAssistant: false, // Requires API key
  enableCloudSync: false, // Requires setup
  enableRegressionTesting: true,
  enableTicketIntegration: false, // Requires setup
};

/**
 * Validation schemas (for runtime validation with Zod)
 */
export const CONTEXT_PACK_VERSION = '1.0';

/**
 * Utility types
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

/**
 * Helper function to create a new Context Pack
 */
export function createContextPack(
  target: ContextPack['target'],
  meta: ContextPack['meta'],
  options?: {
    interactionTrace?: InteractionTrace;
    framework?: FrameworkContext;
    detectedBugPatterns?: BugPattern[];
  }
): ContextPack {
  return {
    version: CONTEXT_PACK_VERSION,
    timestamp: new Date().toISOString(),
    url: window.location.href,
    target,
    meta,
    ...options,
  };
}

/**
 * Type guards
 */
export function isContextPack(obj: any): obj is ContextPack {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'version' in obj &&
    'timestamp' in obj &&
    'url' in obj &&
    'target' in obj &&
    'meta' in obj
  );
}

export function hasInteractionTrace(pack: ContextPack): pack is ContextPack & { interactionTrace: InteractionTrace } {
  return pack.interactionTrace !== undefined;
}

export function hasFrameworkInfo(pack: ContextPack): pack is ContextPack & { framework: FrameworkContext } {
  return pack.framework !== undefined && pack.framework.name !== 'unknown';
}

export function hasBugPatterns(pack: ContextPack): pack is ContextPack & { detectedBugPatterns: BugPattern[] } {
  return pack.detectedBugPatterns !== undefined && pack.detectedBugPatterns.length > 0;
}
