import { describe, expect, it } from 'vitest';
import { runCaptureCli } from '../../cli/capture';

describe('capture phase 1 url parsing', () => {
  it('accepts positional url when requesting help', async () => {
    const exitCode = await runCaptureCli(['https://example.com', '--help']);
    expect(exitCode).toBe(0);
  });

  it('rejects positional url when --url is also provided', async () => {
    const exitCode = await runCaptureCli(['https://example.com', '--url', 'https://other.example.com']);
    expect(exitCode).toBe(1);
  });

  it('rejects extra positional argument when --url is used', async () => {
    const exitCode = await runCaptureCli(['--url', 'https://example.com', 'https://other.example.com']);
    expect(exitCode).toBe(1);
  });

  it('rejects missing url when neither positional nor --url is provided', async () => {
    const exitCode = await runCaptureCli([]);
    expect(exitCode).toBe(1);
  });

  it('rejects prompt aliases used in --prompt when not declared', async () => {
    const exitCode = await runCaptureCli(['https://example.com', '--prompt', 'Button @save jumps']);
    expect(exitCode).toBe(1);
  });

  it('rejects duplicate prompt aliases across --prompt-tag and --prompt-pick', async () => {
    const exitCode = await runCaptureCli([
      'https://example.com',
      '--prompt',
      'Button @save jumps',
      '--prompt-tag',
      'save=.save-button',
      '--prompt-pick',
      'save',
    ]);
    expect(exitCode).toBe(1);
  });

  it('rejects prompt-tag usage without --prompt text', async () => {
    const exitCode = await runCaptureCli([
      'https://example.com',
      '--prompt-tag',
      'save=.save-button',
    ]);
    expect(exitCode).toBe(1);
  });

  it('rejects using both --activate and --no-activate', async () => {
    const exitCode = await runCaptureCli([
      'https://example.com',
      '--activate',
      '--no-activate',
    ]);
    expect(exitCode).toBe(1);
  });
});
