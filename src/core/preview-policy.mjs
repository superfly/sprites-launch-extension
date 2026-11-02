const MAX_ORG_ID = 9223372036854775807n;

function orgId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return undefined;
  const number = BigInt(value);
  return number > 0n && number <= MAX_ORG_ID ? number.toString() : undefined;
}

/** One shared parser for the build metadata and the bundled runtime policy. */
export function parsePreviewAuthPolicy(enabled, rawOrgIds) {
  if (![undefined, '', false, true, 'false', 'true'].includes(enabled)) {
    throw new Error('VITE_PREVIEW_AUTH_VERIFIED must be true or false.');
  }
  if (enabled !== true && enabled !== 'true') return Object.freeze({ enabled: false, orgIds: Object.freeze([]) });
  if (typeof rawOrgIds !== 'string' || !rawOrgIds.trim()) {
    throw new Error('Enabled preview authentication requires VITE_PREVIEW_AUTH_ORG_IDS with qualified numeric organization IDs.');
  }
  const ids = rawOrgIds.split(',').map(value => orgId(value.trim()));
  if (ids.some(value => value === undefined)) {
    throw new Error('VITE_PREVIEW_AUTH_ORG_IDS must contain only qualified positive numeric organization IDs, separated by commas.');
  }
  return Object.freeze({ enabled: true, orgIds: Object.freeze([...new Set(ids)].sort()) });
}

/** Tokens are validated by the API before storage. This checks scope, not auth. */
export function previewAuthAllowed(profile, policy) {
  if (!policy.enabled || !profile || typeof profile.token !== 'string') return false;
  const parts = profile.token.split('/');
  if (parts.length !== 4 || !/^[a-z\d-]+$/i.test(parts[0]) ||
      !/^[\w-]+$/.test(parts[2]) || !/^[\w.-]+$/.test(parts[3])) return false;
  // The slug is descriptive and can be relabeled without changing the token's
  // authority. Qualification must use its canonical numeric organization ID.
  const id = orgId(parts[1]);
  return id !== undefined && policy.orgIds.includes(id);
}
