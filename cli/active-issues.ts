import type { ConfirmFn } from './confirm';

export type ActiveIssueMode = 'promote' | 'keep-order';

export type CaptureActivationPreference = 'always' | 'never' | 'prompt';

export type PostUploadActivationDecision = {
  shouldActivate: boolean;
  note: string | null;
};

export type ActivateUploadedPackResult = {
  activated: boolean;
  message: string | null;
};

export type ActiveIssueSummary = {
  packId: string;
  isPrimary: boolean;
  addedAt: string | null;
  lastPromotedAt: string | null;
  timestamp: string | null;
  source: string | null;
  bugType: string | null;
  url: string | null;
  watchedCount: number;
  totalStateChanges: number;
};

export type ActiveIssuesSnapshot = {
  total: number;
  primaryPackId: string | null;
  items: ActiveIssueSummary[];
};

export type AddActiveIssueResult = {
  packId: string;
  added: boolean;
  promoted: boolean;
  primaryPackId: string | null;
  total: number;
};

export type RemoveActiveIssueResult = {
  removedPackId: string;
  primaryPackId: string | null;
  total: number;
};

export type ClearActiveIssuesResult = {
  cleared: number;
  primaryPackId: null;
  total: 0;
};

export type ActiveIssuesCliErrorKind = 'unsupported' | 'unauthorized' | 'request';

export class ActiveIssuesCliError extends Error {
  kind: ActiveIssuesCliErrorKind;
  status: number;

  constructor(kind: ActiveIssuesCliErrorKind, status: number, message: string) {
    super(message);
    this.name = 'ActiveIssuesCliError';
    this.kind = kind;
    this.status = status;
  }
}

type DecidePostUploadActivationOptions = {
  destination: 'local' | 'cloud';
  activationPreference: CaptureActivationPreference;
  hasApiKey: boolean;
  interactive: boolean;
  confirmImpl: ConfirmFn;
};

type ActiveIssuesRequestOptions = {
  cloudUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

type ActivateUploadedPackOptions = ActiveIssuesRequestOptions & {
  packId: string;
};

type AddActiveIssueOptions = ActiveIssuesRequestOptions & {
  packId: string;
  mode?: ActiveIssueMode;
};

type RemoveActiveIssueOptions = ActiveIssuesRequestOptions & {
  packId: string;
};

const ACTIVE_ISSUES_PROMPT = 'Add this pack to Active Issues? [Y/n] ';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getResponseDetail(body: Record<string, unknown> | null, rawBody: string, fallback: string): string {
  const structured =
    typeof body?.error === 'string' && body.error.trim().length > 0
      ? body.error.trim()
      : '';
  if (structured) return structured;

  const text = rawBody.trim();
  if (!text) return fallback;
  try {
    const parsed = asRecord(JSON.parse(text));
    const error =
      typeof parsed?.error === 'string' && parsed.error.trim().length > 0
        ? parsed.error.trim()
        : '';
    return error || fallback;
  } catch {
    return text || fallback;
  }
}

function normalizePackId(packId: string): string {
  const trimmed = packId.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^contextpacks:\/\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function getActiveIssuesEndpoint(cloudUrl: string, packId?: string): string {
  const base = new URL('/v1/active-issues', cloudUrl).toString();
  if (!packId) return base;
  return `${base}/${encodeURIComponent(normalizePackId(packId))}`;
}

async function readResponseBody(response: Response): Promise<{ rawBody: string; body: Record<string, unknown> | null }> {
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    return { rawBody, body: null };
  }

  try {
    return {
      rawBody,
      body: asRecord(JSON.parse(rawBody)),
    };
  } catch {
    return { rawBody, body: null };
  }
}

function getRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeActiveIssueSummary(value: unknown): ActiveIssueSummary | null {
  const record = asRecord(value);
  const packId = getRequiredString(record?.packId);
  if (!packId) return null;

  return {
    packId,
    isPrimary: Boolean(record?.isPrimary),
    addedAt: getRequiredString(record?.addedAt),
    lastPromotedAt: getRequiredString(record?.lastPromotedAt),
    timestamp: getRequiredString(record?.timestamp),
    source: getRequiredString(record?.source),
    bugType: getRequiredString(record?.bugType),
    url: getRequiredString(record?.url),
    watchedCount: getNumber(record?.watchedCount),
    totalStateChanges: getNumber(record?.totalStateChanges),
  };
}

function normalizeActiveIssuesSnapshot(body: Record<string, unknown> | null): ActiveIssuesSnapshot {
  const itemsRaw = Array.isArray(body?.items) ? body.items : [];
  const items = itemsRaw
    .map((entry) => normalizeActiveIssueSummary(entry))
    .filter((entry): entry is ActiveIssueSummary => Boolean(entry));

  return {
    total: typeof body?.total === 'number' ? body.total : items.length,
    primaryPackId: getRequiredString(body?.primaryPackId),
    items,
  };
}

function normalizeAddActiveIssueResult(body: Record<string, unknown> | null, packId: string): AddActiveIssueResult {
  return {
    packId: getRequiredString(body?.packId) ?? normalizePackId(packId),
    added: Boolean(body?.added),
    promoted: Boolean(body?.promoted),
    primaryPackId: getRequiredString(body?.primaryPackId),
    total: typeof body?.total === 'number' ? body.total : 0,
  };
}

function normalizeRemoveActiveIssueResult(body: Record<string, unknown> | null, packId: string): RemoveActiveIssueResult {
  return {
    removedPackId: getRequiredString(body?.removedPackId) ?? normalizePackId(packId),
    primaryPackId: getRequiredString(body?.primaryPackId),
    total: typeof body?.total === 'number' ? body.total : 0,
  };
}

function normalizeClearActiveIssuesResult(body: Record<string, unknown> | null): ClearActiveIssuesResult {
  return {
    cleared: typeof body?.cleared === 'number' ? body.cleared : 0,
    primaryPackId: null,
    total: 0,
  };
}

function toActiveIssuesError(
  response: Response,
  body: Record<string, unknown> | null,
  rawBody: string,
  fallback: string,
): ActiveIssuesCliError {
  const detail = getResponseDetail(body, rawBody, fallback);
  const errorCode = getRequiredString(body?.code);
  if (response.status === 405 || (response.status === 404 && !errorCode)) {
    return new ActiveIssuesCliError('unsupported', response.status, 'Active Issues is not available on this server yet.');
  }
  if (response.status === 401) {
    return new ActiveIssuesCliError('unauthorized', response.status, detail);
  }
  return new ActiveIssuesCliError('request', response.status, detail);
}

export function resolveCaptureActivationPreference(options: {
  activate: boolean;
  noActivate: boolean;
}): CaptureActivationPreference {
  if (options.activate) return 'always';
  if (options.noActivate) return 'never';
  return 'prompt';
}

export async function decidePostUploadActivation({
  destination,
  activationPreference,
  hasApiKey,
  interactive,
  confirmImpl,
}: DecidePostUploadActivationOptions): Promise<PostUploadActivationDecision> {
  if (activationPreference === 'never') {
    return { shouldActivate: false, note: null };
  }

  if (destination !== 'cloud') {
    return {
      shouldActivate: false,
      note:
        activationPreference === 'always'
          ? 'Active Issues requires cloud upload with a personal API key.'
          : null,
    };
  }

  if (!hasApiKey) {
    return {
      shouldActivate: false,
      note: 'Active Issues requires a personal API key.',
    };
  }

  if (activationPreference === 'always') {
    return { shouldActivate: true, note: null };
  }

  if (!interactive) {
    return { shouldActivate: false, note: null };
  }

  try {
    const confirmed = await confirmImpl(ACTIVE_ISSUES_PROMPT);
    return { shouldActivate: confirmed, note: null };
  } catch (error) {
    return {
      shouldActivate: false,
      note: `Skipped Active Issues activation: ${
        error instanceof Error ? error.message : 'prompt failed'
      }`,
    };
  }
}

export async function listActiveIssues({
  cloudUrl,
  apiKey,
  fetchImpl = fetch,
}: ActiveIssuesRequestOptions): Promise<ActiveIssuesSnapshot> {
  const response = await fetchImpl(getActiveIssuesEndpoint(cloudUrl), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const { rawBody, body } = await readResponseBody(response);

  if (!response.ok || body?.ok === false) {
    throw toActiveIssuesError(response, body, rawBody, `Failed to list Active Issues (${response.status}).`);
  }

  return normalizeActiveIssuesSnapshot(body);
}

export async function addActiveIssue({
  packId,
  cloudUrl,
  apiKey,
  mode = 'promote',
  fetchImpl = fetch,
}: AddActiveIssueOptions): Promise<AddActiveIssueResult> {
  const normalizedPackId = normalizePackId(packId);
  const response = await fetchImpl(getActiveIssuesEndpoint(cloudUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ packId: normalizedPackId, mode }),
  });
  const { rawBody, body } = await readResponseBody(response);

  if (!response.ok || body?.ok === false) {
    throw toActiveIssuesError(response, body, rawBody, `Failed to add pack to Active Issues (${response.status}).`);
  }

  return normalizeAddActiveIssueResult(body, normalizedPackId);
}

export async function removeActiveIssue({
  packId,
  cloudUrl,
  apiKey,
  fetchImpl = fetch,
}: RemoveActiveIssueOptions): Promise<RemoveActiveIssueResult> {
  const normalizedPackId = normalizePackId(packId);
  const response = await fetchImpl(getActiveIssuesEndpoint(cloudUrl, normalizedPackId), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const { rawBody, body } = await readResponseBody(response);

  if (!response.ok || body?.ok === false) {
    throw toActiveIssuesError(response, body, rawBody, `Failed to remove pack from Active Issues (${response.status}).`);
  }

  return normalizeRemoveActiveIssueResult(body, normalizedPackId);
}

export async function clearActiveIssues({
  cloudUrl,
  apiKey,
  fetchImpl = fetch,
}: ActiveIssuesRequestOptions): Promise<ClearActiveIssuesResult> {
  const response = await fetchImpl(getActiveIssuesEndpoint(cloudUrl), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const { rawBody, body } = await readResponseBody(response);

  if (!response.ok || body?.ok === false) {
    throw toActiveIssuesError(response, body, rawBody, `Failed to clear Active Issues (${response.status}).`);
  }

  return normalizeClearActiveIssuesResult(body);
}

export async function activateUploadedPack({
  packId,
  cloudUrl,
  apiKey,
  fetchImpl = fetch,
}: ActivateUploadedPackOptions): Promise<ActivateUploadedPackResult> {
  try {
    await addActiveIssue({
      packId,
      cloudUrl,
      apiKey,
      mode: 'promote',
      fetchImpl,
    });
    return { activated: true, message: null };
  } catch (error) {
    if (error instanceof ActiveIssuesCliError) {
      return {
        activated: false,
        message: error.message,
      };
    }

    return {
      activated: false,
      message: `Failed to add pack to Active Issues: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
