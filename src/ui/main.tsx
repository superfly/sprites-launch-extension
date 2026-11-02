import { useCallback, useEffect, useRef, useState } from 'react';
import { FLY_LOGO_URL, FLY_LOGO_INVERTED_URL, FLY_BRANDMARK_URL, FLY_BRANDMARK_INVERTED_URL, FLY_BRANDMARK_LIGHT_URL } from '../brand';
import { createRoot } from 'react-dom/client';
import type { LaunchOverrides, LaunchRecord, LoginSession, Snapshot } from '../core/types';
import { formatDate, isRunning, PHASE_LABELS, request, shortSha, targetLabel, validOverrides } from './helpers';
import { SpriteTerminal } from './Terminal';
import { startSetupBridge } from './setupBridge';
import { AppConnection } from './AppConnection';
import { HermesConnection } from './HermesConnection';
import { usePanelContext } from './panelContext';
import './style.css';

const EMPTY: Snapshot = { settings: { previewAuthVerified: false }, organizations: [], launches: [] };
const STEPS = ['creating', 'cloning', 'detecting', 'installing', 'database', 'starting', 'ready'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function FlyMark({ light = false }: { light?: boolean }) {
  return <picture className="fly-brandmark" aria-hidden="true">
    {!light && <source media="(prefers-color-scheme: dark)" srcSet={FLY_BRANDMARK_INVERTED_URL} />}
    <img src={light ? FLY_BRANDMARK_LIGHT_URL : FLY_BRANDMARK_URL} alt="" />
  </picture>;
}

export function App() {
  const isPanel = new URLSearchParams(location.search).get('panel') === '1';
  const panel = usePanelContext(isPanel);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | undefined>(new URLSearchParams(location.search).get('launch') ?? undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(new URLSearchParams(location.search).get('url') ?? '');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [login, setLogin] = useState<(LoginSession & { deadline: number }) | undefined>();
  const [logs, setLogs] = useState('');
  const [terminalFor, setTerminalFor] = useState<string>();
  const [configure, setConfigure] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [overrides, setOverrides] = useState({ directory: '.', installCommand: '', startCommand: '', port: '8080' });
  const [confirmAction, setConfirmAction] = useState<'delete' | 'cancel'>();
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const selected = snapshot.launches.find((launch) => launch.id === selectedId);
  const org = snapshot.settings.currentOrg;
  const logNode = useRef<HTMLPreElement>(null);
  const snapshotRequest = useRef(0);
  const activeOperation = useRef(0);
  const selectionScope = useRef('');
  selectionScope.current = JSON.stringify([selectedId, org]);
  const resumeSource = useRef<string | undefined>(!new URLSearchParams(location.search).has('launch') ? new URLSearchParams(location.search).get('url') ?? undefined : undefined);

  const load = useCallback(async () => {
    const generation = ++snapshotRequest.current;
    const value = await request<Snapshot>({ type: 'snapshot' });
    if (generation === snapshotRequest.current) setSnapshot(value);
    return value;
  }, []);
  useEffect(() => {
    let active = true;
    void load().catch((failure) => { if (active) setError(errorText(failure)); });
    return () => { active = false; snapshotRequest.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!isPanel) return;
    let active = true;
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(_changes, 'spritesLaunch')) void load().catch((failure) => { if (active) setError(errorText(failure)); });
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); snapshotRequest.current += 1; };
  }, [isPanel, load]);

  useEffect(() => {
    const context = panel.context;
    if (!isPanel || !context) return;
    activeOperation.current += 1;
    setBusy(false);
    setCredentialEpoch((value) => value + 1);
    setSelectedId(context.launchId);
    setUrl(context.sourceUrl ?? '');
    setLogs('');
    setConfigure(false);
    setShowComposer(false);
    setTerminalFor(undefined);
    setConfirmAction(undefined);
    setToken('');
    setShowToken(false);
    setError(context.stage === 'error' ? context.error ?? 'Unable to launch this repository. Try again from GitHub.' : '');
    resumeSource.current = context.stage === 'login' ? context.sourceUrl : undefined;
  }, [isPanel, panel.context]);

  const choose = (id: string) => {
    setCredentialEpoch((value) => value + 1);
    setSelectedId(id);
    const next = new URL(location.href);
    next.searchParams.set('launch', id);
    history.replaceState(null, '', next);
    setConfigure(false);
    setShowComposer(false);
    setConfirmAction(undefined);
    setError('');
  };

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setLogs('');
    setConfigure(false);
    setTerminalFor(undefined);
    setConfirmAction(undefined);
    const item = snapshot.launches.find((launch) => launch.id === selectedId);
    const saved = item?.overrides;
    setOverrides({ directory: saved?.directory ?? '.', installCommand: saved?.installCommand ?? '', startCommand: saved?.startCommand ?? '', port: String(saved?.port ?? item?.port ?? 8080) });
    // A single status read recovers a launch after browser restart without polling idle apps.
    if (item?.provisioned && !isRunning(item.phase)) {
      void request<LaunchRecord>({ type: 'refresh', id: selectedId }).then((record) => {
        if (!record || record.id !== selectedId) throw new Error('Could not refresh the selected launch. Try again.');
        if (active) setSnapshot((previous) => ({ ...previous, launches: previous.launches.map((value) => value.id === record.id ? record : value) }));
      }).catch((failure) => { if (active) setError(errorText(failure)); });
    }
    return () => { active = false; };
  // Run when switching launches or its snapshot first arrives, not on every
  // phase update. A panel binding can arrive before the persisted record.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.id]);

  useEffect(() => { setLogs(''); }, [org]);

  const refresh = useCallback(async (id: string, withLogs = true) => {
    const scope = selectionScope.current;
    const record = await request<LaunchRecord>({ type: 'refresh', id });
    if (!record || record.id !== id) throw new Error('Could not refresh the selected launch. Try again.');
    setSnapshot((previous) => ({ ...previous, launches: previous.launches.map((value) => value.id === id ? record : value) }));
    if (withLogs && record.provisioned) {
      const output = await request<string>({ type: 'logs', id });
      if (scope === selectionScope.current && JSON.parse(scope)[0] === id) setLogs(output);
    }
    return record;
  }, []);

  useEffect(() => {
    if (!selected || !isRunning(selected.phase)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const record = await refresh(selected.id);
        if (active && isRunning(record.phase)) timer = setTimeout(poll, 3000);
      } catch (failure) {
        if (active) {
          setError(errorText(failure));
          timer = setTimeout(poll, 6000);
        }
      }
    };
    timer = setTimeout(poll, 1200);
    return () => { active = false; clearTimeout(timer); };
  }, [selected?.id, selected?.phase, refresh]);

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() > login.deadline) {
        setLogin(undefined);
        setError('Sign-in expired. Choose Connect Sprites to try again.');
        return;
      }
      try {
        const response = await request<{ status: 'pending' | 'completed'; org?: string }>({ type: 'poll_login', sessionId: login.sessionId });
        if (stopped) return;
        if (response.status === 'completed') { setLogin(undefined); await load(); }
        else timer = setTimeout(poll, 2000);
      } catch (failure) { if (!stopped) { setError(errorText(failure)); setLogin(undefined); } }
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login, load]);

  useEffect(() => {
    if (logNode.current) logNode.current.scrollTop = logNode.current.scrollHeight;
  }, [logs]);

  const perform = async (action: () => Promise<void>) => {
    const operation = ++activeOperation.current;
    setBusy(true);
    setError('');
    try { await action(); } catch (failure) { if (operation === activeOperation.current) setError(errorText(failure)); } finally { if (operation === activeOperation.current) setBusy(false); }
  };

  const start = async (forceNew = false, sourceUrl?: string) => {
    const record = await request<LaunchRecord>({ type: 'launch', url: forceNew && selected ? selected.target.sourceUrl : sourceUrl ?? url, forceNew, ...(isPanel && panel.windowId !== undefined ? { panelWindowId: panel.windowId } : {}) });
    await load();
    // The background owns the window's latest intent. A slower prior launch
    // must not replace a newer GitHub click while this request was in flight.
    if (!isPanel || panel.windowId === undefined) choose(record.id);
  };

  useEffect(() => {
    if (!org || !resumeSource.current) return;
    const source = resumeSource.current;
    resumeSource.current = undefined;
    void perform(() => start(false, source));
  // A GitHub launch interrupted by initial sign-in resumes once, never on subsequent snapshots.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, url, panel.context, panel.windowId]);

  const retry = async (custom?: LaunchOverrides) => {
    if (!selected) return;
    await request({ type: 'retry', id: selected.id, overrides: custom });
    setConfigure(false);
    await load();
  };

  const openWorkspace = async () => {
    const target = new URL(chrome.runtime.getURL('index.html'));
    if (selectedId) target.searchParams.set('launch', selectedId);
    else if (url) target.searchParams.set('url', url);
    await chrome.tabs.create({ url: target.href });
  };
  const panelPending = isPanel && !selected && (panel.context?.stage === 'resolving' || panel.context?.stage === 'launch');
  const trackingPanelLaunch = isPanel && Boolean(selectedId || panel.context?.launchId || panelPending);
  const composerVisible = !trackingPanelLaunch || showComposer;

  return <div className={`app-shell${isPanel ? ' side-panel' : ''}`}>
    <header className="topbar"><div className="brand-lockup"><a className="wordmark" href="https://fly.io" target="_blank" rel="noreferrer" aria-label="Fly.io home"><picture><source media="(prefers-color-scheme: dark)" srcSet={FLY_LOGO_INVERTED_URL} /><img src={FLY_LOGO_URL} alt="Fly.io" /></picture></a><span className="wordmark-separator" aria-hidden="true">/</span><a className="wordmark-secondary" href={chrome.runtime.getURL('index.html')}>Launch on a Sprite</a></div><span className="topbar-note"><span className="privacy-dot" />Private by default</span></header>
    <main>
      {isPanel && <div className="panel-toolbar"><span><span className="privacy-dot" />Alongside GitHub</span><div className="panel-toolbar-actions">{trackingPanelLaunch && <button className="link-button" aria-expanded={showComposer} aria-controls="launch-composer" onClick={() => { if (!showComposer) setUrl(''); setShowComposer((value) => !value); }}>{showComposer ? 'Back to launch progress' : 'Launch another repo'}</button>}<button className="link-button" onClick={() => void perform(openWorkspace)}>Open workspace tab ↗</button></div></div>}
      <div className="intro"><div><p className="eyebrow">FROM REPOSITORY TO RUNNING APP</p><h1>{isPanel ? 'Launch progress.' : 'A fresh place to launch.'}</h1><p className="intro-copy">{isPanel ? 'Keep browsing while your Sprite gets ready.' : <>Bring a GitHub repo or pull request to a persistent Sprite.<br className="desktop-break" /> We’ll check out the code and get it running.</>}</p></div><div className="connection">
        {org ? <><label className="sr-only" htmlFor="organization">Organization</label><select id="organization" value={org} disabled={busy} onChange={(event) => { setCredentialEpoch((value) => value + 1); void perform(async () => { await request({ type: 'select_org', org: event.target.value }); await load(); }); }}>{snapshot.organizations.map((name) => <option key={name}>{name}</option>)}</select><span className="connected-label"><span className="privacy-dot" />Connected</span><button className="link-button" disabled={busy} onClick={() => { setCredentialEpoch((value) => value + 1); void perform(async () => { await request({ type: 'logout', org }); await load(); }); }}>Disconnect</button></> : <><span className="connection-label">Your Sprite workspace</span><button className="button primary" disabled={busy || !!login} onClick={() => void perform(async () => { const value = await request<LoginSession>({ type: 'login' }); setLogin({ ...value, deadline: Date.now() + value.expiresIn * 1000 }); })}>{login ? 'Waiting for sign-in…' : 'Connect Sprites'}</button></>}
        {org && <button className="link-button" disabled={busy || !!login} onClick={() => void perform(async () => { const value = await request<LoginSession>({ type: 'login' }); setLogin({ ...value, deadline: Date.now() + value.expiresIn * 1000 }); })}>{login ? 'Waiting for sign-in…' : 'Connect another organization'}</button>}
        <button className="link-button" disabled={busy} onClick={() => setShowToken((value) => !value)}>Use an API token</button>
      </div></div>

      {showToken && <form className="token-form card" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await request({ type: 'token', token }); setToken(''); setShowToken(false); await load(); }); }}><label htmlFor="api-token">Sprites API token</label><div className="inline-form"><input id="api-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste your organization token" required /><button className="button primary" disabled={busy}>Connect</button></div><p className="muted">Stored only in this browser’s extension. Repository code never receives this token.</p></form>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {isPanel && panel.error && <div className="error-banner" role="alert">{panel.error}</div>}
      {panelPending && <div className="panel-preparing card" role="status" aria-busy="true"><span className="status-dot phase-installing" /><div><strong>Preparing your launch</strong><p>Resolving the exact GitHub revision before creating a Sprite.</p></div></div>}

      {composerVisible && <form id="launch-composer" className="launch-form card" onSubmit={(event) => { event.preventDefault(); void perform(() => start()); }}><label htmlFor="github-url">GITHUB REPOSITORY OR PULL REQUEST</label><div className="inline-form"><span className="source-icon" aria-hidden="true">↗</span><input id="github-url" type="url" required placeholder="https://github.com/owner/repo" value={url} onChange={(event) => setUrl(event.target.value)} /><button className="button primary launch-submit" disabled={busy || !org}><FlyMark light />Launch on a Sprite</button></div><p className="muted">Public repositories · Selected branch or PR head · Local databases when needed</p></form>}

      <div className="workspace-grid"><aside className="history"><div className="section-heading"><h2>Your launches</h2><span className="count">{snapshot.launches.length}</span></div>{snapshot.launches.length ? <ul>{[...snapshot.launches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((launch) => <li key={launch.id}><button className={`history-item ${launch.id === selectedId ? 'selected' : ''}`} onClick={() => choose(launch.id)}><span className="history-top"><span className={`status-dot phase-${launch.phase}`} /><strong>{launch.target.owner}/{launch.target.repo}</strong></span><span className="history-ref">{targetLabel(launch)} <span>· {shortSha(launch.target.sha)}</span></span><span className="history-meta">{PHASE_LABELS[launch.phase]}<span>{launch.org}</span></span></button></li>)}</ul> : <p className="empty-history">Your launched repositories will appear here.</p>}</aside>

      <section className="detail-column" aria-label="Launch details">{selected ? <>
        <article className="launch-detail card"><div className="launch-detail-top"><span className={`phase-badge phase-${selected.phase}`}><span className="status-dot" />{PHASE_LABELS[selected.phase]}</span><span className="launch-date">{formatDate(selected.createdAt)}</span></div><h2><a href={`https://github.com/${encodeURIComponent(selected.target.owner)}/${encodeURIComponent(selected.target.repo)}`} target="_blank" rel="noreferrer">{selected.target.owner}<span>/</span>{selected.target.repo}</a></h2><div className="revision"><span className="ref-tag">{targetLabel(selected)}</span><code>{shortSha(selected.target.sha)}</code><span>on {selected.org}</span></div>
          {isRunning(selected.phase) && <ol className="progress-steps" aria-label="Setup progress">{STEPS.map((step, index) => <li key={step} className={index < STEPS.indexOf(selected.phase) ? 'complete' : step === selected.phase ? 'current' : ''}><span>{index < STEPS.indexOf(selected.phase) ? '✓' : index + 1}</span><span>{step === 'ready' ? 'Ready' : step === 'database' ? 'Database' : step === 'detecting' ? 'Detect' : step === 'cloning' ? 'Checkout' : step === 'creating' ? 'Create' : step === 'installing' ? 'Install' : 'Start'}</span></li>)}</ol>}
          <p className={`launch-message ${selected.error ? 'error-text' : ''}`}>{selected.error || selected.message || (selected.phase === 'ready' ? 'Your app is running. Open the private preview or continue in the terminal.' : 'Preparing your Sprite…')}</p>
          {selected.spriteName && <dl className="launch-facts"><div><dt>Sprite</dt><dd>{selected.spriteName}</dd></div>{selected.recipe && <div><dt>Recipe</dt><dd>{selected.recipe}</dd></div>}{selected.port && <div><dt>App port</dt><dd>{selected.port}</dd></div>}</dl>}
          <div className="launch-actions">{selected.phase === 'ready' && <button className="button primary" disabled={busy} onClick={() => void perform(async () => { await request({ type: 'preview', id: selected.id }); })}>Open private preview ↗</button>}{selected.provisioned && <button className="button" disabled={busy} onClick={() => setTerminalFor((value) => value === selected.id ? undefined : selected.id)}>{terminalFor === selected.id ? 'Close terminal' : 'Open terminal'}</button>}{!isRunning(selected.phase) && <button className="button" disabled={busy} onClick={() => void perform(() => start(true))}>New Sprite</button>}{['ready', 'failed', 'cancelled', 'needs_configuration'].includes(selected.phase) && <button className="button" disabled={busy} onClick={() => void perform(() => retry())}>Retry setup</button>}<button className="button subtle" disabled={busy} onClick={() => setConfigure((value) => !value)}>{configure ? 'Hide configuration' : 'Configure'}</button></div>
          {selected.phase === 'ready' && selected.recipe === 'openclaw' && <AppConnection key={`${selected.id}:${org ?? ''}:${credentialEpoch}`} launchId={selected.id} organization={org} disabled={busy} />}
          {selected.phase === 'ready' && selected.recipe === 'hermes' && <HermesConnection key={`${selected.id}:${org ?? ''}:${credentialEpoch}`} launchId={selected.id} organization={org} disabled={busy} />}
          {selected.phase === 'ready' && !snapshot.settings.previewAuthOrganizations?.includes(selected.org) && <p className="preview-pending">Your preview stays private. An additional browser sign-in may be needed.</p>}
          {configure && <form className="config-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { const value = validOverrides(overrides.directory, overrides.installCommand, overrides.startCommand, overrides.port); await retry(value); }); }}><h3>Launch configuration</h3><p className="muted">Commands run inside this Sprite. Successful settings are remembered for this repository.</p><div className="config-grid"><label>App directory<input value={overrides.directory} onChange={(event) => setOverrides({ ...overrides, directory: event.target.value })} placeholder="." required /></label><label>HTTP port<input type="number" min="1" max="65535" value={overrides.port} onChange={(event) => setOverrides({ ...overrides, port: event.target.value })} required /></label></div><label>Install command <span className="optional">optional</span><input className="command-input" value={overrides.installCommand} onChange={(event) => setOverrides({ ...overrides, installCommand: event.target.value })} placeholder="npm ci" /></label><label>Start command<input className="command-input" value={overrides.startCommand} onChange={(event) => setOverrides({ ...overrides, startCommand: event.target.value })} placeholder="npm run dev -- --host 0.0.0.0 --port 8080" required /></label><button className="button primary" disabled={busy || isRunning(selected.phase)}>Save and retry setup</button></form>}
        </article>
        {terminalFor === selected.id && <SpriteTerminal key={selected.id} id={selected.id} />}
        <section className="logs-panel card"><div className="section-heading"><h3>Setup logs</h3><button className="link-button" disabled={busy || !selected.provisioned} onClick={() => void perform(async () => { await refresh(selected.id); })}>Refresh</button></div><pre ref={logNode} className="logs" tabIndex={0} aria-label="Setup logs">{logs || (isRunning(selected.phase) ? 'Waiting for setup output…' : 'Choose Refresh to load the latest setup output.')}</pre></section>
        <div className="workspace-controls"><span>Files stay on your Sprite until you delete it.</span><div>{isRunning(selected.phase) && <button className="link-button" disabled={busy} onClick={() => setConfirmAction('cancel')}>Cancel setup</button>}<button className="link-button danger" disabled={busy} onClick={() => setConfirmAction('delete')}>Delete Sprite</button></div></div>
        {confirmAction && <div className="confirmation card" role="alertdialog" aria-label={confirmAction === 'delete' ? 'Delete Sprite' : 'Cancel setup'}><h3>{confirmAction === 'delete' ? 'Delete this Sprite and its files?' : 'Cancel setup?'}</h3><p>{confirmAction === 'delete' ? 'This removes the Sprite and its persistent workspace. This action cannot be undone.' : 'The setup process will stop. Your Sprite, checkout, and logs will remain available.'}</p><div className="launch-actions"><button className="button" disabled={busy} onClick={() => setConfirmAction(undefined)}>Keep {confirmAction === 'delete' ? 'Sprite' : 'setting up'}</button><button className="button danger-button" disabled={busy} onClick={() => void perform(async () => { await request({ type: confirmAction, id: selected.id }); setConfirmAction(undefined); if (confirmAction === 'delete') { setSelectedId(undefined); setTerminalFor(undefined); } await load(); })}>{confirmAction === 'delete' ? 'Delete Sprite' : 'Cancel setup'}</button></div></div>}
      </> : !panelPending && <div className="empty-detail card"><span className="empty-mark"><FlyMark /></span><h2>Your next idea, up and running.</h2><p>Paste a repository above, or choose <strong>Launch on a Sprite</strong> directly on GitHub.</p><div className="empty-capabilities"><span>Exact code revision</span><span>Persistent workspace</span><span>Private app preview</span></div></div>}</section></div>
      <footer><span>Built for trying things.</span><span>Sprites sleep when idle. Running setup and open terminals may use compute.</span></footer>
    </main>
  </div>;
}

const root = document.getElementById('root');
if (root) {
  const stopBridge = startSetupBridge();
  window.addEventListener('pagehide', stopBridge, { once: true });
  createRoot(root).render(<App />);
}
