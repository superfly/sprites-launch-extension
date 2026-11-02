import type { Request, Response } from './core/types';
import { FLY_BRANDMARK_LIGHT_SVG, FLY_PURPLE } from './brand';

const BUTTON_ID = 'sprites-launch-button';
const CONTROL_ID = 'sprites-launch-control';
const STYLE_ID = 'sprites-launch-styles';
const BUTTON_LABEL = 'Launch this repository or pull request on a Sprite';
const BUTTON_TITLE = 'Launch this code in a persistent Sprite workspace';
const purpleShade = (amount: number) => '#' + FLY_PURPLE.slice(1).match(/../g)!.map((channel) => Math.round(parseInt(channel, 16) * (1 - amount)).toString(16).padStart(2, '0')).join('');
const purpleTint = (amount: number) => '#' + FLY_PURPLE.slice(1).match(/../g)!.map((channel) => Math.round(parseInt(channel, 16) * (1 - amount) + 255 * amount).toString(16).padStart(2, '0')).join('');
const BUTTON_STYLES = `
#${CONTROL_ID}{--sprite-bg:${FLY_PURPLE};--sprite-hover:${purpleShade(.12)};--sprite-border:${purpleShade(.18)};display:inline-flex;vertical-align:middle;flex:0 0 auto;align-self:center;max-width:100%;padding:0;margin:0 0 0 8px;list-style:none}
#${BUTTON_ID}{appearance:none;box-sizing:border-box;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:34px;min-width:190px;max-width:100%;margin:0;padding:6px 12px;border:1px solid var(--sprite-border);border-radius:7px;background-color:var(--sprite-bg);background-image:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,0));box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 1px 2px rgba(47,15,91,.14);color:#fff;font:600 12px/20px var(--fontStack-system,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);letter-spacing:.01em;text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;transition:background-color .16s,box-shadow .16s,transform .16s;isolation:isolate}
#${BUTTON_ID}:hover:not(:disabled){background-color:var(--sprite-hover);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 2px 5px rgba(63,24,124,.22);transform:translateY(-1px)}
#${BUTTON_ID}:active:not(:disabled){transform:translateY(0);box-shadow:inset 0 1px 2px rgba(0,0,0,.16)}
#${BUTTON_ID}:focus-visible{outline:3px solid ${purpleTint(.6)};outline-offset:3px}
#${BUTTON_ID}:disabled{cursor:wait;opacity:.85}
#${BUTTON_ID} [data-fly-mark]{display:block;width:22px;height:20px;flex:none;overflow:visible}
#${BUTTON_ID} .sprites-launch-divider{width:1px;height:14px;flex:none;background:rgba(255,255,255,.25);margin:0 1px}
#${BUTTON_ID} [data-sprite-label]{flex:1;text-align:center}
#${BUTTON_ID} [data-action-icon]{width:12px;height:12px;flex:none;opacity:.85}
#${BUTTON_ID} .sprites-launch-spinner{display:none;width:12px;height:12px;box-sizing:border-box;border:1.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:sprites-launch-spin .7s linear infinite;flex:none}
#${BUTTON_ID}[data-state="loading"] [data-action-icon]{display:none}
#${BUTTON_ID}[data-state="loading"] .sprites-launch-spinner{display:inline-block}
#${BUTTON_ID}[data-state="success"]{--sprite-bg:${purpleShade(.1)};--sprite-hover:${purpleShade(.22)}}
#${BUTTON_ID}[data-state="error"]{--sprite-bg:#936329;--sprite-hover:#7b5120;--sprite-border:#805522}
#${CONTROL_ID} .sprites-launch-sr-status{position:absolute!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;width:1px!important;height:1px!important;overflow:hidden!important;white-space:nowrap!important}
html[data-color-mode="dark"] #${CONTROL_ID}{--sprite-border:${purpleTint(.3)}}
@media(prefers-color-scheme:dark){html:not([data-color-mode="light"]) #${CONTROL_ID}{--sprite-border:${purpleTint(.3)}}}
@media(max-width:767px){#${CONTROL_ID}{margin:4px 0 4px 8px}#${BUTTON_ID}{min-height:32px;min-width:181px;padding:5px 10px;font-size:11px}}
@media(prefers-reduced-motion:reduce){#${BUTTON_ID}{transition:none}#${BUTTON_ID} .sprites-launch-spinner{animation:none}}
@keyframes sprites-launch-spin{to{transform:rotate(360deg)}}
`;
const RESERVED_OWNERS = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'site', 'sponsors', 'topics', 'trending', 'users']);
const REPOSITORY_ROUTES = new Set(['tree', 'blob', 'pull', 'pulls', 'commit', 'commits', 'issues', 'actions', 'projects', 'wiki', 'security', 'pulse', 'releases', 'tags', 'branches', 'discussions', 'settings', 'compare', 'new', 'edit', 'delete', 'find', 'network', 'forks', 'stargazers', 'watchers', 'activity', 'community', 'deployments']);

export function isRepositoryPage(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password) return false;
    const [owner, repository, route] = url.pathname.split('/').filter(Boolean);
    return Boolean(owner && repository && !RESERVED_OWNERS.has(owner.toLowerCase()) &&
      /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repository) &&
      repository !== '.' && repository !== '..' && (!route || REPOSITORY_ROUTES.has(route)));
  } catch { return false; }
}

/** A hint only: the background resolver verifies this against GitHub before provisioning. */
export function selectedRef(doc: Document, href: string): string | undefined {
  if (!/^\/(?:[^/]+\/){2}(?:tree|blob)\//.test(new URL(href).pathname)) return undefined;
  const candidates = [
    doc.querySelector<HTMLElement>('[data-current-ref]')?.dataset.currentRef,
    doc.querySelector<HTMLElement>('[data-testid="anchor-button"][data-hotkey="w"]')?.textContent,
    doc.querySelector<HTMLElement>('#branch-select-menu summary .css-truncate-target')?.textContent,
    doc.querySelector<HTMLElement>('[data-hotkey="w"] .css-truncate-target')?.textContent,
  ];
  for (const candidate of candidates) {
    const ref = candidate?.trim();
    if (ref && ref.length <= 1024 && !/[\x00-\x1f\x7f]/.test(ref)) return ref;
  }
  return undefined;
}

interface Placement { parent: HTMLElement; before?: Element; kind: 'code' | 'pull' | 'header' }

/** Prefer stable GitHub hooks; text matching is limited to actual Code buttons. */
function placement(doc: Document, href: string): Placement | undefined {
  const route = new URL(href).pathname.split('/').filter(Boolean).slice(2);
  if (route[0] === 'pull' && /^\d+$/.test(route[1] ?? '')) {
    const modernHeader = Array.from(doc.querySelectorAll<HTMLElement>('[data-component="PageHeader"]')).find((element) => element.querySelector('h1'));
    if (modernHeader) {
      const actions = modernHeader.querySelector<HTMLElement>('[data-component="PH_Actions"]');
      // GitHub hides its action region for signed-out readers; do not put our
      // control inside that hidden region or change native visibility rules.
      if (actions && !actions.hidden && !actions.classList.contains('d-none') && doc.defaultView?.getComputedStyle(actions).display !== 'none') return { parent: actions, kind: 'pull' };
      const description = modernHeader.querySelector<HTMLElement>('[data-component="PageHeader.Description"]');
      if (description) return { parent: description.firstElementChild instanceof HTMLElement && description.firstElementChild.id !== CONTROL_ID ? description.firstElementChild : description, kind: 'pull' };
      const title = modernHeader.querySelector<HTMLElement>('[data-component="TitleArea"]');
      if (title) return { parent: title, kind: 'pull' };
    }
    const actions = doc.querySelector<HTMLElement>('#partial-discussion-header .gh-header-actions, .gh-header-actions, [data-testid="pull-request-header"] [data-testid="header-actions"]');
    if (actions) return { parent: actions, kind: 'pull' };
    const heading = doc.querySelector<HTMLElement>('#partial-discussion-header, [data-testid="pull-request-header"]');
    if (heading) return { parent: heading, kind: 'pull' };
  } else if (!route[0] || route[0] === 'tree' || route[0] === 'blob') {
    // Narrow GitHub toolbars have little spare room; the header is a better home there.
    if ((doc.defaultView?.innerWidth ?? 1024) >= 900) {
      let code = doc.querySelector<HTMLElement>('[data-testid="code-button"], get-repo');
      if (!code) {
        const root = doc.querySelector<HTMLElement>('#repo-content-pjax-container, .repository-content, [data-testid="repos-overview"]');
        code = Array.from(root?.querySelectorAll<HTMLElement>('button, summary') ?? []).find((element) => element.getAttribute('aria-label') === 'Code' || element.textContent?.trim() === 'Code') ?? null;
      }
      if (code) {
        const anchor = code.closest<HTMLElement>('get-repo, [data-testid="code-button"], details') ?? code;
        if (anchor.parentElement) return { parent: anchor.parentElement, before: anchor, kind: 'code' };
      }
    }
  }
  const header = doc.querySelector<HTMLElement>('#repository-container-header .pagehead-actions, #repository-container-header, [data-testid="repository-header"]');
  return header ? { parent: header, kind: 'header' } : undefined;
}

function mount(button: HTMLButtonElement, target: Placement, doc: Document) {
  let control = button.closest<HTMLElement>(`#${CONTROL_ID}`);
  const tag = target.parent.tagName === 'UL' ? 'LI' : 'SPAN';
  if (!control || control.tagName !== tag) {
    const replacement = doc.createElement(tag.toLowerCase());
    replacement.id = CONTROL_ID;
    replacement.append(button);
    control?.remove();
    control = replacement;
  }
  control.dataset.placement = target.kind;
  if (control.parentElement !== target.parent || target.before && control.nextElementSibling !== target.before) target.parent.insertBefore(control, target.before ?? null);
}

function svg(doc: Document, path: string): SVGSVGElement {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('data-action-icon', '');
  const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'none');
  shape.setAttribute('stroke', 'currentColor'); shape.setAttribute('stroke-width', '1.6'); shape.setAttribute('stroke-linecap', 'round'); shape.setAttribute('stroke-linejoin', 'round');
  icon.append(shape);
  return icon;
}

function brandLogo(doc: Document): SVGSVGElement {
  // This static, bundled asset is Fly's official monochrome brandmark. Keep
  // its paths and opacity intact; no repository HTML enters this parser.
  const parser = new (doc.defaultView?.DOMParser ?? DOMParser)();
  const source = parser.parseFromString(FLY_BRANDMARK_LIGHT_SVG, 'image/svg+xml');
  const icon = doc.importNode(source.documentElement, true) as unknown as SVGSVGElement;
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  icon.setAttribute('data-fly-mark', '');
  return icon;
}

export function injectButton(doc: Document = document, href = location.href): HTMLButtonElement | undefined {
  const previous = doc.getElementById(BUTTON_ID);
  if (!isRepositoryPage(href)) {
    (previous?.closest(`#${CONTROL_ID}`) ?? previous)?.remove();
    return undefined;
  }
  const target = placement(doc, href);
  if (!target) return undefined;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = BUTTON_STYLES;
    (doc.head ?? doc.documentElement).append(style);
  }
  if (previous instanceof HTMLButtonElement) { mount(previous, target, doc); return previous; }

  const button = doc.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.dataset.state = 'idle';
  button.title = BUTTON_TITLE;
  button.setAttribute('aria-label', BUTTON_LABEL);
  const divider = doc.createElement('span');
  divider.className = 'sprites-launch-divider';
  divider.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.setAttribute('data-sprite-label', '');
  label.textContent = 'Launch on a Sprite';
  const spinner = doc.createElement('span');
  spinner.className = 'sprites-launch-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  button.append(brandLogo(doc), divider, label, svg(doc, 'M4 12 12 4M5 4h7v7'), spinner);
  let reset: ReturnType<typeof setTimeout> | undefined;
  const setState = (state: string, text: string, description: string) => {
    button.dataset.state = state;
    label.textContent = text;
    button.title = description;
    button.setAttribute('aria-description', description);
    button.setAttribute('aria-busy', String(state === 'loading'));
  };
  button.addEventListener('click', async (event) => {
    // A repository page cannot programmatically provision infrastructure.
    if (!event.isTrusted || button.disabled) return;
    const currentUrl = doc.defaultView?.location.href ?? href;
    if (!isRepositoryPage(currentUrl)) return;
    if (reset) clearTimeout(reset);
    button.disabled = true;
    setState('loading', 'Launching…', 'Preparing your Sprite. Follow progress in the side panel.');
    try {
      const request: Request = { type: 'launch', url: currentUrl, refHint: selectedRef(doc, currentUrl) };
      const response = await chrome.runtime.sendMessage(request) as Response;
      if (!response?.ok) throw new Error(response?.error || 'Unable to launch. Open the extension to sign in.');
      setState('success', 'Sprite opened', 'Follow progress in the side panel. Click to open this launch again.');
      reset = setTimeout(() => { if (button.isConnected) setState('idle', 'Launch on a Sprite', BUTTON_TITLE); }, 3500);
    } catch (error) {
      setState('error', 'Try launch again', error instanceof Error ? error.message : 'Unable to launch. Open the extension and try again.');
    } finally {
      button.disabled = false;
    }
  });
  mount(button, target, doc);
  return button;
}

export function watchGitHub(doc: Document = document): () => void {
  let queued = false;
  let stopped = false;
  const update = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      injectButton(doc, doc.defaultView?.location.href ?? location.href);
    });
  };
  const observer = new MutationObserver(update);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener('turbo:load', update);
  doc.addEventListener('pjax:end', update);
  doc.defaultView?.addEventListener('popstate', update);
  doc.defaultView?.addEventListener('resize', update);
  update();
  return () => {
    observer.disconnect();
    stopped = true;
    doc.removeEventListener('turbo:load', update);
    doc.removeEventListener('pjax:end', update);
    doc.defaultView?.removeEventListener('popstate', update);
    doc.defaultView?.removeEventListener('resize', update);
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof document !== 'undefined') watchGitHub();
