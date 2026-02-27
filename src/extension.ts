// ---------------------------------------------------------------------------
// Copilot Tracer — VS Code Extension
//
// Tracks GitHub Copilot premium request usage and displays a daily pacing
// bar in the status bar. Supports Individual, Business, and Enterprise plans.
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';

import {fetchCopilotBusinessQuota, fetchCopilotInternalQuota, InsufficientScopeError, NotFoundError, RateLimitError, resolveUsage, runDiagnostics, TokenExpiredError,} from './api.js';
import {calculatePacing} from './pacing.js';
import {clearCachedUsername, clearToken, promptForToken, resolveSettings,} from './settings.js';
import {showError, showLoading, showNeedsAuth, showNoToken, showPacing, showWaiting,} from './statusBar.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setInterval>|undefined;
let outputChannel: vscode.OutputChannel;
let sessionStartRequests: number|null = null;
let lastNotifiedSessionUsed = 0;

/** Writes a timestamped line to the Copilot Tracer output channel. */
function log(message: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${message}`);
}

/**
 * Returns true for any error that indicates the stored token is
 * invalid / expired — whether caught via instanceof or by .name,
 * which is safer when running from a packaged VSIX.
 */
function isAuthError(err: unknown): boolean {
  if (err instanceof TokenExpiredError) {
    return true;
  }
  if (err instanceof Error && err.name === 'TokenExpiredError') {
    return true;
  }
  if (err instanceof Error &&
      /401|requires authentication/i.test(err.message)) {
    return true;
  }
  return false;
}

function isScopeError(err: unknown): boolean {
  if (err instanceof InsufficientScopeError) {
    return true;
  }
  if (err instanceof Error && err.name === 'InsufficientScopeError') {
    return true;
  }
  if (err instanceof Error &&
      /403|insufficient|missing.*scope|scope.*missing/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Tries to get the user's Copilot quota via VS Code's built-in GitHub
 * authentication session — no PAT required, no login prompt.
 *
 * The user must already be signed in to GitHub in VS Code (for Copilot,
 * Settings Sync, or any other extension). We only read the existing
 * session silently — we never trigger a login flow.
 */

/** Cached result so we don't call the API more than needed. */
let lastQuotaResult:
    {used: number; quota: number; remaining: number; fetchedAt: number;}|null =
        null;

/** Minimum milliseconds between actual API calls (5 minutes). */
const MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Silently looks for an existing GitHub session. Tries several scope
 * combinations because different extensions request different scopes and
 * VS Code only returns a session whose scopes are a superset of what you ask.
 */
async function getExistingGitHubSession():
    Promise<vscode.AuthenticationSession|null> {
  // Order: least-specific → most-specific so we match any existing session
  const scopeSets: string[][] = [
    [],              // Settings Sync sessions often have no scopes
    ['user:email'],  // common minimal scope
    ['read:user'],   // what we originally asked for
  ];

  for (const scopes of scopeSets) {
    const session = await vscode.authentication.getSession(
        'github', scopes, {silent: true});
    if (session) {
      return session;
    }
  }
  return null;
}

async function tryGetQuotaFromVSCodeAuth():
    Promise<{used: number; quota: number; remaining: number}|null> {
  // Return cached result if it's fresh enough
  if (lastQuotaResult &&
      Date.now() - lastQuotaResult.fetchedAt < MIN_FETCH_INTERVAL_MS) {
    log('Using cached quota (still fresh).');
    return lastQuotaResult;
  }

  const session = await getExistingGitHubSession();

  if (!session) {
    log('No existing GitHub session found (silent check). ' +
        'User needs to sign in via Accounts menu.');
    return null;
  }

  log(`GitHub session obtained (account: ${session.account.label})`);
  // Let RateLimitError propagate — don't swallow it
  const quota = await fetchCopilotInternalQuota(session.accessToken, log);
  if (quota) {
    lastQuotaResult = {
      ...quota,
      fetchedAt: Date.now(),
    };
    return {used: quota.used, quota: quota.quota, remaining: quota.remaining};
  }

  // Individual endpoint returned null — probe Business plan endpoints
  log('Primary endpoint has no quota — trying Business plan endpoint…');
  const bizQuota = await fetchCopilotBusinessQuota(session.accessToken, log);
  if (bizQuota) {
    lastQuotaResult = {
      ...bizQuota,
      fetchedAt: Date.now(),
    };
    return {
      used: bizQuota.used,
      quota: bizQuota.quota,
      remaining: bizQuota.remaining
    };
  }

  log('No quota data found from any endpoint.');
  return null;
}

// ---------------------------------------------------------------------------
// Core refresh cycle
// ---------------------------------------------------------------------------

/**
 * Orchestrates: resolve settings → fetch usage → calculate pacing → render.
 *
 * Self-healing behaviours:
 *  • Missing/expired token  → prompts user to set one.
 *  • Invalid username (404) → clears cached value, re-resolves, retries once.
 *  • Org API scope error    → surfaces a clear "token needs read:org" message.
 */
async function refresh(context: vscode.ExtensionContext): Promise<void> {
  showLoading(statusBarItem);
  log('Refreshing usage…');

  try {
    // -----------------------------------------------------------------------
    // PRIMARY PATH: VS Code built-in GitHub auth + Copilot internal API.
    // Works for Individual, Business, and Enterprise plans with zero config.
    // -----------------------------------------------------------------------
    let copilotQuota: {used: number; quota: number; remaining: number}|null =
        null;
    try {
      copilotQuota = await tryGetQuotaFromVSCodeAuth();
    } catch (err) {
      if (err instanceof RateLimitError ||
          (err instanceof Error && err.name === 'RateLimitError')) {
        const retryMin =
            Math.ceil(((err as RateLimitError).retryAfterSeconds ?? 60) / 60);
        log(`Rate limited by GitHub API. Retry in ~${retryMin} min.`);
        showWaiting(
            statusBarItem,
            `GitHub API rate limit exceeded.\n\n` +
                `Will retry automatically in ~${retryMin} min. No PAT needed.`,
        );
        // Back off: reschedule refresh after the rate-limit window
        if (refreshTimer !== undefined) {
          clearInterval(refreshTimer);
          refreshTimer = undefined;
        }
        setTimeout(() => void refresh(context), (retryMin + 1) * 60 * 1000);
        return;
      }
      // Any other error from auth — log and fall through to PAT path
      log(`tryGetQuotaFromVSCodeAuth error: ${
          err instanceof Error ? err.message : String(err)}`);
    }

    if (copilotQuota) {
      log(`Copilot internal API: used=${copilotQuota.used}, quota=${
          copilotQuota.quota}, remaining=${copilotQuota.remaining}`);

      // Use the API's actual quota as the monthly limit (overrides user
      // setting)
      const config = vscode.workspace.getConfiguration('copilot-tracer');
      const userLimit = config.get<number>('monthlyLimit') ?? 300;
      const monthlyLimit =
          copilotQuota.quota > 0 ? copilotQuota.quota : userLimit;

      if (sessionStartRequests === null) {
        sessionStartRequests = copilotQuota.used;
      } else {
        const sessionUsed = copilotQuota.used - sessionStartRequests;
        if (sessionUsed >= lastNotifiedSessionUsed + 10) {
          vscode.window.showInformationMessage(`Copilot Tracer: You've used ${
              sessionUsed} requests this session.`);
          lastNotifiedSessionUsed = sessionUsed;
        }
      }

      const pacing = calculatePacing(
          copilotQuota.used, monthlyLimit, new Date(), copilotQuota.remaining,
          sessionStartRequests);
      showPacing(statusBarItem, pacing, 'copilot-internal');
      log('Status bar updated via Copilot internal API.');
      return;
    }

    log('Copilot internal API unavailable — falling back to PAT path.');

    // -----------------------------------------------------------------------
    // FALLBACK PATH: PAT-based billing API (requires manual token setup).
    // -----------------------------------------------------------------------
    const settings = await resolveSettings(context.secrets);

    if (!settings) {
      log('No session and no PAT — showing connect prompt.');
      showNeedsAuth(statusBarItem);
      return;
    }

    log(`PAT settings: user=${settings.username}, plan=${
        settings.planType}, org="${settings.orgName}", limit=${
        settings.monthlyLimit}`);

    let usageResult;
    try {
      usageResult = await resolveUsage(
          settings.token, settings.username, settings.orgName,
          settings.planType);
    } catch (err) {
      const errName = err instanceof Error ? err.name : String(err);
      if (err instanceof NotFoundError || errName === 'NotFoundError') {
        await clearCachedUsername();
        const fresh = await resolveSettings(context.secrets);
        if (!fresh) {
          showNoToken(statusBarItem);
          return;
        }
        usageResult = await resolveUsage(
            fresh.token, fresh.username, fresh.orgName, fresh.planType);
      } else {
        throw err;
      }
    }

    log(`PAT usage: ${usageResult.usedRequests} requests, source=${
        usageResult.source}`);

    if (sessionStartRequests === null) {
      sessionStartRequests = usageResult.usedRequests;
    } else {
      const sessionUsed = usageResult.usedRequests - sessionStartRequests;
      if (sessionUsed >= lastNotifiedSessionUsed + 10) {
        vscode.window.showInformationMessage(`Copilot Tracer: You've used ${
            sessionUsed} requests this session.`);
        lastNotifiedSessionUsed = sessionUsed;
      }
    }

    const pacing = calculatePacing(
        usageResult.usedRequests, settings.monthlyLimit, new Date(), undefined,
        sessionStartRequests);
    showPacing(statusBarItem, pacing, usageResult.source, usageResult.orgName);
    log('Status bar updated via PAT path.');

  } catch (err) {
    const errName = err instanceof Error ? err.name : 'unknown';
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`ERROR [${errName}]: ${errMsg}`);

    if (isAuthError(err)) {
      await clearToken(context.secrets);
      await clearCachedUsername();
      log('Token cleared due to auth error. Prompting user.');
      showNoToken(
          statusBarItem,
          'Token rejected (401). Click to set a new GitHub PAT.');
      void vscode.window
          .showWarningMessage(
              'Copilot Tracer: GitHub token rejected (401). Please set a new token.',
              'Set Token',
              )
          .then((choice) => {
            if (choice === 'Set Token') {
              void vscode.commands.executeCommand('copilot-tracer.setToken');
            }
          });

    } else if (isScopeError(err)) {
      const scopeMsg = 'Token lacks permissions.\n\n' +
          '- **Individual plan**: PAT with `read:billing` scope\n' +
          '- **Business plan**: PAT with `read:org` or `manage_billing:copilot` scope\n\n' +
          'Use **Copilot Tracer: Set GitHub Token** to update.';
      showError(statusBarItem, scopeMsg, false);
      void vscode.window
          .showErrorMessage(
              'Copilot Tracer: token lacks required GitHub API scopes.',
              'Set Token',
              )
          .then((choice) => {
            if (choice === 'Set Token') {
              void vscode.commands.executeCommand('copilot-tracer.setToken');
            }
          });

    } else if (err instanceof Error && err.message.includes('orgName')) {
      showError(statusBarItem, err.message, false);

    } else {
      log(`Unhandled error — displaying in status bar.`);
      showError(statusBarItem, errMsg.slice(0, 300));
    }
  }
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

function startTimer(
    context: vscode.ExtensionContext,
    intervalMinutes: number,
    ): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
  }
  const ms = Math.max(1, intervalMinutes) * 60 * 1000;
  refreshTimer = setInterval(() => void refresh(context), ms);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Copilot Tracer');
  context.subscriptions.push(outputChannel);
  log('Extension activating…');

  // Create the status-bar item — placed just to the right of middle
  statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      // Priority: sit close to the GitHub Copilot icon (which is around 100)
      99,
  );
  context.subscriptions.push(statusBarItem);

  // ---- Commands ----

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.setToken',
          async () => {
            const token = await promptForToken(context.secrets);
            if (token !== undefined) {
              await refresh(context);
            }
          }),
  );

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.refresh',
          () => {
            lastQuotaResult = null;  // force fresh fetch
            void refresh(context);
          }),
  );

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.connectGitHub',
          async () => {
            log('User initiated GitHub connect…');
            showLoading(statusBarItem);
            try {
              const session = await vscode.authentication.getSession(
                  'github', ['read:user'], {createIfNone: true});
              if (session) {
                log(`GitHub connected: ${session.account.label}`);
                lastQuotaResult = null;
                await refresh(context);
              } else {
                log('User cancelled GitHub connect.');
                showNeedsAuth(statusBarItem);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`GitHub connect failed: ${msg}`);
              if (/rate.limit/i.test(msg)) {
                showWaiting(
                    statusBarItem,
                    'GitHub API rate limit hit during sign-in.\n\n' +
                        'Please wait a few minutes, then click to retry.',
                );
              } else {
                showError(statusBarItem, `GitHub connect failed:\n\n${msg}`);
              }
            }
          }),
  );

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.clearToken',
          async () => {
            await clearToken(context.secrets);
            await clearCachedUsername();
            showNoToken(statusBarItem, 'Token cleared.');
            vscode.window.showInformationMessage(
                'Copilot Tracer: GitHub token cleared. Use \'Set GitHub Token\' to add a new one.',
            );
          }),
  );

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.showDetails',
          () => {
            void refresh(context);
            vscode.window.showInformationMessage(
                'Copilot Tracer: Hover over the status bar item for usage details.',
            );
          }),
  );

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'copilot-tracer.diagnose',
          async () => {
            outputChannel.clear();
            outputChannel.show(true);
            outputChannel.appendLine('=== Copilot Tracer Diagnostics ===');

            // Test VS Code auth path
            outputChannel.appendLine('\n--- VS Code GitHub Auth (primary) ---');
            try {
              const session = await getExistingGitHubSession();
              if (session) {
                outputChannel.appendLine(
                    `Session found: ${session.account.label}`);
                const diagLog = (msg: string) =>
                    outputChannel.appendLine(`  ${msg}`);
                const quota = await fetchCopilotInternalQuota(
                    session.accessToken, diagLog);
                if (quota) {
                  outputChannel.appendLine(`Individual quota: used=${
                      quota.used}, remaining=${quota.remaining}, total=${
                      quota.quota}, resets=${quota.resetAt}`);
                } else {
                  outputChannel.appendLine(
                      'Individual endpoint returned null — trying Business endpoint…');
                  const bizQuota = await fetchCopilotBusinessQuota(
                      session.accessToken, diagLog);
                  if (bizQuota) {
                    outputChannel.appendLine(
                        `Business quota: used=${bizQuota.used}, remaining=${
                            bizQuota.remaining}, total=${
                            bizQuota.quota}, resets=${bizQuota.resetAt}`);
                  } else {
                    outputChannel.appendLine(
                        'No quota data from either endpoint.');
                  }
                }
              } else {
                outputChannel.appendLine(
                    'No GitHub session found. Make sure you are signed in to GitHub in VS Code (Accounts menu, bottom-left).');
              }
            } catch (e) {
              outputChannel.appendLine(`VS Code auth error: ${e}`);
            }

            // Test PAT path if configured
            outputChannel.appendLine('\n--- PAT Fallback ---');
            const settings = await resolveSettings(context.secrets);
            if (settings) {
              outputChannel.appendLine(`username: ${settings.username}  plan: ${
                  settings.planType}  org: "${settings.orgName}"`);
              try {
                const result = await runDiagnostics(
                    settings.token, settings.username, settings.orgName);
                outputChannel.appendLine(result);
              } catch (e) {
                outputChannel.appendLine(`PAT diagnostics error: ${e}`);
              }
            } else {
              outputChannel.appendLine(
                  'No PAT stored (that is fine if VS Code auth works).');
            }
          }),
  );

  // ---- Settings change listener (restart timer on interval change) ----
  context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('copilot-tracer')) {
          const config = vscode.workspace.getConfiguration('copilot-tracer');
          const interval =
              Math.max(5, config.get<number>('refreshIntervalMinutes') ?? 30);
          startTimer(context, interval);
          log(`Settings changed — timer reset to ${interval} min.`);
          // Invalidate cache so next refresh gets fresh data
          lastQuotaResult = null;
          void refresh(context);
        }
      }),
  );

  // ---- Initial run ----
  // Delay initial API call by 10 s to avoid hitting rate limits during
  // VS Code startup (other extensions also call GitHub APIs immediately).
  log('Extension activated — first refresh in 10 s…');
  setTimeout(() => {
    void refresh(context).then(() => {
      const config = vscode.workspace.getConfiguration('copilot-tracer');
      const interval = config.get<number>('refreshIntervalMinutes') ?? 30;
      startTimer(context, Math.max(5, interval));
      log(`Auto-refresh timer set to ${Math.max(5, interval)} min.`);
    });
  }, 10_000);
}

export function deactivate(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
  }
}
