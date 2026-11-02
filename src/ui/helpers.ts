import type { LaunchPhase, LaunchRecord, Request, Response } from '../core/types';

export const PHASE_LABELS: Record<LaunchPhase, string> = {
  queued: 'Queued', creating: 'Creating Sprite', cloning: 'Checking out code', detecting: 'Detecting app',
  installing: 'Installing dependencies', database: 'Preparing local database', starting: 'Starting app',
  ready: 'Ready', needs_configuration: 'Needs configuration', failed: 'Setup failed', cancelled: 'Setup cancelled',
};
const TERMINAL_PHASES = new Set<LaunchPhase>(['ready', 'needs_configuration', 'failed', 'cancelled']);
export const isRunning = (phase: LaunchPhase) => !TERMINAL_PHASES.has(phase);
export const shortSha = (sha: string) => sha.slice(0, 8);
export const targetLabel = (launch: LaunchRecord) => launch.target.kind === 'pr' ? `PR #${launch.target.prNumber}` : launch.target.ref;
export const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

export async function request<T>(message: Request): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as Response<T>;
  if (!response?.ok) throw new Error(response?.error ?? 'The extension did not respond. Reload this tab and try again.');
  return response.data as T;
}

export function validOverrides(directory: string, installCommand: string, startCommand: string, port: string) {
  const relativeDirectory = directory.trim();
  if (!relativeDirectory || relativeDirectory.startsWith('/') || relativeDirectory.split('/').some((part) => part === '..') || /[\x00\\]/.test(relativeDirectory)) throw new Error('App directory must be relative to the checkout, such as . or apps/web.');
  if (!startCommand.trim()) throw new Error('Enter a start command.');
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Port must be a whole number from 1 to 65535.');
  return { directory: relativeDirectory, installCommand: installCommand.trim(), startCommand: startCommand.trim(), port: value };
}
