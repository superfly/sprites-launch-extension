// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://extension.test/index.html"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchRecord, Snapshot } from '../src/core/types';
import type { PanelBinding } from '../src/ui/panelContext';

vi.mock('../src/ui/Terminal', () => ({ SpriteTerminal: () => <div>Terminal fixture</div> }));
import { App } from '../src/ui/main';

let root: Root;
let node: HTMLDivElement;
let send: ReturnType<typeof vi.fn<(message: { type: string; id?: string }) => Promise<unknown>>>;
let getSession: ReturnType<typeof vi.fn>;
let createTab: ReturnType<typeof vi.fn>;
let snapshot: Snapshot;
let currentBinding: PanelBinding;
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>;
const launch: LaunchRecord = {
  id: 'launch-one', org: 'personal', spriteName: 'gh-one', phase: 'installing',
  createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  provisioned: true, url: 'https://gh-one.sprites.app', recipe: 'vite', port: 8080,
  target: { owner: 'acme', repo: 'one', kind: 'branch', ref: 'main', sha: 'a'.repeat(40), cloneUrl: 'https://github.com/acme/one.git', fetchRef: 'refs/heads/main', sourceUrl: 'https://github.com/acme/one' },
};
const other: LaunchRecord = { ...launch, id: 'launch-two', spriteName: 'gh-two', phase: 'ready', target: { ...launch.target, repo: 'two', sourceUrl: 'https://github.com/acme/two' } };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  history.replaceState(null, '', '/index.html?panel=1');
  document.body.innerHTML = '';
  snapshot = { settings: { currentOrg: 'personal', previewAuthVerified: false }, organizations: ['personal'], launches: [{ ...launch }, { ...other }] };
  currentBinding = { nonce: 'first-intent', sourceUrl: launch.target.sourceUrl, launchId: launch.id, stage: 'launch' };
  listeners = new Set();
  getSession = vi.fn(async () => ({ 'launchPanel:7': currentBinding }));
  createTab = vi.fn(async () => ({ id: 99 }));
  send = vi.fn(async (message: { type: string; id?: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'refresh' ? snapshot.launches.find((item) => item.id === message.id) : message.type === 'logs' ? 'Private setup output' : message.type === 'launch' ? other : undefined }));
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `https://extension.test/${path}`, sendMessage: send },
    windows: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    tabs: { create: createTab },
    storage: { session: { get: getSession }, onChanged: { addListener: (listener: typeof listeners extends Set<infer L> ? L : never) => listeners.add(listener), removeListener: (listener: typeof listeners extends Set<infer L> ? L : never) => listeners.delete(listener) } },
  });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function emit(changes: Record<string, chrome.storage.StorageChange>, area = 'session') {
  await act(async () => { for (const listener of [...listeners]) listener(changes, area); });
}
async function bind(value: PanelBinding) {
  currentBinding = value;
  await emit({ 'launchPanel:7': { newValue: value } });
}
async function mount() { await act(async () => root.render(<App />)); }
function button(text: string) { return [...node.querySelectorAll('button')].find((item) => item.textContent === text)!; }

describe('native progress panel', () => {
  it('pins the window launch and shows progress without provisioning again', async () => {
    await mount();
    expect(node.querySelector('.side-panel')).not.toBeNull();
    expect(node.querySelector('h1')?.textContent).toBe('Launch progress.');
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/one');
    expect(node.querySelector('[aria-label="Setup progress"]')).not.toBeNull();
    expect(node.textContent).toContain('Installing dependencies');
    expect(getSession).toHaveBeenCalledWith('launchPanel:7');
    expect(send.mock.calls.some(([message]) => message.type === 'launch')).toBe(false);
  });

  it('shows revision resolution before a launch record exists without launching from the document', async () => {
    currentBinding = { nonce: 'pending', sourceUrl: other.target.sourceUrl, stage: 'resolving' };
    await mount();
    expect(node.querySelector('[role="status"]')?.textContent).toContain('Preparing your launch');
    expect(node.querySelector('#github-url')).toBeNull();
    expect(node.querySelector('.launch-detail')).toBeNull();
    expect(send.mock.calls.some(([message]) => message.type === 'launch')).toBe(false);
  });

  it('keeps another Chrome window or storage area from changing this panel', async () => {
    await mount();
    const next = { ...currentBinding, launchId: other.id, sourceUrl: other.target.sourceUrl };
    await emit({ 'launchPanel:8': { newValue: next } });
    await emit({ 'launchPanel:7': { newValue: next } }, 'local');
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/one');
  });

  it('updates progress when the background persists a new launch state', async () => {
    await mount();
    snapshot = { ...snapshot, launches: [{ ...launch, phase: 'ready', message: 'App is running' }, other] };
    await emit({ spritesLaunch: { newValue: {} } }, 'local');
    expect(node.querySelector('.phase-badge')?.textContent).toBe('Ready');
    expect(node.textContent).toContain('App is running');
    expect(button('Open private preview ↗')).toBeDefined();
    expect(send.mock.calls.some(([message]) => message.type === 'launch')).toBe(false);
  });

  it('selects a newer GitHub launch and clears credentials and logs from the previous one', async () => {
    snapshot.launches = [{ ...launch, recipe: 'openclaw', phase: 'ready' }, other];
    send.mockImplementation(async (message: { type: string; id?: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'refresh' ? snapshot.launches.find((item) => item.id === message.id) : message.type === 'logs' ? 'First launch private log' : message.type === 'app_connection' ? { token: 'private-application-fixture-token' } : undefined }));
    await mount();
    await act(async () => button('Show connection token').click());
    await act(async () => button('Refresh').click());
    expect(node.querySelector<HTMLInputElement>('#gateway-connection-token')?.value).toBe('private-application-fixture-token');
    expect(node.querySelector('pre')?.textContent).toContain('First launch private log');
    await bind({ nonce: 'second-intent', sourceUrl: other.target.sourceUrl, launchId: other.id, stage: 'launch' });
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/two');
    expect(node.querySelector('#gateway-connection-token')).toBeNull();
    expect(node.querySelector('pre')?.textContent).not.toContain('First launch private log');
  });

  it('ignores a slow initial context read after a newer window binding arrives', async () => {
    let resolve!: (value: Record<string, PanelBinding>) => void;
    getSession.mockReturnValue(new Promise((done) => { resolve = done; }));
    await mount();
    await bind({ nonce: 'newer', launchId: other.id, sourceUrl: other.target.sourceUrl, stage: 'launch' });
    await act(async () => resolve({ 'launchPanel:7': { nonce: 'stale', launchId: launch.id, stage: 'launch' } }));
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/two');
  });

  it('resumes the exact source once after sign-in and routes it to the same native panel', async () => {
    snapshot = { ...snapshot, settings: { previewAuthVerified: false }, organizations: [], launches: [] };
    currentBinding = { nonce: 'login-intent', sourceUrl: other.target.sourceUrl, stage: 'login' };
    await mount();
    expect(send.mock.calls.some(([message]) => message.type === 'launch')).toBe(false);
    snapshot = { ...snapshot, settings: { ...snapshot.settings, currentOrg: 'personal' }, organizations: ['personal'] };
    await emit({ spritesLaunch: { newValue: {} } }, 'local');
    expect(send.mock.calls.filter(([message]) => message.type === 'launch')).toEqual([[{ type: 'launch', url: other.target.sourceUrl, forceNew: false, panelWindowId: 7 }]]);
    await emit({ spritesLaunch: { newValue: {} } }, 'local');
    expect(send.mock.calls.filter(([message]) => message.type === 'launch')).toHaveLength(1);
  });

  it('opens an ordinary workspace tab pinned to the selected launch', async () => {
    await mount();
    await act(async () => button('Open workspace tab ↗').click());
    expect(createTab).toHaveBeenCalledWith({ url: 'https://extension.test/index.html?launch=launch-one' });
  });

  it('keeps a late response from an older launch intent from selecting over a newer GitHub click', async () => {
    let resolve!: (value: unknown) => void;
    const original = send.getMockImplementation()!;
    send.mockImplementation((message: { type: string; id?: string }) => message.type === 'launch' ? new Promise((done) => { resolve = done; }) : original(message));
    await mount();
    await act(async () => button('Launch another repo').click());
    const input = node.querySelector<HTMLInputElement>('#github-url')!;
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, launch.target.sourceUrl); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Launch on a Sprite').click());
    expect(send).toHaveBeenCalledWith({ type: 'launch', url: launch.target.sourceUrl, forceNew: false, panelWindowId: 7 });
    await bind({ nonce: 'newer-click', sourceUrl: other.target.sourceUrl, launchId: other.id, stage: 'launch' });
    await act(async () => resolve({ ok: true, data: launch }));
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/two');
  });

  it('does not show logs arriving after the selected launch changes', async () => {
    let resolve!: (value: unknown) => void;
    const original = send.getMockImplementation()!;
    send.mockImplementation((message: { type: string; id?: string }) => message.type === 'logs' && message.id === launch.id ? new Promise((done) => { resolve = done; }) : original(message));
    await mount();
    await act(async () => button('Refresh').click());
    await bind({ nonce: 'newer-click', sourceUrl: other.target.sourceUrl, launchId: other.id, stage: 'launch' });
    await act(async () => resolve({ ok: true, data: 'Sensitive prior launch output' }));
    expect(node.querySelector('pre')?.textContent).not.toContain('Sensitive prior launch output');
    expect(node.querySelector('.launch-detail h2')?.textContent).toBe('acme/two');
  });

  it('hydrates saved configuration when the bound record arrives after the panel opens', async () => {
    snapshot = { ...snapshot, launches: [] };
    await mount();
    snapshot = { ...snapshot, launches: [{ ...launch, overrides: { directory: 'web', installCommand: 'npm ci', startCommand: 'npm run serve', port: 9000 } }] };
    await emit({ spritesLaunch: { newValue: {} } }, 'local');
    await act(async () => button('Configure').click());
    expect(node.querySelector<HTMLInputElement>('.config-form input')?.value).toBe('web');
    expect(node.querySelector<HTMLInputElement>('.config-form input[type="number"]')?.value).toBe('9000');
  });

  it('renders failure details as text and never as repository HTML', async () => {
    currentBinding = { nonce: 'error-intent', sourceUrl: launch.target.sourceUrl, stage: 'error', error: '<img src=x onerror=alert(1)>' };
    await mount();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(node.querySelector('img[src="x"]')).toBeNull();
  });

  it('removes window and snapshot subscriptions when the panel closes', async () => {
    await mount();
    expect(listeners.size).toBe(2);
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(node);
  });
});
