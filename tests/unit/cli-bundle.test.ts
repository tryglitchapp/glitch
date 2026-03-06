import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSafeRelativeBundlePath, parseAndVerifyBundlePayload } from '../../cli/bundle';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildValidBundle() {
  const utf8Data = 'hello world';
  const utf8Bytes = Buffer.from(utf8Data, 'utf8');
  const base64Bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const base64Data = base64Bytes.toString('base64');

  return {
    format: 'glitchpack',
    bundleVersion: '1.0',
    packId: 'pack_123',
    createdAt: '2026-02-26T00:00:00.000Z',
    mode: 'slim',
    manifest: { id: 'pack_123' },
    summary: { website: 'example.com' },
    toc: {},
    files: [
      {
        path: 'summary.json',
        contentType: 'application/json',
        encoding: 'utf8',
        bytes: utf8Bytes.length,
        sha256: sha256(utf8Bytes),
        data: utf8Data,
      },
      {
        path: 'context/blob.bin',
        contentType: 'application/octet-stream',
        encoding: 'base64',
        bytes: base64Bytes.length,
        sha256: sha256(base64Bytes),
        data: base64Data,
      },
    ],
  };
}

describe('cli bundle verification', () => {
  it('parses and verifies valid utf8 and base64 files', () => {
    const bundle = buildValidBundle();
    const parsed = parseAndVerifyBundlePayload(bundle);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].decodedBytes.toString('utf8')).toBe('hello world');
    expect(parsed.files[1].decodedBytes.toString('hex')).toBe('deadbeef');
  });

  it('rejects traversal paths', () => {
    expect(() => assertSafeRelativeBundlePath('../secrets.txt')).toThrow(/Invalid bundle file path/);
    expect(() => assertSafeRelativeBundlePath('/etc/passwd')).toThrow(/Invalid bundle file path/);
    expect(() => assertSafeRelativeBundlePath('watched\\core.json')).toThrow(/Invalid bundle file path/);
  });

  it('rejects hash mismatches', () => {
    const bundle = buildValidBundle();
    bundle.files[0].sha256 = '0'.repeat(64);
    expect(() => parseAndVerifyBundlePayload(bundle)).toThrow(/hash mismatch/i);
  });

  it('rejects byte length mismatches', () => {
    const bundle = buildValidBundle();
    bundle.files[0].bytes += 1;
    expect(() => parseAndVerifyBundlePayload(bundle)).toThrow(/byte length mismatch/i);
  });

  it('rejects duplicate file paths', () => {
    const bundle = buildValidBundle();
    bundle.files.push({ ...bundle.files[0] });
    expect(() => parseAndVerifyBundlePayload(bundle)).toThrow(/Duplicate bundle file path/);
  });
});
