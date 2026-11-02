export const API_ORIGIN = 'https://api.sprites.dev';
export type LaunchPhase = 'queued' | 'creating' | 'cloning' | 'detecting' | 'installing' | 'database' | 'starting' | 'ready' | 'needs_configuration' | 'failed' | 'cancelled';
export interface LaunchTarget {
  owner: string;
  repo: string;
  kind: 'branch' | 'tag' | 'commit' | 'pr';
  ref: string;
  sha: string;
  cloneUrl: string;
  fetchRef: string;
  prNumber?: number;
  sourceUrl: string;
}
export interface LaunchOverrides {
  directory: string;
  installCommand: string;
  startCommand: string;
  port: number;
}
export interface RemoteState {
  phase: LaunchPhase;
  attemptId?: string;
  message?: string;
  recipe?: string;
  port?: number;
  error?: string;
  updatedAt?: string;
  setupPid?: number;
}
export interface LaunchRecord {
  id: string;
  org: string;
  target: LaunchTarget;
  spriteName: string;
  spriteId?: string;
  url?: string;
  phase: LaunchPhase;
  message?: string;
  error?: string;
  recipe?: string;
  port?: number;
  createdAt: string;
  updatedAt: string;
  setupSessionId?: string;
  setupStartedAt?: string;
  attemptId?: string;
  setupAttempts?: number;
  provisionAttempts?: number;
  terminalSessionId?: string;
  overrides?: LaunchOverrides;
  /** Only true after create succeeded or GET reconciled the intended name. */
  provisioned?: boolean;
  previewOpened?: boolean;
}
export interface Profile { org: string; token: string }
export interface Settings {
  currentOrg?: string;
  /** False until the existing preview header is verified for the deployed route and organization. */
  previewAuthVerified: boolean;
}
export interface Snapshot {
  settings: Settings;
  organizations: string[];
  launches: LaunchRecord[];
}
export type Request =
  | { type: 'snapshot' }
  | { type: 'launch'; url: string; forceNew?: boolean; refHint?: string; panelWindowId?: number }
  | { type: 'login' }
  | { type: 'poll_login'; sessionId: string }
  | { type: 'token'; token: string }
  | { type: 'select_org'; org: string }
  | { type: 'logout'; org: string }
  | { type: 'refresh'; id: string }
  | { type: 'logs'; id: string }
  | { type: 'retry'; id: string; overrides?: LaunchOverrides }
  | { type: 'cancel'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'preview'; id: string }
  | { type: 'app_connection'; id: string }
  | { type: 'hermes_connection'; id: string }
  | { type: 'terminal'; id: string; cols: number; rows: number; fresh?: boolean }
  | { type: 'terminal_session'; id: string; sessionId: string };
export interface Response<T = unknown> { ok: boolean; data?: T; error?: string }
export interface TerminalConnection { url: string }
export interface LoginSession { sessionId: string; expiresIn: number }
export const launchDirectory = (id: string) => `/home/sprite/.sprite-launch/${id}`;
