import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSetupBridge, validateSetupURL } from '../src/ui/setupBridge';

function port() {
  let receive: (message: unknown) => void = () => {};
  let disconnect: () => void = () => {};
  return {
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
    postMessage: vi.fn(), disconnect: vi.fn(),
    receive: (message: unknown) => receive(message),
    disconnected: () => disconnect(),
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('document setup handshake', () => {
  it('allows only the trusted API exec URL, never credentials in the URL', () => {
    expect(validateSetupURL('wss://api.sprites.dev/v1/sprites/test-sprite/exec?cmd=python3')).toContain('cmd=python3');
    for (const url of ['wss://api.sprites.dev.evil/v1/sprites/test-sprite/exec', 'https://api.sprites.dev/v1/sprites/test-sprite/exec', 'wss://api.sprites.dev/v1/sprites/test-sprite/exec/123', 'wss://api.sprites.dev/v1/sprites/test-sprite/exec?token=secret', 'wss://user:secret@api.sprites.dev/v1/sprites/test-sprite/exec']) expect(() => validateSetupURL(url)).toThrow();
  });

  it('acknowledges a persisted remote session without repeating duplicate bridge requests', async () => {
    const connection = port();
    const execute = vi.fn().mockResolvedValue('123');
    const stop = startSetupBridge({ connect: () => connection, execute });
    const message = { requestId: 'request-1', url: 'wss://api.sprites.dev/v1/sprites/test/exec?cmd=python3' };
    connection.receive(message);
    connection.receive(message);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(connection.postMessage).toHaveBeenCalledWith({ requestId: 'request-1', sessionId: '123' });
    stop();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed URLs and does not echo API error text into the document', async () => {
    const connection = port();
    const execute = vi.fn().mockRejectedValue(new Error('secret-bearing failure'));
    const stop = startSetupBridge({ connect: () => connection, execute });
    connection.receive({ requestId: 'bad-url', url: 'wss://attacker.test/' });
    expect(execute).not.toHaveBeenCalled();
    expect(connection.postMessage).toHaveBeenCalledWith({ requestId: 'bad-url', error: 'Invalid setup connection.' });
    connection.receive({ requestId: 'request-1', url: 'wss://api.sprites.dev/v1/sprites/test/exec' });
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(connection.postMessage.mock.calls)).not.toContain('secret-bearing');
    stop();
  });

  it('reconnects when the service worker restarts and cleans up its reconnect timer', async () => {
    vi.useFakeTimers();
    const first = port(), second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const stop = startSetupBridge({ connect, execute: vi.fn() });
    first.disconnected();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    second.disconnected();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
