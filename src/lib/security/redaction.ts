export const REDACTION_POLICY_VERSION = '2026-02-22';

const SENSITIVE_KEY_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /pass(word)?|pwd|pin/i, label: 'password' },
  { regex: /token|bearer|authorization|auth/i, label: 'token' },
  { regex: /secret|private[-_]?key/i, label: 'secret' },
  { regex: /cookie|session/i, label: 'session' },
  { regex: /api[-_]?key|apikey/i, label: 'api-key' },
  { regex: /email|e-mail/i, label: 'email' },
  { regex: /card|credit/i, label: 'card' },
];

const JWT_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_HEX_PATTERN = /\b(?:0x)?[a-f0-9]{32,}\b/gi;
const STRIPE_KEY_PATTERN = /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g;
const GLITCH_KEY_PATTERN = /\b(?:glk|glt)_[A-Za-z0-9_]{12,}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;

function getRedactionLabelForKey(key: string): string | null {
  for (const matcher of SENSITIVE_KEY_PATTERNS) {
    if (matcher.regex.test(key)) {
      return matcher.label;
    }
  }
  return null;
}

function redactionPlaceholder(label: string): string {
  return `[REDACTED:${label}]`;
}

function redactCreditCardCandidates(value: string): string {
  return value.replace(CREDIT_CARD_PATTERN, (candidate) => {
    const digits = candidate.replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) return candidate;
    return redactionPlaceholder('card');
  });
}

export function redactString(input: string): string {
  if (!input) return input;

  let output = input;
  output = output.replace(BEARER_PATTERN, `Bearer ${redactionPlaceholder('token')}`);
  output = output.replace(JWT_PATTERN, redactionPlaceholder('jwt'));
  output = output.replace(STRIPE_KEY_PATTERN, redactionPlaceholder('api-key'));
  output = output.replace(GLITCH_KEY_PATTERN, redactionPlaceholder('token'));
  output = output.replace(LONG_HEX_PATTERN, redactionPlaceholder('secret'));
  output = output.replace(EMAIL_PATTERN, redactionPlaceholder('email'));
  output = redactCreditCardCandidates(output);
  return output;
}

export function redactAttributes(attrs: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    const sensitiveLabel = getRedactionLabelForKey(key);
    if (sensitiveLabel) {
      next[key] = redactionPlaceholder(sensitiveLabel);
      continue;
    }
    next[key] = redactString(value);
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function redactUnknownDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknownDeep(entry)) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const sensitiveLabel = getRedactionLabelForKey(key);
    if (sensitiveLabel) {
      next[key] = redactionPlaceholder(sensitiveLabel);
      continue;
    }
    next[key] = redactUnknownDeep(raw);
  }
  return next as T;
}
