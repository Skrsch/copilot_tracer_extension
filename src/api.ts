// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

import type {CopilotQuota, UsageResult, UsageItem} from './types.js';

const GITHUB_API_BASE = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Typed error classes
// ---------------------------------------------------------------------------

/** GitHub API returned 401 — token expired or revoked. */
export class TokenExpiredError extends Error {
  constructor() {
    super('GitHub token is invalid or has been revoked (401)');
    this.name = 'TokenExpiredError';
  }
}

/** GitHub API returned 403 — insufficient scopes. */
export class InsufficientScopeError extends Error {
  constructor(url: string) {
    super(`GitHub token lacks required permissions for: ${url}`);
    this.name = 'InsufficientScopeError';
  }
}

/** GitHub API returned 404 — resource not found. */
export class NotFoundError extends Error {
  constructor(url: string) {
    super(`GitHub resource not found: ${url}`);
    this.name = 'NotFoundError';
  }
}

/** GitHub API returned 429 — rate limit exceeded. */
export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfter = 60) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function throwOnHttpError(
    response: Response, url: string): Promise<void> {
  if (response.ok) {
    return;
  }
  if (response.status === 401) {
    throw new TokenExpiredError();
  }
  if (response.status === 403) {
    throw new InsufficientScopeError(url);
  }
  if (response.status === 404) {
    throw new NotFoundError(url);
  }
  const body = await response.text().catch(() => '');
  throw new Error(
      `GitHub API ${response.status} at ${url}: ${body.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/** Resolves the authenticated user's login name. */
export async function fetchUsername(token: string): Promise<string> {
  const url = `${GITHUB_API_BASE}/user`;
  const response = await fetch(url, {headers: buildHeaders(token)});
  await throwOnHttpError(response, url);
  const data = (await response.json()) as {login: string};
  return data.login;
}

/**
 * PRIMARY DATA SOURCE — works for ALL plan types (Individual, Business,
 * Enterprise).
 *
 * Calls the same internal endpoint the GitHub Copilot VS Code extension uses
 * to render the quota counter in its own status bar item. The token is the
 * VS Code GitHub OAuth session token — no PAT required.
 *
 * Returns null if the response doesn\'t contain quota data (e.g. Unlimited
 * plan, or the endpoint is unavailable).
 */
export async function fetchCopilotInternalQuota(
    vsCodeToken: string,
    logger?: (msg: string) => void,
    ): Promise<CopilotQuota|'try_business'|null> {
  const _log = logger ?? (() => {});
  const url = `${GITHUB_API_BASE}/copilot_internal/v2/token`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${vsCodeToken}`,
      Accept: 'application/json',
      'editor-version': 'vscode/1.90.0',
      'editor-plugin-version': 'copilot-tracer/1.0.0',
    },
  });

  if (response.status === 429) {
    const retryHeader = response.headers.get('retry-after');
    const retryAfter = retryHeader ? parseInt(retryHeader, 10) : 60;
    const body = await response.text().catch(() => '');
    throw new RateLimitError(
        `GitHub API rate limit exceeded (429). ${body}`.trim(),
        isNaN(retryAfter) ? 60 : retryAfter);
  }

  if (!response.ok) {
    _log(`copilot_internal/v2/token returned ${response.status}`);
    return null;
  }

  const data = (await response.json()) as Record<string, unknown>;
  _log(`Raw token response keys: ${Object.keys(data || {}).join(', ')}`);
  if (data && typeof data.token === 'string') {
    try {
      const parts = data.token.split('.');
      if (parts.length > 1) {
        const payload = Buffer.from(parts[1], 'base64').toString('utf8');
        _log(`Decoded Copilot token payload: ${payload}`);
      }
    } catch (e) {
      _log(`Failed to decode token payload: ${e}`);
    }
  }

  const lq = data?.limited_user_quotas as Record<string, unknown>| undefined;
  if (!lq) {
    _log('limited_user_quotas is null/missing (Business/Enterprise plan).');
    return 'try_business';
  }

  // Iterate over keys of limited_user_quotas to find the storage object
  for (const key of Object.keys(lq)) {
    const val = lq[key] as Record<string, unknown> | undefined;
    if (!val) { continue; }

    const storage = val.storage as {
      quota?: number;
      remaining?: number;
      used?: number;
    } | undefined;

    if (storage && typeof storage.quota === 'number') {
      const unit = key.toLowerCase().includes('credit') ? 'credits' : 'requests';
      const resetAt = (val.quota_reset_at as string) ?? (val.reset_at as string) ?? '';
      _log(`Found quota under limited_user_quotas.${key} (${unit}): used=${storage.used}, remaining=${storage.remaining}, quota=${storage.quota}`);
      return {
        used: storage.used ?? (storage.quota - (storage.remaining ?? 0)),
        remaining: storage.remaining ?? 0,
        quota: storage.quota,
        resetAt,
        unit
      };
    }
  }

  _log('No valid quota storage object found under limited_user_quotas.');
  return 'try_business';
}

// ---------------------------------------------------------------------------
// Business plan: GET /copilot_internal/user
// ---------------------------------------------------------------------------

/**
 * Fetches Copilot usage for Business/Enterprise plans via the
 * `/copilot_internal/user` endpoint.  This returns `quota_snapshots`
 * with per-category breakdowns including `premium_interactions`.
 *
 * Response shape (relevant parts):
 * ```
 * {
 *   "quota_reset_date": "2026-03-01",
 *   "quota_snapshots": {
 *     "premium_interactions": {
 *       "entitlement": 300,
 *       "remaining": 61,
 *       "unlimited": false
 *     }
 *   }
 * }
 * ```
 */
export async function fetchCopilotBusinessQuota(
    oauthToken: string,
    logger?: (msg: string) => void,
    ): Promise<CopilotQuota|null> {
  const _log = logger ?? (() => {});
  const url = `${GITHUB_API_BASE}/copilot_internal/user`;
  _log(`Fetching Business quota from ${url}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 429) {
    const retryHeader = response.headers.get('retry-after');
    const retryAfter = retryHeader ? parseInt(retryHeader, 10) : 60;
    throw new RateLimitError(
        'Rate limited on /copilot_internal/user',
        isNaN(retryAfter) ? 60 : retryAfter);
  }

  if (!response.ok) {
    _log(`/copilot_internal/user returned ${response.status}`);
    return null;
  }

  const rawBody = await response.text();
  _log(`Raw /copilot_internal/user response: ${rawBody}`);
  const data = JSON.parse(rawBody) as {
    quota_reset_date?: string;
    quota_reset_date_utc?: string;
    quota_snapshots?: {
      premium_interactions?: {
        entitlement?: number;
        remaining?: number;
        quota_remaining?: number;
        unlimited?: boolean;
      };
    };
  };


  const snapshots = data?.quota_snapshots as Record<string, {
    entitlement?: number;
    remaining?: number;
    quota_remaining?: number;
    unlimited?: boolean;
  }> | undefined;
  if (!snapshots || Object.keys(snapshots).length === 0) {
    _log('No quota_snapshots found. Assuming unlimited plan.');
    return {
      used: 0,
      remaining: Infinity,
      quota: Infinity,
      resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? '',
      unit: 'requests',
      unlimited: true
    };
  }

  for (const key of Object.keys(snapshots)) {
    const pi = snapshots[key];
    if (pi) {
      const unit = key.toLowerCase().includes('credit') ? 'credits' : 'requests';
      const quota = pi.entitlement ?? 0;
      const remaining = pi.remaining ?? Math.round(pi.quota_remaining ?? 0);
      const used = quota - remaining;

      if (pi.unlimited) {
        _log(`Business quota under quota_snapshots.${key} (${unit}) is UNLIMITED.`);
        return {
          used: 0,
          remaining: Infinity,
          quota: Infinity,
          resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? '',
          unit,
          unlimited: true
        };
      } else if (pi.entitlement !== undefined) {
        _log(`Business quota under quota_snapshots.${key} (${unit}): used=${used}, remaining=${remaining}, quota=${quota}`);
        return {
          used,
          remaining,
          quota,
          resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? '',
          unit,
          unlimited: false
        };
      }
    }
  }

  _log('No premium_interactions or other valid quota found in quota_snapshots. Assuming unlimited plan.');
  return {
    used: 0,
    remaining: Infinity,
    quota: Infinity,
    resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? '',
    unit: 'requests',
    unlimited: true
  };
}

/** Helper to extract Copilot usage and detect whether it uses requests or credits. */
export function extractUsageFromItems(items?: UsageItem[]): { quantity: number; unit: 'requests' | 'credits' } {
  if (!items || items.length === 0) {
    return { quantity: 0, unit: 'requests' };
  }

  // First, look for any credit-based SKUs
  const creditItems = items.filter(
    (i) =>
      i.sku === 'copilot_ai_credit' ||
      i.sku === 'copilot_ai_credits' ||
      i.sku === 'coding_agent_ai_credit' ||
      i.sku === 'spark_ai_credit' ||
      (i.sku.toLowerCase().includes('copilot') && i.sku.toLowerCase().includes('credit')) ||
      i.sku.toLowerCase().includes('ai_credit')
  );

  if (creditItems.length > 0) {
    const totalCredits = creditItems.reduce((sum, item) => sum + (item.grossQuantity ?? 0), 0);
    return { quantity: totalCredits, unit: 'credits' };
  }

  // Fall back to request-based SKU
  const requestItem = items.find((i) => i.sku === 'copilot_premium_request');
  return {
    quantity: requestItem ? requestItem.grossQuantity : 0,
    unit: 'requests'
  };
}

/**
 * Fetches Copilot billing usage from the **personal** billing API.
 * Works for GitHub Copilot Individual plans.
 * Always returns 0 for Business/Enterprise users.
 */
export async function fetchPersonalUsage(
    token: string,
    username: string,
    ): Promise<{ quantity: number; unit: 'requests' | 'credits' }> {
  const url =
      `${GITHUB_API_BASE}/users/${username}/settings/billing/usage/summary`;
  const response = await fetch(url, {headers: buildHeaders(token)});
  await throwOnHttpError(response, url);

  const data = (await response.json()) as {usageItems?: UsageItem[]};
  return extractUsageFromItems(data.usageItems);
}

/**
 * Fetches Copilot billing usage from the **org** billing API.
 * Requires the token to have Administration:read org permission, and the
 * user must be an org owner or billing manager.
 */
export async function fetchOrgBillingUsage(
    token: string,
    orgName: string,
    ): Promise<{ quantity: number; unit: 'requests' | 'credits' }> {
  // Try legacy usage summary endpoint first
  const url =
      `${GITHUB_API_BASE}/orgs/${orgName}/settings/billing/usage/summary`;
  const response = await fetch(url, {headers: buildHeaders(token)});
  await throwOnHttpError(response, url);

  const data = (await response.json()) as {usageItems?: UsageItem[]};
  return extractUsageFromItems(data.usageItems);
}

/**
 * Fetches this user's Copilot seat assignment for a given org.
 * Returns the seat info including last_activity and assignee details.
 * Requires `manage_billing:copilot` or `read:org` scope.
 */
export async function fetchCopilotSeatForUser(
    token: string,
    orgName: string,
    username: string,
    ):
    Promise<{assignee: {login: string}; last_activity_at: string | null}|null> {
  const url = `${GITHUB_API_BASE}/orgs/${orgName}/copilot/billing/seats`;
  const response = await fetch(url, {headers: buildHeaders(token)});
  // 404 / 403 just means the user isn't an admin — not fatal
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as {
    seats?: Array<{assignee: {login: string}; last_activity_at: string | null}>
  };
  return data.seats?.find((s) => s.assignee.login === username) ?? null;
}

/**
 * Fetches the list of organizations the authenticated user belongs to.
 */
export async function fetchUserOrgs(token: string): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/user/orgs?per_page=30`;
  const response = await fetch(url, {headers: buildHeaders(token)});
  await throwOnHttpError(response, url);

  const data = (await response.json()) as Array<{login: string}>;
  return data.map((o) => o.login);
}

/**
 * Raw diagnostic fetch — returns a string summary of every API call outcome.
 * Used by the Diagnose command to help users debug token/plan configuration.
 */
export async function runDiagnostics(
    token: string,
    username: string,
    orgName: string,
    ): Promise<string> {
  const lines: string[] = [];

  // 1 — personal endpoint
  const personalUrl =
      `${GITHUB_API_BASE}/users/${username}/settings/billing/usage/summary`;
  try {
    const r = await fetch(personalUrl, {headers: buildHeaders(token)});
    const body = await r.text();
    lines.push(`Personal billing (${r.status}): ${body.slice(0, 300)}`);
  } catch (e) {
    lines.push(`Personal billing ERROR: ${e}`);
  }

  // 2 — user orgs
  try {
    const orgs = await fetchUserOrgs(token);
    lines.push(`User orgs: ${orgs.join(', ') || '(none)'}`);

    // 3 — org billing for each org (up to 3)
    for (const org of orgs.slice(0, 3)) {
      const orgUrl =
          `${GITHUB_API_BASE}/orgs/${org}/settings/billing/usage/summary`;
      try {
        const r2 = await fetch(orgUrl, {headers: buildHeaders(token)});
        const body2 = await r2.text();
        lines.push(
            `Org billing [${org}] (${r2.status}): ${body2.slice(0, 300)}`);
      } catch (e2) {
        lines.push(`Org billing [${org}] ERROR: ${e2}`);
      }
    }
  } catch (e) {
    lines.push(`fetchUserOrgs ERROR: ${e}`);
  }

  // 4 — specific orgName if provided
  if (orgName) {
    const seatUrl = `${GITHUB_API_BASE}/orgs/${orgName}/copilot/billing/seats`;
    try {
      const r3 = await fetch(seatUrl, {headers: buildHeaders(token)});
      const body3 = await r3.text();
      lines.push(
          `Copilot seats [${orgName}] (${r3.status}): ${body3.slice(0, 300)}`);
    } catch (e3) {
      lines.push(`Copilot seats ERROR: ${e3}`);
    }
  }

  return lines.join('\n\n');
}

/**
 * High-level usage resolver.
 *
 * Strategy:
 *  1. If planType is "individual"  → personal API only.
 *  2. If planType is "business"    → org API only (requires orgName;
 * auto-detects from user\'s org list if orgName is blank).
 *  3. If planType is "auto"        → try personal first; if result is 0 try
 * org.
 */
export async function resolveUsage(
    token: string,
    username: string,
    orgName: string,
    planType: 'individual'|'business'|'auto',
    ): Promise<UsageResult> {
  if (planType === 'individual') {
    const personal = await fetchPersonalUsage(token, username);
    return {usedRequests: personal.quantity, unit: personal.unit, source: 'personal'};
  }

  if (planType === 'business') {
    // Auto-detect org if not explicitly set
    const resolvedOrg = orgName || await autoDetectOrg(token);
    if (!resolvedOrg) {
      throw new Error(
          'Could not determine your GitHub organization. ' +
          'Please set copilot-tracer.orgName in your VS Code settings.');
    }
    const orgUsed = await fetchOrgBillingUsage(token, resolvedOrg);
    return {usedRequests: orgUsed.quantity, unit: orgUsed.unit, source: 'org', orgName: resolvedOrg};
  }

  // planType === "auto"
  const personal = await fetchPersonalUsage(token, username);
  if (personal.quantity > 0) {
    return {usedRequests: personal.quantity, unit: personal.unit, source: 'personal'};
  }

  // Personal returned 0 — try org (Business-plan scenario)
  const resolvedOrg = orgName || await autoDetectOrg(token);
  if (resolvedOrg) {
    try {
      const orgUsed = await fetchOrgBillingUsage(token, resolvedOrg);
      return {usedRequests: orgUsed.quantity, unit: orgUsed.unit, source: 'org', orgName: resolvedOrg};
    } catch {
      // Org API inaccessible (insufficient permissions) — return personal 0
    }
  }

  return {usedRequests: 0, unit: 'requests', source: 'personal'};
}

/**
 * Tries to find the first org the user belongs to that has Copilot billing
 * accessible via the token. Returns the org name or null.
 */
async function autoDetectOrg(token: string): Promise<string|null> {
  try {
    const orgs = await fetchUserOrgs(token);
    for (const org of orgs) {
      // A 200 response means the token can read this org\'s billing
      const url =
          `${GITHUB_API_BASE}/orgs/${org}/settings/billing/usage/summary`;
      const r = await fetch(url, {headers: buildHeaders(token)});
      if (r.ok) {
        return org;
      }
    }
  } catch {
    // Silently fail — caller handles null
  }
  return null;
}
