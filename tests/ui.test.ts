import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRunning, request, validOverrides } from '../src/ui/helpers';

afterEach(() => vi.unstubAllGlobals());

describe('UI launch lifecycle', () => {
  it('stops polling ready and configuration-required workspaces so idle Sprites can sleep', () => {
    expect(isRunning('ready')).toBe(false);
    expect(isRunning('needs_configuration')).toBe(false);
    expect(isRunning('failed')).toBe(false);
    expect(isRunning('cancelled')).toBe(false);
    expect(isRunning('installing')).toBe(true);
    expect(isRunning('database')).toBe(true);
  });

  it('surfaces backend failures instead of treating unavailable data as an empty result', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: 'Organization token expired' }) } });
    await expect(request({ type: 'snapshot' })).rejects.toThrow('Organization token expired');
  });

  it('handles worker restart without a response', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) } });
    await expect(request({ type: 'snapshot' })).rejects.toThrow('Reload this tab');
  });

  it('returns successful payloads without exposing transport objects', async () => {
    const data = { status: 'pending' };
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(request({ type: 'poll_login', sessionId: 'session' })).resolves.toEqual(data);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'poll_login', sessionId: 'session' });
  });
});

describe('manual launch configuration', () => {
  it('accepts deliberate user commands and a checkout-relative app path', () => {
    expect(validOverrides(' apps/web ', ' npm ci ', ' npm run dev -- --host 0.0.0.0 ', '8080')).toEqual({ directory: 'apps/web', installCommand: 'npm ci', startCommand: 'npm run dev -- --host 0.0.0.0', port: 8080 });
    expect(validOverrides('.', '', 'python3 server.py', '65535').installCommand).toBe('');
  });

  it.each(['', '/home/sprite', ' /home/sprite ', '../project', 'apps/../../other', 'apps\\web'])('rejects paths outside checkout: %s', (value) => {
    expect(() => validOverrides(value, '', 'npm start', '8080')).toThrow('relative');
  });

  it.each(['0', '-1', '65536', '80.5', 'n/a'])('rejects invalid HTTP port %s', (value) => {
    expect(() => validOverrides('.', '', 'npm start', value)).toThrow('Port');
  });

  it('requires a start command', () => {
    expect(() => validOverrides('.', '', '  ', '8080')).toThrow('start command');
  });
});
