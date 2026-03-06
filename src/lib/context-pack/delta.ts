/**
 * State Delta Utilities
 * Compute deltas between element states and reconstruct full state at a timestamp.
 */

import type { StateDelta } from '../../types/context-pack';

type UnknownRecord = Record<string, any>;

const IGNORED_KEYS = new Set<string>(['timestamp', 'parentChain']);

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!valuesEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function diffValues(prev: unknown, current: unknown, path: string, out: UnknownRecord) {
  if (valuesEqual(prev, current)) return;

  if (Array.isArray(prev) || Array.isArray(current)) {
    out[path] = current;
    return;
  }

  if (!isPlainObject(prev) || !isPlainObject(current)) {
    out[path] = current;
    return;
  }

  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(current)]);
  keys.forEach((key) => {
    if (IGNORED_KEYS.has(key)) return;
    const nextPath = path ? `${path}.${key}` : key;
    const prevValue = (prev as UnknownRecord)[key];
    const currentValue = (current as UnknownRecord)[key];

    if (typeof currentValue === 'undefined' && typeof prevValue === 'undefined') return;

    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      out[nextPath] = null;
      return;
    }

    diffValues(prevValue, currentValue, nextPath, out);
  });
}

/**
 * Compute a delta between two element states.
 */
export function computeStateDelta(prevState: UnknownRecord, currentState: UnknownRecord): StateDelta {
  const delta: UnknownRecord = {};
  diffValues(prevState, currentState, '', delta);

  const timestampValue =
    typeof currentState?.timestamp === 'number' ? currentState.timestamp : Date.now();

  return {
    timestamp: timestampValue,
    delta,
  };
}

function setDeepValue(target: UnknownRecord, path: string, value: any) {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let current: UnknownRecord = target;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const existing = current[key];
    if (!isPlainObject(existing)) {
      current[key] = {};
    }
    current = current[key];
  }

  current[parts[parts.length - 1]] = value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Reconstruct a full state at a specific timestamp using initial state + deltas.
 */
export function reconstructState<T extends UnknownRecord>(
  initialState: T,
  deltas: StateDelta[],
  targetTimestamp?: number
): T {
  const reconstructed = deepClone(initialState);
  const sorted = [...deltas].sort((a, b) => a.timestamp - b.timestamp);

  for (const entry of sorted) {
    if (typeof targetTimestamp === 'number' && entry.timestamp > targetTimestamp) {
      break;
    }
    Object.entries(entry.delta).forEach(([path, value]) => {
      setDeepValue(reconstructed, path, value);
    });
  }

  return reconstructed;
}
