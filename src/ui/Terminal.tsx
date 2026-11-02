import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalConnection } from '../core/types';
import { request } from './helpers';

export function SpriteTerminal({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState({ sequence: 0, fresh: false });
  const [status, setStatus] = useState('Connecting…');

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: '"Fragment Mono", "SFMono-Regular", Consolas, monospace', fontSize: 13, theme: { background: '#191034', foreground: '#ede9fe', cursor: '#c4b5fd', selectionBackground: '#5b3c88' }, scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    fit.fit();
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    });
    resize.observe(node);
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    setStatus('Connecting…');
    void request<TerminalConnection>({ type: 'terminal', id, cols: terminal.cols, rows: terminal.rows, ...(attempt.fresh ? { fresh: true } : {}) }).then(({ url }) => {
      if (disposed) return;
      const parsed = new URL(url);
      if (parsed.protocol !== 'wss:' || parsed.hostname !== 'api.sprites.dev' || !parsed.pathname.startsWith('/v1/sprites/')) throw new Error('Invalid terminal connection.');
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        if (disposed) return;
        setStatus('Connected');
        socket?.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        terminal.focus();
      });
      socket.addEventListener('message', (event) => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
        else if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: string; session_id?: string; exit_code?: number; error?: string };
            if (message.type === 'session_info' && typeof message.session_id === 'string') {
              void request({ type: 'terminal_session', id, sessionId: message.session_id }).catch(() => {});
            } else if (message.type === 'exit') {
              setStatus(`Shell exited (${message.exit_code ?? 0})`);
            } else if (message.error) {
              setStatus(message.error);
              terminal.writeln(`\r\n${message.error}`);
            }
          } catch { terminal.write(event.data); }
        }
      });
      socket.addEventListener('close', () => { if (!disposed) setStatus((previous) => previous.startsWith('Shell exited') ? previous : 'Disconnected. Reconnect to resume your shell.'); });
      socket.addEventListener('error', () => { if (!disposed) setStatus('Connection failed. Check your Sprite connection and reconnect.'); });
    }).catch((error: unknown) => { if (!disposed) setStatus(error instanceof Error ? error.message : String(error)); });

    return () => {
      disposed = true;
      socket?.close();
      resize.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [id, attempt]);

  return <section className="terminal-panel" aria-label="Sprite terminal">
    <div className="terminal-heading"><span><span className="terminal-dot" />Terminal</span><span className="terminal-status" role="status">{status}</span><button className="button subtle" type="button" onClick={() => setAttempt((value) => ({ sequence: value.sequence + 1, fresh: false }))}>Reconnect</button><button className="button subtle" type="button" onClick={() => setAttempt((value) => ({ sequence: value.sequence + 1, fresh: true }))}>New shell</button></div>
    <div className="terminal-container" ref={container} />
    <p className="terminal-note">Closing this terminal disconnects your browser. Your Sprite and files remain available.</p>
  </section>;
}
