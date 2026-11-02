import { startDetached } from '../core/api';

interface SetupMessage { requestId: string; url: string }
interface SetupPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
}

export function validateSetupURL(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid setup connection.');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.hostname !== 'api.sprites.dev' || url.port || url.username || url.password || url.hash ||
      !/^\/v1\/sprites\/[a-z\d-]{1,63}\/exec$/.test(url.pathname) ||
      [...url.searchParams.keys()].some((key) => /token|authorization|secret/i.test(key))) throw new Error('Invalid setup connection.');
  return url.href;
}

/** Chrome does not apply DNR headers to WebSockets opened by service workers.
 * An extension document performs only the setup acknowledgement handshake;
 * setup then continues independently on the Sprite after this socket closes.
 */
export function startSetupBridge(options: {
  connect?: () => SetupPort;
  execute?: (url: string) => Promise<string>;
  retryDelay?: number;
} = {}): () => void {
  const connect = options.connect ?? (() => chrome.runtime.connect({ name: 'sprite-setup-exec' }));
  const execute = options.execute ?? startDetached;
  const completed = new Map<string, Promise<string>>();
  let stopped = false;
  let connection: SetupPort | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (!stopped && !timer) timer = setTimeout(() => { timer = undefined; establish(); }, options.retryDelay ?? 1000);
  };
  const establish = () => {
    if (stopped) return;
    let port: SetupPort;
    try { port = connect(); connection = port; } catch { schedule(); return; }
    port.onDisconnect.addListener(() => {
      // Read lastError so a worker restart does not create an unchecked runtime warning.
      if (typeof chrome !== 'undefined') void chrome.runtime?.lastError;
      if (connection === port) { connection = undefined; schedule(); }
    });
    port.onMessage.addListener((raw) => {
      if (!raw || typeof raw !== 'object' || stopped) return;
      const message = raw as SetupMessage;
      if (typeof message.requestId !== 'string' || !/^[\w-]{1,128}$/.test(message.requestId)) return;
      const respond = (response: { sessionId: string } | { error: string }) => {
        if (stopped || connection !== port) return;
        try { port.postMessage({ requestId: message.requestId, ...response }); } catch { /* Reconnection reconciles remote state. */ }
      };
      let url: string;
      try { url = validateSetupURL(message.url); } catch { respond({ error: 'Invalid setup connection.' }); return; }
      let pending = completed.get(message.requestId);
      if (!pending) {
        pending = execute(url);
        completed.set(message.requestId, pending);
        if (completed.size > 100) completed.delete(completed.keys().next().value!);
      }
      void pending.then((sessionId) => respond({ sessionId })).catch(() => respond({ error: 'Setup connection failed. Reopen this launch to reconcile its remote state.' }));
    });
  };
  establish();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    connection?.disconnect();
    connection = undefined;
    completed.clear();
  };
}
