// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesConnection } from '../src/ui/HermesConnection';

const USERNAME = 'fixture-dashboard-user';
const PASSWORD = 'local-fixture-password-with-no-service-privileges';
let root: Root;
let node: HTMLDivElement;
let send: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  send = vi.fn().mockResolvedValue({ ok: true, data: { username: USERNAME, password: PASSWORD } });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});

const render = async (props: { launchId: string; organization?: string; disabled?: boolean } = { launchId: 'launch-one', organization: 'personal' }) => {
  await act(async () => root.render(<HermesConnection {...props} />));
};

const button = (label: string) => {
  const result = [...node.querySelectorAll('button')].find((value) => value.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
};

const click = async (label: string) => { await act(async () => button(label).click()); };
const reveal = () => click('Show sign-in details');
const field = (name: 'username' | 'password') => {
  const label = [...node.querySelectorAll('label')].find((value) => value.textContent === `Hermes dashboard ${name}`)!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
};
const clipboard = (writeText: ReturnType<typeof vi.fn>) => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
};

describe('Hermes dashboard credentials', () => {
  it('reads only after an explicit reveal, with scoped labels and a masked password', async () => {
    await render();
    expect(node.textContent).toContain('Hermes dashboard sign-in');
    expect(send).not.toHaveBeenCalled();
    expect(node.querySelector('input')).toBeNull();
    await reveal();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'hermes_connection', id: 'launch-one' });
    expect(field('username').type).toBe('text');
    expect(field('username').value).toBe(USERNAME);
    expect(field('password').type).toBe('password');
    expect(field('password').value).toBe(PASSWORD);
    for (const input of node.querySelectorAll('input')) {
      expect(input.readOnly).toBe(true);
      expect(input.autocomplete).toBe('off');
    }
    expect(node.textContent).not.toContain(USERNAME);
    expect(node.textContent).not.toContain(PASSWORD);
  });

  it.each([
    { launchId: 'launch-one' },
    { launchId: 'launch-one', organization: 'personal', disabled: true },
  ])('does not fetch without an available signed-in organization: %o', async (props) => {
    await render(props);
    expect(button('Show sign-in details').disabled).toBe(true);
    await reveal();
    expect(send).not.toHaveBeenCalled();
  });

  it('copies the exact requested field only after its copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    await render();
    await reveal();
    expect(writeText).not.toHaveBeenCalled();
    await click('Copy username');
    expect(writeText).toHaveBeenLastCalledWith(USERNAME);
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Username copied.');
    await click('Copy password');
    expect(writeText.mock.calls).toEqual([[USERNAME], [PASSWORD]]);
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Password copied.');
    expect(send).toHaveBeenCalledTimes(1);
    expect(node.textContent).not.toContain(PASSWORD);
  });

  it.each(['username', 'password'] as const)('allows manual selection of %s when clipboard access fails without disclosing error details', async (name) => {
    const writeText = vi.fn().mockRejectedValue(new Error(`${PASSWORD}: clipboard denied`));
    clipboard(writeText);
    await render();
    await reveal();
    await click(`Copy ${name}`);
    const selected = field(name);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(name === 'username' ? USERNAME : PASSWORD);
    expect(document.activeElement).toBe(selected);
    expect(selected.selectionStart).toBe(0);
    expect(selected.selectionEnd).toBe(selected.value.length);
    expect(node.textContent).toContain(`Select the ${name} field and copy it manually`);
    expect(node.textContent).not.toContain(PASSWORD);
    expect(node.textContent).not.toContain('clipboard denied');
  });

  it('clears both credentials on Hide and reads again only after another reveal', async () => {
    await render();
    await reveal();
    await click('Hide');
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    await reveal();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { username: USERNAME },
    { username: USERNAME, password: '' },
    { username: '', password: PASSWORD },
    { username: 42, password: PASSWORD },
  ])('uses a generic error and reveals no partial credentials for an invalid result: %o', async (data) => {
    send.mockResolvedValue({ ok: true, data });
    await render();
    await reveal();
    expect(node.querySelector('input')).toBeNull();
    expect(node.querySelector('[role="alert"]')?.textContent).toBe('Unable to read the Hermes dashboard sign-in details. Try again.');
    expect(node.textContent).not.toContain(USERNAME);
    expect(node.textContent).not.toContain(PASSWORD);
  });

  it('does not display credential-bearing service errors', async () => {
    send.mockResolvedValue({ ok: false, error: `Credential missing: ${PASSWORD}` });
    await render();
    await reveal();
    expect(node.textContent).toContain('Unable to read the Hermes dashboard sign-in details');
    expect(node.textContent).not.toContain(PASSWORD);
    expect(node.textContent).not.toContain('Credential missing');
  });

  const contexts = [
    { launchId: 'launch-two', organization: 'personal' },
    { launchId: 'launch-one', organization: 'team' },
    { launchId: 'launch-one', organization: undefined },
    { launchId: 'launch-one', organization: 'personal', disabled: true },
  ];

  it.each(contexts)('clears existing credentials across launch, organization, logout, and disabled changes: %o', async (next) => {
    await render();
    await reveal();
    await render(next);
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    await render();
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(contexts)('discards a late reveal response after context changes: %o', async (next) => {
    let resolve!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await reveal();
    await render(next);
    await act(async () => resolve({ ok: true, data: { username: USERNAME, password: PASSWORD } }));
    expect(node.querySelector('input')).toBeNull();
    expect(node.querySelector('[role="alert"]')).toBeNull();
    expect(node.textContent).not.toContain(PASSWORD);
  });

  it('discards a pending reveal after unmount, without retaining credentials in a new view', async () => {
    let resolve!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await reveal();
    await act(async () => root.render(null));
    await act(async () => resolve({ ok: true, data: { username: USERNAME, password: PASSWORD } }));
    expect(node.innerHTML).toBe('');
    await render();
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('ignores a stale clipboard %s after selecting another launch and revealing its credentials', async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    clipboard(vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; })));
    await render();
    await reveal();
    await click('Copy password');
    await render({ launchId: 'launch-two', organization: 'personal' });
    send.mockResolvedValue({ ok: true, data: { username: 'second-user', password: 'second-password' } });
    await reveal();
    await act(async () => outcome === 'resolve' ? resolve() : reject(new Error(PASSWORD)));
    expect(field('username').value).toBe('second-user');
    expect(field('password').value).toBe('second-password');
    expect(node.querySelector('[role="status"]')).toBeNull();
    expect(document.activeElement).not.toBe(field('password'));
    expect(node.textContent).not.toContain(PASSWORD);
  });

  it.each(['hide', 'logout', 'disabled', 'unmount'] as const)('does not restore credentials when copying completes after %s', async (action) => {
    let resolve!: () => void;
    clipboard(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    await render();
    await reveal();
    await click('Copy username');
    if (action === 'hide') await click('Hide');
    else if (action === 'logout') await render({ launchId: 'launch-one' });
    else if (action === 'disabled') await render({ launchId: 'launch-one', organization: 'personal', disabled: true });
    else await act(async () => root.render(null));
    await act(async () => resolve());
    expect(node.querySelector('input')).toBeNull();
    expect(node.querySelector('[role="status"]')).toBeNull();
  });
});
