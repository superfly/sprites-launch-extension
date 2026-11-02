export interface PreviewAuthPolicy {
  readonly enabled: boolean;
  readonly orgIds: readonly string[];
}
export function parsePreviewAuthPolicy(enabled: unknown, rawOrgIds: unknown): PreviewAuthPolicy;
export function previewAuthAllowed(profile: { token: string } | undefined, policy: PreviewAuthPolicy): boolean;
