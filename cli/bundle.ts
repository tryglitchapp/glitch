import { createHash } from 'node:crypto';
import path from 'node:path';

export type PullBundleMode = 'slim' | 'full';
export type PullBundleEncoding = 'utf8' | 'base64';

export type PullBundleFile = {
  path: string;
  contentType: string;
  encoding: PullBundleEncoding;
  bytes: number;
  sha256: string;
  data: string;
};

export type PullBundle = {
  format: 'glitchpack';
  bundleVersion: '1.0';
  packId: string;
  createdAt: string;
  mode: PullBundleMode;
  manifest: Record<string, unknown>;
  summary: Record<string, unknown>;
  toc: Record<string, unknown>;
  files: PullBundleFile[];
};

export type VerifiedPullBundleFile = PullBundleFile & {
  decodedBytes: Buffer;
};

export type VerifiedPullBundle = Omit<PullBundle, 'files'> & {
  files: VerifiedPullBundleFile[];
};

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function parseAndVerifyBundlePayload(payload: unknown): VerifiedPullBundle {
  const root = asRecord(payload, 'bundle payload');
  const format = readString(root, 'format');
  if (format !== 'glitchpack') {
    throw new Error(`Unsupported bundle format: ${format}`);
  }

  const bundleVersion = readString(root, 'bundleVersion');
  if (bundleVersion !== '1.0') {
    throw new Error(`Unsupported bundle version: ${bundleVersion}`);
  }

  const packId = readNonEmptyString(root, 'packId');
  const createdAt = readNonEmptyString(root, 'createdAt');

  const modeRaw = readString(root, 'mode');
  const mode = parseMode(modeRaw);

  const manifest = asRecord(root.manifest, 'bundle.manifest');
  const summary = asRecord(root.summary, 'bundle.summary');
  const toc = asRecord(root.toc, 'bundle.toc');

  if (!Array.isArray(root.files)) {
    throw new Error('bundle.files must be an array.');
  }

  const seenPaths = new Set<string>();
  const files = root.files.map((entry, index) => {
    const file = parseBundleFile(entry, index);
    if (seenPaths.has(file.path)) {
      throw new Error(`Duplicate bundle file path: ${file.path}`);
    }
    seenPaths.add(file.path);
    return file;
  });

  return {
    format,
    bundleVersion,
    packId,
    createdAt,
    mode,
    manifest,
    summary,
    toc,
    files,
  };
}

export function assertSafeRelativeBundlePath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    throw new Error('Invalid bundle file path: empty path.');
  }
  if (trimmed.includes('\\')) {
    throw new Error(`Invalid bundle file path: ${relativePath}`);
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`Invalid bundle file path: ${relativePath}`);
  }

  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid bundle file path: ${relativePath}`);
  }
  return normalized;
}

function parseBundleFile(value: unknown, index: number): VerifiedPullBundleFile {
  const row = asRecord(value, `bundle.files[${index}]`);
  const relativePath = assertSafeRelativeBundlePath(readNonEmptyString(row, 'path'));
  const contentType = readNonEmptyString(row, 'contentType');
  const encoding = parseEncoding(readString(row, 'encoding'));
  const bytes = readNonNegativeInteger(row, 'bytes');
  const sha256 = readHexSha256(row, 'sha256');
  const data = readString(row, 'data');
  const decodedBytes = decodeData(data, encoding);

  if (decodedBytes.length !== bytes) {
    throw new Error(
      `Bundle file byte length mismatch for "${relativePath}": expected ${bytes}, got ${decodedBytes.length}.`
    );
  }

  const computedHash = createHash('sha256').update(decodedBytes).digest('hex');
  if (computedHash !== sha256.toLowerCase()) {
    throw new Error(`Bundle file hash mismatch for "${relativePath}".`);
  }

  return {
    path: relativePath,
    contentType,
    encoding,
    bytes,
    sha256: sha256.toLowerCase(),
    data,
    decodedBytes,
  };
}

function decodeData(data: string, encoding: PullBundleEncoding): Buffer {
  if (encoding === 'utf8') {
    return Buffer.from(data, 'utf8');
  }

  if (!data) {
    return Buffer.alloc(0);
  }
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new Error('Invalid base64 data in bundle file.');
  }
  return Buffer.from(data, 'base64');
}

function parseMode(mode: string): PullBundleMode {
  if (mode === 'slim' || mode === 'full') {
    return mode;
  }
  throw new Error(`Invalid bundle mode: ${mode}`);
}

function parseEncoding(encoding: string): PullBundleEncoding {
  if (encoding === 'utf8' || encoding === 'base64') {
    return encoding;
  }
  throw new Error(`Unsupported bundle encoding: ${encoding}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected "${key}" to be a string.`);
  }
  return value;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key).trim();
  if (!value) {
    throw new Error(`Expected "${key}" to be a non-empty string.`);
  }
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected "${key}" to be a non-negative integer.`);
  }
  return value;
}

function readHexSha256(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!SHA256_HEX_RE.test(value)) {
    throw new Error(`Expected "${key}" to be a 64-character hex sha256 string.`);
  }
  return value;
}
