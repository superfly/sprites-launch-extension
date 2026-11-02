import { useEffect, useState } from 'react';

export interface PanelBinding {
  nonce: string;
  sourceUrl?: string;
  launchId?: string;
  stage: 'resolving' | 'login' | 'launch' | 'error' | 'idle';
  error?: string;
}

function binding(value: unknown): PanelBinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<PanelBinding>;
  if (typeof data.nonce !== 'string' || !['resolving', 'login', 'launch', 'error', 'idle'].includes(data.stage ?? '') ||
      (data.sourceUrl !== undefined && typeof data.sourceUrl !== 'string') ||
      (data.launchId !== undefined && typeof data.launchId !== 'string') ||
      (data.error !== undefined && typeof data.error !== 'string')) return undefined;
  return data as PanelBinding;
}

/** Bind to this Chrome window, never the GitHub document or another window. */
export function usePanelContext(enabled: boolean) {
  const [context, setContext] = useState<PanelBinding>();
  const [windowId, setWindowId] = useState<number>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let key: string | undefined;
    let revision = 0;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (stopped || area !== 'session' || !key || !Object.prototype.hasOwnProperty.call(changes, key)) return;
      revision += 1;
      setContext(binding(changes[key].newValue));
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.windows.getCurrent().then(async (window) => {
      if (stopped || window.id === undefined) return;
      setWindowId(window.id);
      key = `launchPanel:${window.id}`;
      const expected = revision;
      const values = await chrome.storage.session.get(key);
      if (!stopped && expected === revision) setContext(binding(values[key]));
    }).catch(() => { if (!stopped) setError('Could not reconnect the progress panel. Open the workspace tab to continue.'); });
    return () => { stopped = true; chrome.storage.onChanged.removeListener(changed); };
  }, [enabled]);
  return { context, error, windowId };
}
