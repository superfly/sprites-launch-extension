import { useEffect, useRef, useState } from 'react';
import { request } from './helpers';

interface ConnectionState {
  scope: string;
  token?: string;
  pending: boolean;
  message: string;
  error: string;
}

const empty = (scope: string): ConnectionState => ({ scope, pending: false, message: '', error: '' });

/** Application credentials live only in this mounted view, never a launch snapshot. */
export function AppConnection({ launchId, organization, disabled = false }: { launchId: string; organization?: string; disabled?: boolean }) {
  const scope = `${launchId}:${organization ?? ''}`;
  const [state, setState] = useState<ConnectionState>(() => empty(scope));
  const field = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  // Hide an old credential in the render that changes context, before effect cleanup.
  const current = state.scope === scope ? state : empty(scope);

  useEffect(() => {
    generation.current += 1;
    setState(empty(scope));
    return () => { generation.current += 1; };
  }, [scope]);

  const reveal = async () => {
    const attempt = ++generation.current;
    setState({ ...empty(scope), pending: true });
    try {
      const result = await request<{ token: string }>({ type: 'app_connection', id: launchId });
      if (generation.current !== attempt) return;
      if (!result || typeof result.token !== 'string' || !result.token) throw new Error('Gateway token unavailable');
      setState({ ...empty(scope), token: result.token });
    } catch {
      if (generation.current === attempt) setState({ ...empty(scope), error: 'Unable to read the Gateway connection token. Try again.' });
    }
  };

  const hide = () => {
    generation.current += 1;
    setState(empty(scope));
  };

  const copy = async () => {
    if (!current.token) return;
    const attempt = ++generation.current;
    setState({ ...current, pending: true, message: '', error: '' });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(current.token);
      if (generation.current === attempt) setState({ ...current, pending: false, message: 'Token copied.', error: '' });
    } catch {
      if (generation.current !== attempt) return;
      setState({ ...current, pending: false, message: 'Copy is unavailable. Select the token field and copy it manually.', error: '' });
      field.current?.focus();
      field.current?.select();
    }
  };

  return <section className="app-connection" aria-label="OpenClaw Gateway connection">
    <h3>Gateway connection token</h3>
    <p className="muted">Use this token to connect the OpenClaw dashboard; finish model setup there.</p>
    <p className="muted">If the dashboard asks to pair this browser, run <code>node openclaw.mjs devices list</code> in the terminal, then approve its request with <code>node openclaw.mjs devices approve &lt;request-id&gt;</code>.</p>
    {current.token ? <>
      <div className="app-connection-controls">
        <label className="sr-only" htmlFor="gateway-connection-token">Gateway connection token</label>
        <input id="gateway-connection-token" ref={field} type="password" value={current.token} readOnly autoComplete="off" spellCheck={false} />
        <button className="button" type="button" disabled={current.pending} onClick={() => void copy()}>{current.pending ? 'Copying…' : 'Copy token'}</button>
        <button className="button subtle" type="button" onClick={hide}>Hide token</button>
      </div>
      {current.message && <p className="app-connection-message" role="status">{current.message}</p>}
    </> : <button className="button" type="button" disabled={current.pending || !organization || disabled} onClick={() => void reveal()}>{current.pending ? 'Loading token…' : 'Show connection token'}</button>}
    {current.error && <p className="app-connection-error" role="alert">{current.error}</p>}
  </section>;
}
