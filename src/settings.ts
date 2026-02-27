// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';

import {fetchUsername} from './api.js';

import type {ValidatedSettings} from './types.js';

const SECRET_KEY = 'copilot-tracer.githubToken';
const DEFAULT_MONTHLY_LIMIT = 300;
const CFG = 'copilot-tracer';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the raw GitHub PAT from SecretStorage. Returns undefined if not set.
 */
export async function getToken(secrets: vscode.SecretStorage):
    Promise<string|undefined> {
  return secrets.get(SECRET_KEY);
}

/** Stores a GitHub PAT in SecretStorage. */
export async function storeToken(
    secrets: vscode.SecretStorage,
    token: string,
    ): Promise<void> {
  await secrets.store(SECRET_KEY, token);
}

/** Removes the stored token — called when a 401 is received. */
export async function clearToken(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
}

/**
 * Reads, validates and (where possible) auto-corrects every setting the
 * extension needs.
 *
 * Returns `null` when no token is stored (caller should prompt the user to
 * supply one).
 *
 * Throws `TokenExpiredError` if the token is proven invalid while resolving
 * the username.
 */
export async function resolveSettings(
    secrets: vscode.SecretStorage,
    ): Promise<ValidatedSettings|null> {
  const token = await secrets.get(SECRET_KEY);
  if (!token) {
    return null;
  }

  const config = vscode.workspace.getConfiguration(CFG);

  // --- monthlyLimit ---
  let monthlyLimit =
      config.get<number>('monthlyLimit') ?? DEFAULT_MONTHLY_LIMIT;
  if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
    monthlyLimit = DEFAULT_MONTHLY_LIMIT;
    await config.update(
        'monthlyLimit',
        DEFAULT_MONTHLY_LIMIT,
        vscode.ConfigurationTarget.Global,
    );
  }

  // --- planType ---
  const planType =
      (config.get<string>('planType') as ValidatedSettings['planType']) ??
      'auto';

  // --- orgName ---
  const orgName = (config.get<string>('orgName') ?? '').trim();

  // --- refreshInterval ---
  let refreshIntervalMinutes =
      config.get<number>('refreshIntervalMinutes') ?? 10;
  if (!Number.isFinite(refreshIntervalMinutes) || refreshIntervalMinutes < 1) {
    refreshIntervalMinutes = 10;
  }

  // --- username (auto-detected from API) ---
  let username = (config.get<string>('username') ?? '').trim();
  if (!username) {
    username = await fetchUsername(token);  // may throw TokenExpiredError
    await config.update(
        'username', username, vscode.ConfigurationTarget.Global);
  }

  return {
    token,
    username,
    monthlyLimit,
    orgName,
    planType,
    refreshIntervalMinutes
  };
}

/** Clears the cached username so it is re-resolved on the next refresh. */
export async function clearCachedUsername(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CFG);
  await config.update('username', '', vscode.ConfigurationTarget.Global);
}

/**
 * Prompts the user for a GitHub PAT via a secure input box and stores it.
 * Returns the token if entered, or undefined if cancelled.
 */
export async function promptForToken(
    secrets: vscode.SecretStorage,
    ): Promise<string|undefined> {
  const plan =
      vscode.workspace.getConfiguration(CFG).get<string>('planType') ?? 'auto';
  const scopeHint = plan === 'business' ?
      'read:org or manage_billing:copilot scope' :
      'read:billing scope (or leave all scopes empty)';

  const token = await vscode.window.showInputBox({
    prompt: `Enter your GitHub Personal Access Token (requires ${scopeHint})`,
    placeHolder: 'github_pat_…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
        v.trim().length === 0 ? 'Token cannot be empty' : undefined,
  });

  if (token !== undefined) {
    await storeToken(secrets, token.trim());
  }

  return token;
}
