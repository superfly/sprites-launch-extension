import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { previewRule } from '../src/core/security';

// These are local browser-transport fixtures, not a production API qualification.
const TOKEN = 'fixture-org/123/fixture-token/local-only-no-service-privileges';
const SHA = 'a'.repeat(40);
interface ObservedRequest { host: string; pathname: string; authorization?: string; previewAuthorization?: string; websocket: boolean }
interface FixtureSprite { id: string; name: string; url: string; url_settings: { auth: string }; ready: boolean; attemptId?: string }
let server: Server;
let port: number;
let fixtureDirectory: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profileDirectory: string;
const observed: ObservedRequest[] = [];
const sprites = new Map<string, FixtureSprite>();
const sockets = new Set<Duplex>();
let holdReady = false;

function frame(text: string, binary = false) {
  const data = Buffer.from(text);
  const opcode = binary ? 0x82 : 0x81;
  return data.length < 126 ? Buffer.concat([Buffer.from([opcode, data.length]), data]) : Buffer.concat([Buffer.from([opcode, 126, data.length >> 8, data.length & 255]), data]);
}

function githubFixture(pathname: string) {
  const pull = pathname.includes('/pull/');
  return `<!doctype html><html data-color-mode="light"><head><title>acme/web · GitHub</title><style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--panel:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;color:var(--fg);background:var(--bg)}
  html[data-color-mode=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--panel:#161b22;color-scheme:dark}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}button,input{font:inherit;color:inherit}button{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 12px;white-space:nowrap}input{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
  .global-header{height:64px;display:flex;align-items:center;gap:22px;padding:0 32px;background:var(--panel);border-bottom:1px solid var(--line)}.github-wordmark{font-size:22px;font-weight:700;letter-spacing:-.5px}.global-search{margin-left:auto;width:310px;color:var(--muted);font-size:12px}#repository-container-header{padding:22px 32px 0}.repository-heading{display:flex;align-items:center;justify-content:space-between}.repository-heading h1{font-size:20px;font-weight:400;margin:0;color:#0969da}.public-badge{display:inline-block;color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:20px;padding:2px 7px;margin-left:10px}.pagehead-actions{padding:0;margin:0;display:flex;align-items:center;gap:8px;list-style:none}.pagehead-actions button{font-size:12px}.repo-tabs{display:flex;gap:27px;margin-top:20px;height:44px;align-items:center;font-size:14px;border-bottom:1px solid var(--line)}.repo-tabs .active{font-weight:600;align-self:stretch;display:flex;align-items:center;border-bottom:2px solid #fd8c73}.repo-tabs span small{font-size:11px;color:var(--muted);background:var(--line);padding:1px 5px;border-radius:10px;margin-left:5px}.repository-content{max-width:1280px;margin:24px auto;padding:0 32px}.repo-action-toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:20px}.branch-group,.repo-tools{display:flex;align-items:center;gap:8px}.branch-group>span{color:var(--muted);font-size:12px;margin-left:10px}.repo-tools input{width:230px;font-size:12px}.code-button{background:#1f883d;border-color:#1a7f37;color:white;font-weight:600}.source-layout{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:30px}.file-list{border:1px solid var(--line);border-radius:6px;overflow:hidden}.commit-line{background:var(--panel);padding:15px 16px;display:flex;justify-content:space-between;font-size:12px}.file-row{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:11px 16px;font-size:13px}.file-row span:first-child{min-width:150px}.file-row span:nth-child(2){color:var(--muted);flex:1}.file-row time{font-size:12px;color:var(--muted)}.readme{border:1px solid var(--line);border-radius:6px;margin-top:20px}.readme-label{font-size:12px;padding:14px 16px;border-bottom:1px solid var(--line);font-weight:600}.readme-content{padding:25px 32px 38px}.readme-content h1{font-size:30px;margin:0 0 17px;padding-bottom:16px;border-bottom:1px solid var(--line)}.readme-content p{line-height:1.7;max-width:650px}.readme-content code{background:var(--panel);border-radius:6px;padding:3px 6px;font-size:12px}.about h2{font-size:16px;margin:0 0 14px}.about p{font-size:14px;line-height:1.6}.about a{display:block;color:#0969da;font-size:13px;margin:14px 0}.about small{color:var(--muted);display:block;margin-top:24px}.gh-header-actions{display:flex;align-items:center;gap:8px;float:right}.gh-header-actions>button{font-size:12px}#partial-discussion-header{border-bottom:1px solid var(--line);padding:0 0 24px;margin-bottom:22px}#partial-discussion-header h1{font-size:30px;font-weight:400;line-height:1.5;margin:0 0 12px}.pr-number{color:var(--muted)}.open-badge{background:#1f883d;border-radius:20px;color:white;padding:6px 12px;font-size:13px;margin-right:10px}.pull-summary{font-size:13px;color:var(--muted)}.pull-card{border:1px solid var(--line);border-radius:6px;margin-top:18px;padding:20px;line-height:1.7}.pull-card small{color:var(--muted)}
  </style></head><body><header class="global-header"><span class="github-wordmark">GitHub</span><span>Product</span><span>Solutions</span><span>Open Source</span><input class="global-search" placeholder="Search or jump to…" /><span>◉</span></header>
  <div id="repository-container-header"><div class="repository-heading"><h1>▣ &nbsp; acme / <strong>web</strong><span class="public-badge">Public</span></h1><ul class="pagehead-actions"><li><button>Watch ▾</button></li><li><button>⑂ Fork &nbsp; 128</button></li><li><button>☆ Star &nbsp; 1.2k</button></li></ul></div><nav class="repo-tabs"><span class="${pull ? '' : 'active'}">⌘ &nbsp;Code</span><span>◉ &nbsp;Issues <small>24</small></span><span class="${pull ? 'active' : ''}">⑂ &nbsp;Pull requests <small>7</small></span><span>▷ &nbsp;Actions</span><span>▦ &nbsp;Projects</span><span>◇ &nbsp;Security</span><span>▥ &nbsp;Insights</span></nav></div>
  <main id="repo-content-pjax-container" class="repository-content">${pull ? '<div id="partial-discussion-header"><div class="gh-header-actions"><button>Edit</button><button>Code ▾</button></div><h1>Add browser workspace launcher <span class="pr-number">#7</span></h1><div class="pull-summary"><span class="open-badge">◉ &nbsp;Open</span><strong>contributor</strong> wants to merge 3 commits into <code>main</code> from <code>feature/browser</code></div></div><div class="repo-tabs"><span class="active">Conversation &nbsp;3</span><span>Commits &nbsp;3</span><span>Checks &nbsp;5</span><span>Files changed &nbsp;12</span></div><article class="pull-card"><small>contributor commented 2 hours ago</small><h2>A workspace for every idea</h2><p>This change adds a browser launcher for trying the app in a fresh development environment.</p><p>Check out this branch, run the app, and explore the changes.</p></article>' : '<div class="repo-action-toolbar"><div class="branch-group"><button data-current-ref="main">⑂ &nbsp;main ▾</button><span>1 branch &nbsp;·&nbsp; 3 tags</span></div><div class="repo-tools"><input placeholder="Go to file" /><button>+ Add file ▾</button><div data-testid="code-button"><button class="code-button">⌘ &nbsp;Code ▾</button></div></div></div><div class="source-layout"><div><div class="file-list"><div class="commit-line"><strong>acme &nbsp; Improve development setup</strong><span>a4f2d8b &nbsp;·&nbsp; 2 hours ago</span></div>'+['.github','public','src','tests','README.md','package.json','pnpm-lock.yaml'].map((name)=>`<div class="file-row"><span>${name.includes('.') ? '▤' : '▣'} &nbsp;${name}</span><span>${name==='README.md'?'Document getting started':'Improve development setup'}</span><time>2 hours ago</time></div>`).join('')+'</div><section class="readme"><div class="readme-label">README.md</div><div class="readme-content"><h1>Web</h1><p>A small starting point for a new idea. Clone the repo, install the dependencies, and make it your own.</p><h2>Getting started</h2><p>Start the development server with <code>pnpm dev</code>, or launch a persistent workspace directly from this repository.</p></div></section></div><aside class="about"><h2>About</h2><p>A thoughtful starting point for building something new.</p><a>▧ &nbsp;acme.dev</a><p>TypeScript &nbsp;·&nbsp; Web &nbsp;·&nbsp; Open source</p><small>◷ &nbsp;Readme<br /><br />⚖ &nbsp;MIT license<br /><br />☆ &nbsp;1.2k stars<br /><br />⑂ &nbsp;128 forks</small></aside></div>'}</main></body></html>`;
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'sprite-browser-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(fixtureDirectory, 'key.pem'), '-out', path.join(fixtureDirectory, 'cert.pem'), '-subj', '/CN=api.sprites.dev', '-days', '1'], { stdio: 'ignore' });
  const [key, cert] = await Promise.all([readFile(path.join(fixtureDirectory, 'key.pem')), readFile(path.join(fixtureDirectory, 'cert.pem'))]);
  server = createServer({ key, cert }, async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', `https://${host}`);
    observed.push({ host, pathname: url.pathname, authorization: req.headers.authorization, previewAuthorization: req.headers['x-sprites-authorization'] as string | undefined, websocket: false });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (host === 'api.github.com') {
      if (url.pathname === '/repos/acme/web') return json({ private: false, default_branch: 'main' });
      if (url.pathname === '/repos/acme/web/commits/main') return json({ sha: SHA });
      if (url.pathname === '/repos/acme/web/pulls/7') return json({ head: { ref: 'feature/browser', sha: SHA, repo: null } });
      return json({ message: 'Not found' }, 404);
    }
    if (host === 'api.sprites.dev') {
      if (url.pathname === '/api/v1/token_sessions') return json({ session_id: 'browser-fixture-session-id', auth_url: 'https://sprites.dev/auth/cli/browser-fixture-session-id', expires_in: 600 }, 201);
      if (url.pathname.startsWith('/api/v1/token_sessions/')) return json({ status: 'completed', token: TOKEN, organization: { slug: 'fixture-org' } });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ error: 'Unauthorized' }, 401);
      if (url.pathname === '/v1/sprites') {
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk.toString();
          const parsed = JSON.parse(body);
          const sprite: FixtureSprite = { id: `fixture-${parsed.name}`, name: parsed.name, url: `https://${parsed.name}.sprites.app`, url_settings: { auth: 'sprite' }, ready: false };
          sprites.set(sprite.name, sprite); return json(sprite, 201);
        }
        return json({ sprites: [...sprites.values()] });
      }
      const match = /^\/v1\/sprites\/([^/]+)(.*)$/.exec(url.pathname);
      const sprite = match ? sprites.get(match[1]) : undefined;
      if (!match || !sprite) return json({ error: 'Not found' }, 404);
      if (!match[2]) {
        if (req.method === 'DELETE') { sprites.delete(sprite.name); return json({}); }
        return json(sprite);
      }
      if (match[2] === '/fs/write') {
        let body = ''; for await (const chunk of req) body += chunk.toString();
        if (url.searchParams.get('path')?.endsWith('manifest.json')) sprite.attemptId = JSON.parse(body).attemptId;
        return json({});
      }
      if (match[2] === '/fs/delete') return json({});
      if (match[2] === '/exec') return json({ sessions: [{ id: '900', command: 'bash', tty: true }] });
      if (match[2] === '/fs/read') {
        if (url.searchParams.get('path')?.endsWith('state.json')) return sprite.ready ? json({ phase: holdReady ? 'installing' : 'ready', attemptId: sprite.attemptId, recipe: 'static', port: 8080, message: holdReady ? 'Installing fixture dependencies.' : 'Local browser fixture ready.' }) : json({ error: 'Not found' }, 404);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Fixture checkout verified\nFixture application ready\n' + (holdReady ? '<script>window.compromised=true</script>\n' : '')); return;
      }
      return json({});
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (host === 'github.com') {
      res.end(githubFixture(url.pathname));
    } else if (host.endsWith('.sprites.app')) {
      res.end('<!doctype html><html><head><title>Private Sprite fixture</title></head><body><h1>Sprite preview fixture</h1><script>fetch("/asset"); window.hmr = new WebSocket("wss://" + location.host + "/hmr");</script></body></html>');
    } else res.end('<!doctype html><title>Sprite sign-in fixture</title><p>Fixture sign-in complete.</p>');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', `https://${host}`);
    observed.push({ host, pathname: url.pathname, authorization: req.headers.authorization, previewAuthorization: req.headers['x-sprites-authorization'] as string | undefined, websocket: true });
    if (host === 'api.sprites.dev' && req.headers.authorization !== `Bearer ${TOKEN}`) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const match = /^\/v1\/sprites\/([^/]+)\/exec/.exec(url.pathname);
    if (host === 'api.sprites.dev' && match) {
      const sprite = sprites.get(match[1]);
      if (sprite && url.searchParams.getAll('cmd').some((command) => command.endsWith('/bootstrap.py'))) sprite.ready = true;
      socket.write(frame(JSON.stringify({ type: 'session_info', session_id: '900', tty: url.searchParams.get('tty') === 'true' })));
      if (url.searchParams.get('tty') === 'true') socket.write(frame('Local browser fixture terminal\r\nsprite@workspace:~/project$ ', true));
    }
    socket.on('data', (data) => { if ((data[0] & 0xf) === 8) socket.end(Buffer.from([0x88, 0])); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

test.afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

test.beforeEach(async () => {
  observed.length = 0; sprites.clear(); holdReady = false;
  profileDirectory = await mkdtemp(path.join(tmpdir(), 'sprite-browser-profile-'));
  context = await chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`,
      '--ignore-certificate-errors', '--no-proxy-server',
      `--host-resolver-rules=MAP github.com 127.0.0.1:${port},MAP api.github.com 127.0.0.1:${port},MAP api.sprites.dev 127.0.0.1:${port},MAP sprites.dev 127.0.0.1:${port},MAP *.sprites.app 127.0.0.1:${port}`,
    ],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
});

test.afterEach(async () => {
  await context?.close();
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
});

async function openExtension() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(page.getByRole('heading', { name: 'A fresh place to launch.' })).toBeVisible();
  return page;
}

async function message<T = unknown>(page: Page, request: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  return page.evaluate((value) => chrome.runtime.sendMessage(value), request);
}

async function connect(page: Page) {
  const result = await message(page, { type: 'token', token: TOKEN });
  expect(result.ok, result.error).toBe(true);
}

test('real GitHub content script injects once, follows Turbo navigation, and rejects synthetic clicks', async () => {
  const page = await context.newPage();
  await page.goto('https://github.com/acme/web');
  const button = page.getByRole('button', { name: 'Launch this repository or pull request on a Sprite' });
  await expect(button).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('#repository-container-header')!.append(document.createElement('div'));
    document.dispatchEvent(new Event('turbo:load'));
    document.querySelector<HTMLButtonElement>('#sprites-launch-button')!.click();
  });
  await expect(button).toHaveCount(1);
  expect(sprites.size).toBe(0);
  await page.evaluate(() => {
    history.pushState(null, '', '/acme/web/pull/7/files');
    document.querySelector('.pagehead-actions')!.innerHTML = '';
    document.dispatchEvent(new Event('turbo:load'));
  });
  await expect(button).toHaveCount(1);
  await page.evaluate(() => { history.pushState(null, '', '/notifications'); document.dispatchEvent(new Event('turbo:load')); });
  await expect(page.locator('#sprites-launch-button')).toHaveCount(0);
});

test('branded GitHub action sits beside Code and in PR actions in light and dark themes', async ({}, testInfo) => {
  const page = await context.newPage();
  await page.goto('https://github.com/acme/web');
  const control = page.locator('#sprites-launch-control');
  const button = page.getByRole('button', { name: 'Launch this repository or pull request on a Sprite' });
  await expect(button).toBeVisible();
  await expect(control).toHaveAttribute('data-placement', 'code');
  await expect(button.locator('svg[data-fly-mark]')).toHaveCount(1);
  await expect(button.locator('svg[data-fly-mark] path')).toHaveCount(2);
  await expect(button).toHaveCSS('background-color', 'rgb(124, 58, 237)');
  const boxes = await Promise.all([button.boundingBox(), page.locator('[data-testid="code-button"]').boundingBox()]);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
  await page.screenshot({ path: testInfo.outputPath('github-cta-light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: testInfo.outputPath('github-cta-dark.png'), fullPage: true });
  await page.goto('https://github.com/acme/web/pull/7');
  await expect(page.locator('.gh-header-actions #sprites-launch-button')).toBeVisible();
  await expect(page.locator('#sprites-launch-control')).toHaveAttribute('data-placement', 'pull');
  await page.screenshot({ path: testInfo.outputPath('github-pr-cta-light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  await page.screenshot({ path: testInfo.outputPath('github-pr-cta-dark.png'), fullPage: true });
  await page.evaluate(() => {
    document.querySelector('#partial-discussion-header')!.outerHTML = '<div data-component="PageHeader"><div data-component="TitleArea"><h1>A modern public pull request</h1></div><div data-component="PH_Actions" class="d-none" style="display:none"></div><div data-component="PageHeader.Description"><div>Open · contributor wants to merge into main</div></div></div>';
  });
  await expect(page.locator('[data-component="PageHeader.Description"] #sprites-launch-button')).toBeVisible();
  await expect(page.locator('#sprites-launch-button')).toHaveCount(1);
});

test('browser sign-in stores credentials only in trusted extension storage', async () => {
  const page = await openExtension();
  await page.getByRole('button', { name: 'Connect Sprites', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  const snapshot = await message<{ organizations: string[] }>(page, { type: 'snapshot' });
  expect(snapshot.data?.organizations).toEqual(['fixture-org']);
  expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  const gh = await context.newPage();
  const isolated = await context.newCDPSession(gh);
  const contentContexts: number[] = [];
  isolated.on('Runtime.executionContextCreated', ({ context: execution }) => {
    if (execution.origin === `chrome-extension://${extensionId}`) contentContexts.push(execution.id);
  });
  await isolated.send('Runtime.enable');
  await gh.goto('https://github.com/acme/web');
  await expect.poll(() => contentContexts.length).toBeGreaterThan(0);
  // Exercise the actual extension content-script world: it has Chrome APIs but
  // must be denied trusted storage and privileged background requests.
  const storageRead = await isolated.send('Runtime.evaluate', {
    contextId: contentContexts.at(-1), awaitPromise: true, returnByValue: true,
    expression: '(async () => { try { return {data: await chrome.storage.local.get(null)}; } catch (error) { return {error: String(error)}; } })()',
  });
  expect(storageRead.result.value.data).toBeUndefined();
  expect(storageRead.result.value.error).toBeTruthy();
  const panelStateRead = await isolated.send('Runtime.evaluate', {
    contextId: contentContexts.at(-1), awaitPromise: true, returnByValue: true,
    expression: '(async () => { try { return {data: await chrome.storage.session.get(null)}; } catch (error) { return {error: String(error)}; } })()',
  });
  expect(panelStateRead.result.value.data).toBeUndefined();
  expect(panelStateRead.result.value.error).toBeTruthy();
  const privilegedRead = await isolated.send('Runtime.evaluate', { contextId: contentContexts.at(-1), expression: 'chrome.runtime.sendMessage({type:"snapshot"})', awaitPromise: true, returnByValue: true });
  expect(privilegedRead.result.value.ok).toBe(false);
  expect(JSON.stringify(privilegedRead.result.value)).not.toContain(TOKEN);
});

test('full workspace launch reuses the exact SHA and keeps browser preview credential-free before API release', async ({}, testInfo) => {
  const ui = await openExtension();
  await connect(ui);
  await ui.reload();
  await expect(ui.getByText('Connected', { exact: true }).first()).toBeVisible();
  const gh = await context.newPage();
  await gh.goto('https://github.com/acme/web/pull/7/files');
  await ui.bringToFront();
  await ui.locator('#github-url').fill('https://github.com/acme/web/pull/7/files');
  const [launchPage] = await Promise.all([
    context.waitForEvent('page'),
    ui.getByRole('button', { name: 'Launch on a Sprite', exact: true }).click(),
  ]);
  await launchPage.waitForURL(/index\.html\?launch=/);
  await expect.poll(() => sprites.size).toBe(1);
  await expect(launchPage.getByText('Ready', { exact: true }).first()).toBeVisible();
  await expect(launchPage.getByText('PR #7', { exact: true }).first()).toBeVisible();
  const sprite = [...sprites.values()][0];
  await launchPage.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(launchPage.getByText('Connected', { exact: true }).last()).toBeVisible();
  const handshake = observed.find((item) => item.websocket && item.host === 'api.sprites.dev');
  expect(handshake?.authorization).toBe(`Bearer ${TOKEN}`);
  const exactExec = `wss://api.sprites.dev/v1/sprites/${sprite.name}/exec?tty=true`;
  await gh.evaluate(async (url) => {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(url);
      socket.onopen = () => { socket.close(); resolve(); };
      socket.onerror = () => resolve();
    });
  }, exactExec);
  expect(observed.filter((item) => item.websocket && item.host === 'api.sprites.dev').at(-1)?.authorization).toBeUndefined();
  await launchPage.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket('wss://api.sprites.dev/v1/sprites/unowned-sprite/exec');
      socket.onopen = () => { socket.close(); resolve(); };
      socket.onerror = () => resolve();
    });
  });
  expect(observed.find((item) => item.pathname === '/v1/sprites/unowned-sprite/exec')?.authorization).toBeUndefined();
  await expect.poll(() => observed.filter((item) => item.host === new URL(sprite.url).hostname).length).toBeGreaterThan(0);
  for (const request of observed.filter((item) => item.host.endsWith('.sprites.app'))) expect(request.previewAuthorization).toBeUndefined();
  const [reusedPage] = await Promise.all([
    context.waitForEvent('page'),
    ui.getByRole('button', { name: 'Launch on a Sprite', exact: true }).click(),
  ]);
  await reusedPage.waitForURL(/index\.html\?launch=/);
  await expect.poll(() => sprites.size).toBe(1);
  await launchPage.evaluate(async () => {
    await document.fonts.load('400 16px Inter');
    await document.fonts.ready;
  });
  expect(await launchPage.evaluate(() => [...document.fonts].some((font) => font.family === 'Mackinac' && font.status === 'loaded'))).toBe(true);
  expect(await launchPage.evaluate(() => [...document.fonts].some((font) => font.family === 'Inter' && font.status === 'loaded'))).toBe(true);
  await expect(launchPage.locator('.wordmark img')).toHaveAttribute('alt', 'Fly.io');
  expect(await launchPage.locator('.wordmark img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await launchPage.screenshot({ path: testInfo.outputPath('launch-ui.png'), fullPage: true, animations: 'disabled' });
  await launchPage.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => launchPage.locator('.wordmark img').evaluate((image: HTMLImageElement) => image.currentSrc.includes('logo-inverted') && image.complete)).toBe(true);
  await launchPage.screenshot({ path: testInfo.outputPath('launch-ui-dark.png'), fullPage: true, animations: 'disabled' });
  await launchPage.emulateMedia({ colorScheme: 'light' });
  await launchPage.setViewportSize({ width: 480, height: 900 });
  expect(await launchPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await launchPage.screenshot({ path: testInfo.outputPath('launch-ui-narrow.png'), fullPage: true, animations: 'disabled' });
  const snap = await message<{ launches: { target: { sha: string; fetchRef: string } }[] }>(ui, { type: 'snapshot' });
  expect(snap.data?.launches[0].target).toMatchObject({ sha: SHA, fetchRef: 'refs/pull/7/head' });
});

test('GitHub launch opens a native progress sidebar and keeps GitHub active through readiness', async ({}, testInfo) => {
  const ui = await openExtension();
  await connect(ui);
  // With the workspace tab closed, the genuine native side-panel document
  // must own setup's authenticated WebSocket acknowledgement.
  await ui.close();
  holdReady = true;
  const gh = await context.newPage();
  await gh.goto('https://github.com/acme/web/pull/7/files');
  await gh.getByRole('button', { name: 'Launch this repository or pull request on a Sprite' }).click();
  const nativePanels = () => worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] })).map(({ contextType, documentUrl, windowId }) => ({ contextType, documentUrl, windowId })));
  await expect.poll(async () => (await nativePanels()).filter((view) => view.documentUrl === `chrome-extension://${extensionId}/index.html?panel=1`).length).toBe(1);
  await expect.poll(() => sprites.size).toBe(1);
  await expect.poll(() => [...sprites.values()][0].ready).toBe(true);
  const progress = () => worker.evaluate(async () => {
    const state = (await chrome.storage.local.get('spritesLaunch')).spritesLaunch;
    const launch = Object.values(state?.launches ?? {})[0] as { id?: string; phase?: string } | undefined;
    return { id: launch?.id, phase: launch?.phase };
  });
  await expect.poll(async () => (await progress()).phase).toBe('installing');
  const activeURL = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
  expect(await activeURL()).toBe('https://github.com/acme/web/pull/7/files');
  expect(context.pages().filter((page) => page.url().includes('index.html?launch='))).toHaveLength(0);
  expect(observed.find((request) => request.websocket && request.host === 'api.sprites.dev')?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(await gh.locator('body').innerText()).not.toContain('Fixture checkout verified');
  expect(await gh.locator('body').innerText()).not.toContain(TOKEN);
  for (const request of observed.filter((item) => ['github.com','api.github.com'].includes(item.host))) {
    expect(request.authorization).toBeUndefined();
    expect(request.previewAuthorization).toBeUndefined();
  }

  // Playwright does not expose Chrome's native side-panel surface as a Page.
  // Render that same bundled panel document in a fixture tab for DOM/layout
  // assertions; the runtime-context assertion above verifies the actual panel.
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1000 });
  await panel.goto(`chrome-extension://${extensionId}/index.html?panel=1`);
  await expect(panel.locator('.side-panel')).toBeVisible();
  await expect(panel.getByText('Installing dependencies', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('PR #7', { exact: true }).first()).toBeVisible();
  await expect(panel.locator('.launch-form')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Launch on a Sprite', exact: true })).toHaveCount(0);
  await expect(panel.locator('.logs')).toContainText('<script>window.compromised=true</script>');
  expect(await panel.locator('.logs script').count()).toBe(0);
  expect(await panel.evaluate(() => Object.prototype.hasOwnProperty.call(window, 'compromised'))).toBe(false);
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('launch-panel-progress.png'), fullPage: true, animations: 'disabled' });

  holdReady = false;
  await gh.bringToFront();
  await expect.poll(async () => (await progress()).phase).toBe('ready');
  await expect(panel.getByText('Ready', { exact: true }).first()).toBeVisible();
  await expect(panel.locator('.launch-form')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Launch on a Sprite', exact: true })).toHaveCount(0);
  expect(await activeURL()).toBe('https://github.com/acme/web/pull/7/files');
  const sprite = [...sprites.values()][0];
  await expect.poll(() => observed.some((request) => request.host === new URL(sprite.url).hostname)).toBe(true);
  for (const request of observed.filter((item) => item.host.endsWith('.sprites.app'))) expect(request.previewAuthorization).toBeUndefined();
  await gh.getByRole('button', { name: 'Launch this repository or pull request on a Sprite' }).click();
  await expect.poll(() => sprites.size).toBe(1);
  await expect.poll(async () => (await nativePanels()).length).toBe(1);
  expect(context.pages().filter((page) => page.url().includes('index.html?launch='))).toHaveLength(0);
  expect(await activeURL()).toBe('https://github.com/acme/web/pull/7/files');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: testInfo.outputPath('launch-panel-ready-dark.png'), fullPage: true, animations: 'disabled' });
  await panel.getByRole('button', { name: 'Launch another repo', exact: true }).click();
  await expect(panel.locator('.launch-form')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Launch on a Sprite', exact: true })).toBeVisible();
  expect(sprites.size).toBe(1);
  const [workspace] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: 'Open workspace tab', exact: false }).click(),
  ]);
  await workspace.waitForURL(/index\.html\?launch=/);
  expect(sprites.size).toBe(1);
  await expect(workspace.getByText('PR #7', { exact: true }).first()).toBeVisible();
});

test('actual Chrome DNR preview rules authenticate only the owned exact host and tab, including HMR', async () => {
  const pageEvent = context.waitForEvent('page');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.create({ url: 'about:blank' })).id!);
  const page = await pageEvent;
  const rule = previewRule(701, 'https://owned.sprites.app', tabId, TOKEN);
  await worker.evaluate(async (value) => chrome.declarativeNetRequest.updateSessionRules({ addRules: [value] }), rule);
  await page.goto('https://owned.sprites.app');
  await expect.poll(() => observed.some((item) => item.host === 'owned.sprites.app' && item.websocket)).toBe(true);
  const scoped = observed.filter((item) => item.host === 'owned.sprites.app' && ['/', '/asset', '/hmr'].includes(item.pathname));
  expect(scoped.some((item) => item.pathname === '/' && !item.websocket)).toBe(true);
  expect(scoped.some((item) => item.pathname === '/asset')).toBe(true);
  for (const request of scoped) expect(request.previewAuthorization).toBe(`Bearer ${TOKEN}`);
  const otherTab = await context.newPage();
  await otherTab.goto('https://owned.sprites.app/other-tab');
  await page.goto('https://other.sprites.app/other-host');
  await expect.poll(() => observed.some((item) => item.pathname === '/other-tab')).toBe(true);
  expect(observed.find((item) => item.pathname === '/other-tab')?.previewAuthorization).toBeUndefined();
  expect(observed.find((item) => item.pathname === '/other-host')?.previewAuthorization).toBeUndefined();
});
