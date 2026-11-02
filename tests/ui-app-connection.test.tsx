// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConnection } from '../src/ui/AppConnection';

const SECRET = 'local-fixture-gateway-token-with-no-service-privileges';
let root: Root;
let node: HTMLDivElement;
let send: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  send = vi.fn().mockResolvedValue({ ok: true, data: { token: SECRET } });
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

async function reveal() {
  const button = [...node.querySelectorAll('button')].find((value) => value.textContent === 'Show connection token')!;
  await act(async () => button.click());
}

describe('OpenClaw application credential', () => {
  it('fetches only on an explicit reveal click and keeps the result masked and out of text', async () => {
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    expect(send).not.toHaveBeenCalled();
    expect(node.querySelector('input')).toBeNull();
    await reveal();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'app_connection', id: 'launch-one' });
    const field = node.querySelector('input')!;
    expect(field.type).toBe('password');
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(SECRET);
    expect(node.textContent).not.toContain(SECRET);
    expect(node.textContent).toContain('finish model setup there');
  });

  it.each([
    { launchId: 'launch-two', organization: 'personal' },
    { launchId: 'launch-one', organization: 'team' },
    { launchId: 'launch-one', organization: undefined },
  ])('clears the credential when launch or organization context changes: %o', async (next) => {
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    await reveal();
    await act(async () => root.render(<AppConnection {...next} />));
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    if (!next.organization) expect(node.querySelector('button')!.disabled).toBe(true);
  });

  it('does not expose a late credential response after switching launches', async () => {
    let resolve!: (value: unknown) => void;
    send.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    await reveal();
    await act(async () => root.render(<AppConnection launchId="launch-two" organization="personal" />));
    await act(async () => resolve({ ok: true, data: { token: SECRET } }));
    expect(node.querySelector('input')).toBeNull();
    expect(node.textContent).not.toContain(SECRET);
  });

  it('discards a pending credential response when the view unmounts', async () => {
    let resolve!: (value: unknown) => void;
    send.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    await reveal();
    await act(async () => root.render(null));
    await act(async () => resolve({ ok: true, data: { token: SECRET } }));
    expect(node.innerHTML).toBe('');
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('copies only after a user click and keeps the masked field selectable when clipboard access fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error(`${SECRET}: clipboard permission denied`));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    await reveal();
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => [...node.querySelectorAll('button')].find((value) => value.textContent === 'Copy token')!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(SECRET);
    expect(node.textContent).toContain('Select the token field and copy it manually');
    expect(node.textContent).not.toContain(SECRET);
    const field = node.querySelector('input')!;
    expect(field.value).toBe(SECRET);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(SECRET.length);
  });

  it('clears the token on Hide and fetches a new value only if explicitly revealed again', async () => {
    await act(async () => root.render(<AppConnection launchId="launch-one" organization="personal" />));
    await reveal();
    await act(async () => [...node.querySelectorAll('button')].find((value) => value.textContent === 'Hide token')!.click());
    expect(node.querySelector('input')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    await reveal();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
