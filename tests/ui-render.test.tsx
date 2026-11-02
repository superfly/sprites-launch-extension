// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://extension.test/index.html"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchRecord, Snapshot } from '../src/core/types';

vi.mock('../src/ui/Terminal', () => ({ SpriteTerminal: () => <div>Terminal fixture</div> }));
import { App } from '../src/ui/main';

let root: Root;
let node: HTMLDivElement;
const launch: LaunchRecord = {
  id: 'launch-fixture', org: 'personal', spriteName: 'gh-web-fixture', phase: 'ready',
  createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
  provisioned: true, url: 'https://gh-web-fixture.sprites.app', recipe: 'vite', port: 8080,
  target: { owner: 'acme', repo: 'web', kind: 'pr', ref: 'feature/web', sha: 'a'.repeat(40), cloneUrl: 'https://github.com/acme/web.git', fetchRef: 'refs/pull/7/head', prNumber: 7, sourceUrl: 'https://github.com/acme/web/pull/7' },
};
let snapshot: Snapshot;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  history.replaceState(null, '', '/index.html?launch=launch-fixture');
  document.body.innerHTML = '';
  snapshot = { settings: { currentOrg: 'personal', previewAuthVerified: false }, organizations: ['personal'], launches: [launch] };
  send = vi.fn(async (message: { type: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'refresh' ? launch : message.type === 'logs' ? '<script>alert("untrusted log")</script>' : undefined }));
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `https://extension.test/${path}`, sendMessage: send } });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe('launch page', () => {
  it('renders source revision and enables private preview through browser sign-in before seamless auth is enabled', async () => {
    await act(async () => root.render(<App />));
    expect(node.textContent).toContain('PR #7');
    expect(node.textContent).toContain('aaaaaaaa');
    expect(node.textContent).toContain('additional browser sign-in');
    const preview = [...node.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Open private preview'))!;
    expect(preview.disabled).toBe(false);
    await act(async () => preview.click());
    expect(send).toHaveBeenCalledWith({ type: 'preview', id: launch.id });
  });

  it('renders remote logs as plain text', async () => {
    await act(async () => root.render(<App />));
    const refresh = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')!;
    await act(async () => refresh.click());
    expect(node.querySelector('pre')?.textContent).toContain('<script>alert("untrusted log")</script>');
    expect(node.querySelector('script')).toBeNull();
  });

  it('can retry a ready launch to apply recipe fixes on the same Sprite', async () => {
    await act(async () => root.render(<App />));
    const retry = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Retry setup')!;
    expect(retry).toBeDefined();
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(send).toHaveBeenCalledWith({ type: 'retry', id: launch.id, overrides: undefined });
    expect(send.mock.calls.some(([message]) => message.type === 'launch')).toBe(false);
  });

  it('requires the explicit destructive confirmation before deleting a Sprite', async () => {
    await act(async () => root.render(<App />));
    const deleteButton = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Delete Sprite')!;
    await act(async () => deleteButton.click());
    expect(send.mock.calls.some(([message]) => message.type === 'delete')).toBe(false);
    const dialog = node.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('cannot be undone');
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Delete Sprite')!;
    await act(async () => confirm.click());
    expect(send).toHaveBeenCalledWith({ type: 'delete', id: launch.id });
  });

  it('resumes a GitHub launch once after sign-in and never repeats it on refresh', async () => {
    history.replaceState(null, '', '/index.html?url=https%3A%2F%2Fgithub.com%2Facme%2Fweb');
    send.mockImplementation(async (message: { type: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : ['launch', 'refresh'].includes(message.type) ? launch : undefined }));
    await act(async () => root.render(<App />));
    expect(send.mock.calls.filter(([message]) => message.type === 'launch')).toHaveLength(1);
    await act(async () => root.render(<App />));
    expect(send.mock.calls.filter(([message]) => message.type === 'launch')).toHaveLength(1);
  });

  it.each([
    { recipe: 'vite', phase: 'ready' as const },
    { recipe: 'openclaw', phase: 'starting' as const },
  ])('omits Gateway credentials outside a ready OpenClaw launch: %o', async (attributes) => {
    snapshot.launches = [{ ...launch, ...attributes }];
    await act(async () => root.render(<App />));
    expect(node.querySelector('[aria-label="OpenClaw Gateway connection"]')).toBeNull();
    expect(send.mock.calls.some(([message]) => message.type === 'app_connection')).toBe(false);
  });

  it('clears a revealed Gateway token immediately when selecting a different launch', async () => {
    const token = 'local-openclaw-application-fixture-token';
    const other = { ...launch, id: 'second-launch', recipe: 'openclaw', target: { ...launch.target, repo: 'other' } };
    snapshot.launches = [{ ...launch, recipe: 'openclaw' }, other];
    send.mockImplementation(async (message: { type: string; id?: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'app_connection' ? { token } : message.type === 'refresh' ? snapshot.launches.find((item) => item.id === message.id) : undefined }));
    await act(async () => root.render(<App />));
    expect(send.mock.calls.some(([message]) => message.type === 'app_connection')).toBe(false);
    await act(async () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'Show connection token')!.click());
    expect(node.querySelector<HTMLInputElement>('#gateway-connection-token')?.value).toBe(token);
    await act(async () => node.querySelectorAll<HTMLButtonElement>('.history-item')[1].click());
    expect(node.querySelector('#gateway-connection-token')).toBeNull();
    expect(send.mock.calls.filter(([message]) => message.type === 'app_connection')).toHaveLength(1);
  });

  it('clears the Gateway token on logout before the background request completes', async () => {
    const token = 'local-openclaw-application-fixture-token';
    let finishLogout!: (value: unknown) => void;
    snapshot.launches = [{ ...launch, recipe: 'openclaw' }];
    send.mockImplementation((message: { type: string }) => message.type === 'logout' ? new Promise((resolve) => { finishLogout = resolve; }) : Promise.resolve({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'app_connection' ? { token } : undefined }));
    await act(async () => root.render(<App />));
    await act(async () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'Show connection token')!.click());
    expect(node.querySelector<HTMLInputElement>('#gateway-connection-token')?.value).toBe(token);
    await act(async () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'Disconnect')!.click());
    expect(node.querySelector('#gateway-connection-token')).toBeNull();
    expect([...node.querySelectorAll('button')].find((button) => button.textContent === 'Show connection token')!.disabled).toBe(true);
    snapshot = { ...snapshot, settings: { ...snapshot.settings, currentOrg: undefined }, organizations: [] };
    await act(async () => finishLogout({ ok: true }));
    expect(node.querySelector('#gateway-connection-token')).toBeNull();
  });

  it.each([
    { recipe: 'vite', phase: 'ready' as const },
    { recipe: 'openclaw', phase: 'ready' as const },
    { recipe: 'hermes', phase: 'starting' as const },
    { recipe: 'hermes', phase: 'needs_configuration' as const },
  ])('omits Hermes sign-in outside a ready Hermes launch: %o', async (attributes) => {
    snapshot.launches = [{ ...launch, ...attributes }];
    await act(async () => root.render(<App />));
    expect(node.querySelector('[aria-label="Hermes dashboard sign-in"]')).toBeNull();
    expect(send.mock.calls.some(([message]) => message.type === 'hermes_connection')).toBe(false);
  });

  it('offers ready Hermes sign-in without reading private credentials until requested', async () => {
    snapshot.launches = [{ ...launch, recipe: 'hermes' }];
    send.mockImplementation(async (message: { type: string }) => ({ ok: true, data: message.type === 'snapshot' ? snapshot : message.type === 'hermes_connection' ? { username: 'sprite', password: 'private-hermes-ui-fixture-password' } : undefined }));
    await act(async () => root.render(<App />));
    const signIn = node.querySelector('[aria-label="Hermes dashboard sign-in"]')!;
    expect(signIn).not.toBeNull();
    expect(signIn.querySelector('input')).toBeNull();
    expect(send.mock.calls.some(([message]) => message.type === 'hermes_connection')).toBe(false);
    await act(async () => [...signIn.querySelectorAll('button')].find((button) => button.textContent === 'Show sign-in details')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'hermes_connection', id: launch.id });
    expect(signIn.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('private-hermes-ui-fixture-password');
    expect(node.querySelector('[aria-label="OpenClaw Gateway connection"]')).toBeNull();
  });
});
