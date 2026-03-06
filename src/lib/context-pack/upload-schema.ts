import { z } from 'zod';

const MAX_WATCHED_ELEMENTS = 64;
const MAX_STATE_DELTAS_PER_ELEMENT = 50_000;
const MAX_INTERACTIONS = 50_000;
const MAX_SUMMARY_STRINGS = 2_000;
const SAFE_DIR_PATTERN = /^watched\/[a-z0-9._/-]+$/i;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;

const BoundedNumberSchema = z.number().finite().min(-10_000_000).max(10_000_000);

const BoundingBoxSchema = z
  .object({
    x: BoundedNumberSchema,
    y: BoundedNumberSchema,
    width: BoundedNumberSchema,
    height: BoundedNumberSchema,
  })
  .strict();

const ElementCoreSchema = z
  .object({
    selector: z.string().min(1).max(2048),
    tag: z.string().min(1).max(128),
    boundingBox: BoundingBoxSchema,
    classes: z.array(z.string().max(256)).max(512),
    isVisible: z.boolean(),
  })
  .strict();

const FullStylesSchema = z
  .object({
    computedStyles: z.record(z.string().max(4096)).default({}),
    transition: z
      .object({
        transition: z.string().max(4096),
        transitionProperty: z.string().max(4096),
        transitionDuration: z.string().max(1024),
        transitionTimingFunction: z.string().max(1024),
        transitionDelay: z.string().max(1024),
      })
      .strict()
      .optional(),
    animation: z
      .object({
        animationName: z.string().max(2048),
        animationDuration: z.string().max(1024),
        animationTimingFunction: z.string().max(1024),
        animationDelay: z.string().max(1024),
        animationIterationCount: z.string().max(256),
        animationPlayState: z.string().max(256),
      })
      .strict()
      .optional(),
    transformOrigin: z.string().max(1024).optional(),
  })
  .strict();

const StateDeltaSchema = z
  .object({
    timestamp: z.number().finite().min(0).max(31_536_000_000),
    delta: z.record(z.unknown()),
  })
  .strict();

const ParentEntrySchema = z
  .object({
    selector: z.string().min(1).max(2048),
    boundingBox: z
      .object({
        x: BoundedNumberSchema,
        y: BoundedNumberSchema,
        width: BoundedNumberSchema,
        height: BoundedNumberSchema,
        top: BoundedNumberSchema,
        right: BoundedNumberSchema,
        bottom: BoundedNumberSchema,
        left: BoundedNumberSchema,
      })
      .strict(),
    coreStyles: z.record(z.string().max(4096)).default({}),
    computedStyles: z.record(z.string().max(4096)).optional(),
    scrollSize: z
      .object({
        scrollWidth: BoundedNumberSchema,
        scrollHeight: BoundedNumberSchema,
        clientWidth: BoundedNumberSchema,
        clientHeight: BoundedNumberSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const TargetFingerprintSchema = z
  .object({
    tag: z.string().min(1).max(128),
    id: z.string().min(1).max(256).optional(),
    classList: z.array(z.string().max(256)).max(512),
    textPrefix: z.string().max(256).optional(),
  })
  .strict();

const TargetRefSchema = z
  .object({
    refId: z.string().min(1).max(128),
    selector: z.string().min(1).max(2048),
    occurrenceIndex: z.number().int().min(0).max(50_000),
    domPath: z.array(z.number().int().min(0).max(10_000)).max(1024),
    fingerprint: TargetFingerprintSchema,
  })
  .strict();

const ManifestEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    selector: z.string().min(1).max(2048),
    dir: z.string().min(1).max(512),
    targetRefId: z.string().min(1).max(128).optional(),
  })
  .strict();

const PackManifestSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    timestamp: z.string().min(1).max(128),
    source: z.enum(['snapshot', 'recorder']),
    bugType: z.enum(['animation', 'layout-shift', 'z-index', 'visibility', 'overflow', 'other']).optional(),
    bugDescription: z.string().max(40_000).optional(),
    redactionPolicyVersion: z.string().max(64).optional(),
    url: z.string().url().max(4096),
    watchedElements: z.array(ManifestEntrySchema).max(MAX_WATCHED_ELEMENTS),
    stats: z
      .object({
        totalStateChanges: z.number().int().min(0).max(MAX_STATE_DELTAS_PER_ELEMENT * MAX_WATCHED_ELEMENTS),
        propertiesChanged: z.array(z.string().max(512)).max(MAX_SUMMARY_STRINGS),
        duration: z.number().finite().min(0).max(31_536_000_000).optional(),
      })
      .strict(),
  })
  .strict();

const UploadedElementSchema = z
  .object({
    id: z.string().min(1).max(128),
    selector: z.string().min(1).max(2048),
    tag: z.string().min(1).max(128).optional(),
    dir: z.string().min(1).max(512),
    core: ElementCoreSchema,
    fullStyles: FullStylesSchema,
    stateDeltas: z.array(StateDeltaSchema).max(MAX_STATE_DELTAS_PER_ELEMENT),
    parents: z.array(ParentEntrySchema).max(64),
    parentsFull: z.array(ParentEntrySchema).max(64).optional(),
    targetRef: TargetRefSchema.optional(),
  })
  .strict();

const UploadedPackSchema = z
  .object({
    id: z.string().min(1).max(128),
    manifest: PackManifestSchema,
    summary: z
      .object({
        detectedBugPatterns: z.array(z.record(z.unknown())).max(MAX_SUMMARY_STRINGS),
        keyFindings: z.array(z.string().max(2048)).max(MAX_SUMMARY_STRINGS),
        recommendedMCPQueries: z.array(z.string().max(2048)).max(MAX_SUMMARY_STRINGS),
      })
      .strict(),
    prompt: z.string().max(200_000).optional(),
    interactions: z.array(z.record(z.unknown())).max(MAX_INTERACTIONS).optional(),
    viewport: z.union([z.record(z.unknown()), z.null()]).optional(),
    watchedElements: z.array(UploadedElementSchema).min(1).max(MAX_WATCHED_ELEMENTS),
    contextElements: z.array(ElementCoreSchema).max(1024).default([]),
  })
  .strict();

const UploadRequestSchema = z.union([
  UploadedPackSchema,
  z
    .object({
      pack: UploadedPackSchema,
    })
    .strict(),
]);

export type UploadValidationIssue = {
  path: string;
  message: string;
  expected?: string;
  received?: string;
  hint?: string;
};

export type UploadValidationResult =
  | { ok: true; pack: UploadedPack }
  | { ok: false; errors: UploadValidationIssue[] };

type UploadedPack = z.infer<typeof UploadedPackSchema>;

function toPath(path: Array<string | number>): string {
  if (path.length === 0) return '(root)';
  return path
    .map((part) => (typeof part === 'number' ? `[${part}]` : part))
    .join('.')
    .replace('.[', '[');
}

function hintForPath(path: string): string | undefined {
  if (path.includes('manifest.id') || path === 'id') {
    return 'pack.id must match pack.manifest.id.';
  }
  if (path.includes('manifest.watchedElements')) {
    return 'manifest.watchedElements must mirror watchedElements entries exactly.';
  }
  if (path.includes('.dir')) {
    return 'Use a relative watched path like watched/el_00_button. Directory traversal is blocked.';
  }
  if (path.includes('watchedElements')) {
    return 'Each watched element must include core/fullStyles/stateDeltas/parents.';
  }
  return undefined;
}

function pushInvariantIssue(errors: UploadValidationIssue[], path: string, message: string): void {
  errors.push({
    path,
    message,
    hint: hintForPath(path),
  });
}

function validatePackInvariants(pack: UploadedPack): UploadValidationIssue[] {
  const errors: UploadValidationIssue[] = [];

  if (pack.id !== pack.manifest.id) {
    pushInvariantIssue(errors, 'manifest.id', `Expected "${pack.id}" but received "${pack.manifest.id}".`);
  }

  if (!SAFE_ID_PATTERN.test(pack.id)) {
    pushInvariantIssue(errors, 'id', 'Pack id contains unsupported characters.');
  }

  if (pack.manifest.watchedElements.length !== pack.watchedElements.length) {
    pushInvariantIssue(
      errors,
      'manifest.watchedElements',
      `Expected ${pack.watchedElements.length} entry/entries to match watchedElements length.`
    );
  }

  const seenManifestIds = new Set<string>();
  const manifestById = new Map<string, (typeof pack.manifest.watchedElements)[number]>();
  pack.manifest.watchedElements.forEach((entry, index) => {
    if (!SAFE_DIR_PATTERN.test(entry.dir) || entry.dir.includes('..')) {
      pushInvariantIssue(errors, `manifest.watchedElements[${index}].dir`, 'Invalid watched element directory.');
    }
    if (seenManifestIds.has(entry.id)) {
      pushInvariantIssue(errors, `manifest.watchedElements[${index}].id`, 'Duplicate manifest watched element id.');
    }
    seenManifestIds.add(entry.id);
    manifestById.set(entry.id, entry);
  });

  const seenElementIds = new Set<string>();
  pack.watchedElements.forEach((entry, index) => {
    if (!SAFE_DIR_PATTERN.test(entry.dir) || entry.dir.includes('..')) {
      pushInvariantIssue(errors, `watchedElements[${index}].dir`, 'Invalid watched element directory.');
    }
    if (seenElementIds.has(entry.id)) {
      pushInvariantIssue(errors, `watchedElements[${index}].id`, 'Duplicate watched element id.');
    }
    seenElementIds.add(entry.id);

    const manifestEntry = manifestById.get(entry.id);
    if (!manifestEntry) {
      pushInvariantIssue(
        errors,
        `watchedElements[${index}].id`,
        `No matching manifest entry for watched element id "${entry.id}".`
      );
      return;
    }

    if (manifestEntry.selector !== entry.selector) {
      pushInvariantIssue(
        errors,
        `watchedElements[${index}].selector`,
        `Selector mismatch with manifest entry "${entry.id}".`
      );
    }
    if (manifestEntry.dir !== entry.dir) {
      pushInvariantIssue(errors, `watchedElements[${index}].dir`, `Directory mismatch with manifest entry "${entry.id}".`);
    }
    if (manifestEntry.targetRefId && entry.targetRef && manifestEntry.targetRefId !== entry.targetRef.refId) {
      pushInvariantIssue(
        errors,
        `watchedElements[${index}].targetRef.refId`,
        `targetRefId mismatch with manifest entry "${entry.id}".`
      );
    }
  });

  return errors;
}

export function validateUploadRequestPayload(payload: unknown): UploadValidationResult {
  const parsed = UploadRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const errors: UploadValidationIssue[] = parsed.error.issues.map((issue) => {
      const path = toPath(issue.path);
      return {
        path,
        message: issue.message,
        expected: 'expected' in issue ? String((issue as { expected?: unknown }).expected) : undefined,
        received: 'received' in issue ? String((issue as { received?: unknown }).received) : undefined,
        hint: hintForPath(path),
      };
    });
    return { ok: false, errors };
  }

  const pack = 'pack' in parsed.data ? parsed.data.pack : parsed.data;
  const invariantErrors = validatePackInvariants(pack);
  if (invariantErrors.length > 0) {
    return { ok: false, errors: invariantErrors };
  }

  return { ok: true, pack };
}

export function formatUploadValidationErrors(errors: UploadValidationIssue[]): string {
  const lines = errors.slice(0, 8).map((error) => {
    const extras = [
      error.expected ? `expected=${error.expected}` : '',
      error.received ? `received=${error.received}` : '',
      error.hint ? `hint=${error.hint}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return extras
      ? `- ${error.path}: ${error.message} (${extras})`
      : `- ${error.path}: ${error.message}`;
  });

  if (errors.length > 8) {
    lines.push(`- ...and ${errors.length - 8} more validation error(s).`);
  }

  return lines.join('\n');
}
