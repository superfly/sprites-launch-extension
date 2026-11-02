import { useEffect, useId, useRef, useState } from 'react';
import { request } from './helpers';

interface Credentials {
  username: string;
  password: string;
}

interface ConnectionState {
  scope: string;
  credentials?: Credentials;
  pending: boolean;
  message: string;
  error: string;
}

const empty = (scope: string): ConnectionState => ({ scope, pending: false, message: '', error: '' });

/** Dashboard credentials are read on demand and live only in this mounted view. */
export function HermesConnection({ launchId, organization, disabled = false }: { launchId: string; organization?: string; disabled?: boolean }) {
  const scope = JSON.stringify([launchId, organization ?? '', disabled]);
  const available = Boolean(organization) && !disabled;
  const [state, setState] = useState<ConnectionState>(() => empty(scope));
  const generation = useRef(0);
  const usernameField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  // Hide credentials during the context-changing render, before effect cleanup.
  const current = available && state.scope === scope ? state : empty(scope);

  useEffect(() => {
    generation.current += 1;
    setState(empty(scope));
    return () => { generation.current += 1; };
  }, [scope]);

  const reveal = async () => {
    if (!available) return;
    const attempt = ++generation.current;
    setState({ ...empty(scope), pending: true });
    try {
      const result = await request<Credentials>({ type: 'hermes_connection', id: launchId });
      if (generation.current !== attempt) return;
      if (!result || typeof result.username !== 'string' || !result.username || typeof result.password !== 'string' || !result.password) {
        throw new Error('Dashboard sign-in unavailable');
      }
      setState({ ...empty(scope), credentials: { username: result.username, password: result.password } });
    } catch {
      if (generation.current === attempt) setState({ ...empty(scope), error: 'Unable to read the Hermes dashboard sign-in details. Try again.' });
    }
  };

  const hide = () => {
    generation.current += 1;
    setState(empty(scope));
  };

  const copy = async (name: keyof Credentials) => {
    if (!current.credentials || !available) return;
    const attempt = ++generation.current;
    setState({ ...current, pending: true, message: '', error: '' });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(current.credentials[name]);
      if (generation.current === attempt) setState({ ...current, pending: false, message: `${name === 'username' ? 'Username' : 'Password'} copied.`, error: '' });
    } catch {
      if (generation.current !== attempt) return;
      setState({ ...current, pending: false, message: `Copy is unavailable. Select the ${name} field and copy it manually.`, error: '' });
      const field = name === 'username' ? usernameField : passwordField;
      field.current?.focus();
      field.current?.select();
    }
  };

  return <section className="app-connection" aria-label="Hermes dashboard sign-in">
    <h3>Hermes dashboard sign-in</h3>
    <p className="muted">Use these details to sign in to the Hermes dashboard, then configure your model there.</p>
    {current.credentials ? <>
      <div className="app-connection-controls">
        <label className="sr-only" htmlFor={`${fieldId}-username`}>Hermes dashboard username</label>
        <input id={`${fieldId}-username`} ref={usernameField} type="text" value={current.credentials.username} readOnly autoComplete="off" spellCheck={false} />
        <button className="button" type="button" disabled={current.pending} onClick={() => void copy('username')}>Copy username</button>
      </div>
      <div className="app-connection-controls">
        <label className="sr-only" htmlFor={`${fieldId}-password`}>Hermes dashboard password</label>
        <input id={`${fieldId}-password`} ref={passwordField} type="password" value={current.credentials.password} readOnly autoComplete="off" spellCheck={false} />
        <button className="button" type="button" disabled={current.pending} onClick={() => void copy('password')}>Copy password</button>
        <button className="button subtle" type="button" onClick={hide}>Hide</button>
      </div>
      {current.message && <p className="app-connection-message" role="status">{current.message}</p>}
    </> : <button className="button" type="button" disabled={current.pending || !available} onClick={() => void reveal()}>{current.pending ? 'Loading sign-in details…' : 'Show sign-in details'}</button>}
    {current.error && <p className="app-connection-error" role="alert">{current.error}</p>}
  </section>;
}
