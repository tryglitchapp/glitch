import { REDACTION_POLICY_VERSION, redactUnknownDeep } from './redaction';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function attachRedactionPolicyVersion(payload: Record<string, unknown>): void {
  const packCandidate = isRecord(payload.pack) ? payload.pack : payload;
  if (!isRecord(packCandidate)) return;
  const manifestCandidate = packCandidate.manifest;
  if (!isRecord(manifestCandidate)) return;
  manifestCandidate.redactionPolicyVersion = REDACTION_POLICY_VERSION;
}

export function redactUploadPayload<T>(payload: T): T {
  const scrubbed = redactUnknownDeep(payload);
  if (isRecord(scrubbed)) {
    attachRedactionPolicyVersion(scrubbed);
  }
  return scrubbed;
}
