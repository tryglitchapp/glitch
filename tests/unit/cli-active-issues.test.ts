import { describe, expect, it, vi } from 'vitest';
import {
  activateUploadedPack,
  decidePostUploadActivation,
  resolveCaptureActivationPreference,
} from '../../cli/active-issues';
import { parseCaptureArgs } from '../../cli/capture';

describe('cli active issues helpers', () => {
  it('maps --activate to an always-activate preference', () => {
    const args = parseCaptureArgs(['https://example.com', '--activate']);
    expect(resolveCaptureActivationPreference(args)).toBe('always');
  });

  it('maps --no-activate to a never-activate preference', () => {
    const args = parseCaptureArgs(['https://example.com', '--no-activate']);
    expect(resolveCaptureActivationPreference(args)).toBe('never');
  });

  it('defaults interactive cloud uploads to a yes/no prompt', async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);
    const decision = await decidePostUploadActivation({
      destination: 'cloud',
      activationPreference: 'prompt',
      hasApiKey: true,
      interactive: true,
      confirmImpl,
    });

    expect(decision).toEqual({ shouldActivate: true, note: null });
    expect(confirmImpl).toHaveBeenCalledWith('Add this pack to Active Issues? [Y/n] ');
  });

  it('skips the prompt in non-interactive sessions', async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);
    const decision = await decidePostUploadActivation({
      destination: 'cloud',
      activationPreference: 'prompt',
      hasApiKey: true,
      interactive: false,
      confirmImpl,
    });

    expect(decision).toEqual({ shouldActivate: false, note: null });
    expect(confirmImpl).not.toHaveBeenCalled();
  });

  it('skips activation when no personal api key is available', async () => {
    const confirmImpl = vi.fn().mockResolvedValue(true);
    const decision = await decidePostUploadActivation({
      destination: 'cloud',
      activationPreference: 'always',
      hasApiKey: false,
      interactive: true,
      confirmImpl,
    });

    expect(decision).toEqual({
      shouldActivate: false,
      note: 'Active Issues requires a personal API key.',
    });
    expect(confirmImpl).not.toHaveBeenCalled();
  });

  it('posts uploaded packs to the active issues endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://mcp.example.com/v1/active-issues');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer api_test',
      });
      expect(init?.body).toBe(JSON.stringify({ packId: 'pack_cli', mode: 'promote' }));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await activateUploadedPack({
      packId: 'pack_cli',
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ activated: true, message: null });
  });

  it('treats unsupported active issues endpoints as non-fatal', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 }));

    const result = await activateUploadedPack({
      packId: 'pack_cli',
      cloudUrl: 'https://mcp.example.com',
      apiKey: 'api_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      activated: false,
      message: 'Active Issues is not available on this server yet.',
    });
  });
});
