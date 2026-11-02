// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://github.com/acme/web"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectButton, isRepositoryPage, selectedRef, watchGitHub } from '../src/content';
import { FLY_BRANDMARK_LIGHT_SVG, FLY_PURPLE } from '../src/brand';

beforeEach(() => {
  document.body.innerHTML = '<div id="repository-container-header"><ul class="pagehead-actions"></ul></div>';
  history.replaceState(null, '', '/acme/web');
});
afterEach(() => vi.unstubAllGlobals());

describe('GitHub launch button', () => {
  it.each([
    'https://github.com/acme/web', 'https://github.com/acme/web/tree/feature/a',
    'https://github.com/acme/web/blob/main/src/app.ts', 'https://github.com/acme/web/pull/42/files',
    'https://github.com/acme/web/actions', 'https://github.com/acme/web/issues/5',
  ])('recognizes repository context %s', (url) => expect(isRepositoryPage(url)).toBe(true));

  it.each([
    'https://github.com/acme', 'https://github.com/settings/profile', 'https://github.com/orgs/acme',
    'https://github.com/search/code', 'https://example.com/acme/web', 'http://github.com/acme/web',
    'https://github.com.evil.test/acme/web', 'https://evil@github.com/acme/web', 'not-a-url',
  ])('does not inject outside repository pages %s', (url) => expect(isRepositoryPage(url)).toBe(false));

  it('injects only one button when GitHub mutates or rerenders its header', () => {
    const first = injectButton(document, location.href);
    expect(first?.textContent).toBe('Launch on a Sprite');
    expect(injectButton(document, location.href)).toBe(first);
    expect(document.querySelectorAll('#sprites-launch-button')).toHaveLength(1);
    document.querySelector('.pagehead-actions')!.innerHTML = '';
    injectButton(document, location.href);
    expect(document.querySelectorAll('#sprites-launch-button')).toHaveLength(1);
  });

  it('places the branded action beside the repository Code dropdown and preserves native controls', () => {
    document.body.innerHTML += '<main class="repository-content"><div class="repo-tools"><button id="go-to-file">Go to file</button><div data-testid="code-button"><button>Code</button></div></div></main>';
    const button = injectButton(document, location.href)!;
    const nativeCode = document.querySelector('[data-testid="code-button"]')!;
    expect(button.parentElement?.nextElementSibling).toBe(nativeCode);
    const mark = button.querySelector<SVGSVGElement>('svg[data-fly-mark]')!;
    const officialMark = new DOMParser().parseFromString(FLY_BRANDMARK_LIGHT_SVG, 'image/svg+xml').documentElement;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute('viewBox')).toBe('0 0 1000 900');
    expect(mark.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.getAttribute('focusable')).toBe('false');
    const paths = (element: Element) => Array.from(element.querySelectorAll('path')).map((path) => ({ d: path.getAttribute('d'), style: path.getAttribute('style') }));
    expect(paths(mark)).toEqual(paths(officialMark));
    expect(paths(mark)).toHaveLength(2);
    expect(button.querySelector('[data-sprite-mark], .sprites-launch-logo-chip')).toBeNull();
    expect(button.querySelector('img')).toBeNull();
    expect(document.getElementById('sprites-launch-styles')?.textContent).toContain(`--sprite-bg:${FLY_PURPLE}`);
    expect(button.getAttribute('aria-label')).toBe('Launch this repository or pull request on a Sprite');
    expect(document.getElementById('go-to-file')?.textContent).toBe('Go to file');
    injectButton(document, location.href);
    expect(document.querySelectorAll('#sprites-launch-styles')).toHaveLength(1);
  });


  it('keeps Fly white text readable on its violet brand colour in either GitHub theme', () => {
    injectButton(document, location.href);
    const css = document.getElementById('sprites-launch-styles')!.textContent!;
    const luminance = (hex: string) => {
      const rgb = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    };
    expect(1.05 / (luminance(FLY_PURPLE) + .05)).toBeGreaterThan(4.5);
    expect(css).toContain('color:#fff;');
    expect(css).toContain('html[data-color-mode="dark"]');
    expect(css).toContain('[data-fly-mark]{display:block;width:22px;height:20px');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('moves the existing action from a fallback header when the Code toolbar arrives later', () => {
    const first = injectButton(document, location.href)!;
    expect(first.parentElement?.dataset.placement).toBe('header');
    document.body.insertAdjacentHTML('beforeend', '<main class="repository-content"><div class="repo-tools"><get-repo><details><summary>Code</summary></details></get-repo></div></main>');
    const moved = injectButton(document, location.href)!;
    expect(moved).toBe(first);
    expect(moved.parentElement?.dataset.placement).toBe('code');
    expect(moved.parentElement?.nextElementSibling?.tagName).toBe('GET-REPO');
    expect(document.querySelectorAll('#sprites-launch-control')).toHaveLength(1);
    expect(document.querySelector('.pagehead-actions')!.children).toHaveLength(0);
  });

  it('prefers pull request header actions to a stale repository Code toolbar', () => {
    document.body.innerHTML += '<div class="repo-tools"><div data-testid="code-button"><button>Code</button></div></div><div id="partial-discussion-header"><div class="gh-header-actions"><button>Edit</button></div><h1>A pull request</h1></div>';
    const button = injectButton(document, 'https://github.com/acme/web/pull/42/files')!;
    expect(button.parentElement?.parentElement).toBe(document.querySelector('.gh-header-actions'));
    expect(button.parentElement?.dataset.placement).toBe('pull');
    expect(document.querySelector('.gh-header-actions')!.textContent).toContain('Edit');
  });

  it('supports current GitHub Primer PR header actions without legacy IDs', () => {
    document.body.innerHTML = '<div data-component="PageHeader"><div data-component="TitleArea"><h1>A public pull request</h1></div><div data-component="PH_Actions"><button>Edit</button></div><div data-component="PageHeader.Description"><div>Open · contributor wants to merge</div></div></div>';
    const button = injectButton(document, 'https://github.com/acme/web/pull/42')!;
    expect(button.parentElement?.parentElement?.dataset.component).toBe('PH_Actions');
  });

  it('keeps the PR control visible when GitHub hides authenticated-only actions', () => {
    document.body.innerHTML = '<div data-component="PageHeader"><div data-component="TitleArea"><h1>A public pull request</h1></div><div data-component="PH_Actions" class="d-none"></div><div data-component="PageHeader.Description"><div id="merge-summary">Open · contributor wants to merge</div></div></div>';
    const button = injectButton(document, 'https://github.com/acme/web/pull/42/files')!;
    expect(button.parentElement?.parentElement?.id).toBe('merge-summary');
    expect(document.querySelector('[data-component="PH_Actions"]')!.classList.contains('d-none')).toBe(true);
    expect(document.querySelector('#merge-summary')!.textContent).toContain('contributor wants to merge');
  });

  it('does not reparent into itself or loop when a modern PR description is initially empty', async () => {
    history.replaceState(null, '', '/acme/web/pull/42');
    document.body.innerHTML = '<div data-component="PageHeader"><div data-component="TitleArea"><h1>A public pull request</h1></div><div data-component="PH_Actions" class="d-none"></div><div data-component="PageHeader.Description"></div></div>';
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const stop = watchGitHub(document);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settled = mutations;
    expect(document.querySelectorAll('#sprites-launch-button')).toHaveLength(1);
    expect(settled).toBeLessThan(10);
    expect(() => injectButton(document, location.href)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutations).toBe(settled);
    stop(); observer.disconnect();
  });

  it('uses the header in narrow windows rather than crowding the Code toolbar', () => {
    const previous = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    document.body.innerHTML += '<div class="repo-tools"><div data-testid="code-button"><button>Code</button></div></div>';
    const button = injectButton(document, location.href)!;
    expect(button.parentElement?.dataset.placement).toBe('header');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previous });
  });

  it('removes the button when navigating outside a repository', () => {
    injectButton(document, location.href);
    injectButton(document, 'https://github.com/notifications');
    expect(document.querySelector('#sprites-launch-button')).toBeNull();
    expect(document.querySelector('#sprites-launch-control')).toBeNull();
  });

  it('does not let a page synthesize a provisioning click', async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const button = injectButton(document, location.href)!;
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  it('reinjects after Turbo navigation without accumulating buttons', async () => {
    const stop = watchGitHub(document);
    await Promise.resolve();
    expect(document.querySelectorAll('#sprites-launch-button')).toHaveLength(1);
    history.pushState(null, '', '/other/project/pull/14');
    document.body.innerHTML = '<header data-testid="repository-header"></header>';
    document.dispatchEvent(new Event('turbo:load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll('#sprites-launch-button')).toHaveLength(1);
    history.pushState(null, '', '/notifications');
    document.dispatchEvent(new Event('turbo:load'));
    await Promise.resolve();
    expect(document.querySelector('#sprites-launch-button')).toBeNull();
    stop();
  });

  it('passes a selected slash-containing branch hint only on code pages', () => {
    document.body.innerHTML += '<div data-current-ref="feature/browser/launch"></div>';
    expect(selectedRef(document, 'https://github.com/acme/web/tree/feature/browser/launch')).toBe('feature/browser/launch');
    expect(selectedRef(document, 'https://github.com/acme/web/pull/42')).toBeUndefined();
    expect(selectedRef(document, 'https://github.com/acme/web/issues')).toBeUndefined();
  });

  it('ignores malformed branch hint text', () => {
    const ref = document.createElement('div');
    ref.dataset.currentRef = 'main\nmalicious';
    document.body.append(ref);
    expect(selectedRef(document, 'https://github.com/acme/web/tree/main')).toBeUndefined();
  });
});
