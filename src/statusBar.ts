// ---------------------------------------------------------------------------
// Status-bar UI helpers
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import type {PacingResult} from './types.js';
import {classifyStatus} from './pacing.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Formats a number with thousands separators. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Renders a horizontal bar of `width` chars filled proportionally. */
function renderBar(value: number, maxVal: number, width: number): string {
  const ratio = Math.max(0, Math.min(1, value / Math.max(maxVal, 1)));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Thin Unicode separator that renders nicely next to the Copilot icon
const SEP = ' ';

// ---------------------------------------------------------------------------
// Status-bar state rendering
// ---------------------------------------------------------------------------

/** Updates the status-bar item for the "loading" state. */
export function showLoading(item: vscode.StatusBarItem): void {
  item.text = `$(sync~spin)${SEP}Tracer`;
  item.tooltip = 'Copilot Tracer: fetching usage…';
  item.color = undefined;
  item.backgroundColor = undefined;
  item.show();
}

/** Updates the status-bar item to prompt the user for a token. */
export function showNoToken(item: vscode.StatusBarItem, reason?: string): void {
  item.text = `$(key)${SEP}Tracer`;
  item.tooltip = new vscode.MarkdownString(
      `**Copilot Tracer** — no token stored\n\n` +
          `${reason ? `_${reason}_\n\n` : ''}` +
          `Click to set your GitHub PAT.`,
      true,
  );
  item.color = undefined;
  item.backgroundColor = undefined;
  item.command = 'copilot-tracer.setToken';
  item.show();
}

/**
 * Shows a status-bar message indicating the extension is waiting — e.g. for
 * GitHub auth or a rate-limit cooldown.  Clicking refreshes (does NOT prompt
 * for a PAT).
 */
export function showWaiting(
    item: vscode.StatusBarItem,
    message: string,
    ): void {
  item.text = `$(clock)${SEP}Tracer`;
  item.tooltip = new vscode.MarkdownString(
      `**Copilot Tracer**\n\n${message}\n\n_Click to retry._`,
      true,
  );
  item.color = undefined;
  item.backgroundColor = undefined;
  item.command = 'copilot-tracer.refresh';
  item.show();
}

/**
 * Shows a status-bar message asking the user to connect their GitHub account.
 * Clicking runs the connectGitHub command which does createIfNone: true.
 */
export function showNeedsAuth(item: vscode.StatusBarItem): void {
  item.text = `$(github)${SEP}Tracer`;
  item.tooltip = new vscode.MarkdownString(
      `**Copilot Tracer** — not connected\n\n` +
          `Click to connect your GitHub account.\n` +
          `_(One-time approval — no PAT needed.)_`,
      true,
  );
  item.color = undefined;
  item.backgroundColor = undefined;
  item.command = 'copilot-tracer.connectGitHub';
  item.show();
}

/** Updates the status-bar item for an error state. */
export function showError(
    item: vscode.StatusBarItem,
    message: string,
    recoverable = true,
    ): void {
  item.text = `$(error)${SEP}Tracer`;
  item.tooltip = new vscode.MarkdownString(
      `**Copilot Tracer — Error**\n\n${message}\n\n` +
          (recoverable ? '_Click to retry._' : ''),
      true,
  );
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  item.color = undefined;
  item.command = recoverable ? 'copilot-tracer.refresh' : undefined;
  item.show();
}

/**
 * Updates the status-bar item with daily-focused pacing data.
 *
 * Status bar:  $(pulse) 20/day ×1.9     (daily allowance + multiplier)
 * Tooltip:     Daily budget report with 3-bar rate comparison
 */
export function showPacing(
    item: vscode.StatusBarItem,
    result: PacingResult,
    _source: 'personal'|'org'|'copilot-internal',
    _orgName?: string,
    ): void {
  const status = classifyStatus(result);
  const {
    dailyAllowance,
    baseDailyBudget,
    avgDailyUsage,
    multiplier,
    banked,
    remaining,
    monthlyLimit,
    dayOfMonth,
    daysInMonth,
    daysRemaining,
    projectedEnd,
    sessionUsed,
    timeOfDayProgress,
  } = result;

  const allowance = Math.round(dailyAllowance);
  const mult = multiplier.toFixed(1);

  // ---- Status-bar text ----
  // Hero number: your daily allowance.  Show ×multiplier when notably != 1.
  const showMult = multiplier >= 1.15 || multiplier <= 0.85;
  const multText = showMult ? ` (${mult}x)` : '';
  const sessionText =
      (sessionUsed && sessionUsed > 0) ? ` (+${sessionUsed})` : '';

  switch (status) {
    case 'exhausted':
      item.text = `$(github-copilot)${SEP}0/day${sessionText}`;
      break;
    case 'over-budget':
      item.text = `$(github-copilot)${SEP}${allowance}/day${multText}${
          sessionText} $(flame)`;
      break;
    case 'ahead':
      item.text = `$(github-copilot)${SEP}${allowance}/day${multText}${
          sessionText} $(rocket)`;
      break;
    default:
      item.text = `$(github-copilot)${SEP}${allowance}/day${sessionText}`;
      break;
  }

  // ---- Colour coding ----
  switch (status) {
    case 'exhausted':
      item.backgroundColor =
          new vscode.ThemeColor('statusBarItem.errorBackground');
      item.color = undefined;
      break;
    case 'over-budget':
      item.backgroundColor =
          new vscode.ThemeColor('statusBarItem.warningBackground');
      item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      break;
    default:
      item.backgroundColor = undefined;
      item.color = undefined;
      break;
  }

  // ---- Tooltip (Markdown) — Daily Budget Report ----
  const barWidth = 20;
  const maxRate = Math.max(dailyAllowance, baseDailyBudget, avgDailyUsage, 1);

  const budgetBar = renderBar(baseDailyBudget, maxRate, barWidth);
  const avgBar = renderBar(avgDailyUsage, maxRate, barWidth);
  const allowanceBar = renderBar(dailyAllowance, maxRate, barWidth);

  // Headline
  const headline = (() => {
    switch (status) {
      case 'exhausted':
        return `🚫 **Limit reached** — all ${fmt(monthlyLimit)} used`;
      case 'over-budget':
        return `🔥 **Over budget** — daily allowance reduced`;
      case 'ahead':
        return `🚀 **Ahead of schedule!**`;
      default:
        return `✅ **On track**`;
    }
  })();

  // Budget savings/overspend one-liner
  const bankedAbs = Math.round(Math.abs(banked));
  const bankedLine = banked >= 0 ?
      `🏦 **+${fmt(bankedAbs)} saved** vs expected` :
      `🔥 **${fmt(bankedAbs)} over** expected budget`;

  // End-of-month projection
  const projLine = projectedEnd > monthlyLimit ?
      `⚠️ Pace: ~${fmt(projectedEnd)} — over limit!` :
      `📈 Pace: ~${fmt(projectedEnd)} / ${fmt(monthlyLimit)} by month end ✓`;

  // Multiplier context (only when interesting)
  const multLine = showMult ?
      `*(${mult}x your base rate — ${
          multiplier >= 1 ? 'efficiency bonus!' : 'budget pressure'})*` :
      '';

  const sessionLine = sessionUsed !== undefined ?
      `⚡ **Session Usage:** ${
          sessionUsed} requests used since opening VS Code` :
      '';

  const timeOfDayPct = Math.round(timeOfDayProgress * 100);
  const timeOfDayLine = `🕒 **Time of Day:** ${timeOfDayPct}% through the day`;

  const md = new vscode.MarkdownString(
      [
        `### $(github-copilot) Copilot Daily Budget`,
        ``,
        headline,
        ``,
        `You have **${allowance}** requests available per remaining day.`,
        ...(showMult ? [multLine] : []),
        ``,
        `📊 **Daily Rates**`,
        ``,
        '```text',
        `base rate  ${budgetBar}  ${baseDailyBudget.toFixed(1)}/day`,
        `past avg   ${avgBar}  ${avgDailyUsage.toFixed(1)}/day`,
        `allowance  ${allowanceBar}  ${dailyAllowance.toFixed(1)}/day ◀`,
        '```',
        ``,
        bankedLine,
        ``,
        `📅 Day ${dayOfMonth}/${daysInMonth} · ${daysRemaining} days left · ${
            fmt(Math.round(remaining))} remaining`,
        timeOfDayLine,
        ...(sessionUsed !== undefined ? [sessionLine] : []),
        ``,
        projLine,
        ``,
        `_Click to refresh_`,
      ].join('\n'),
      true,
  );
  md.isTrusted = true;
  item.tooltip = md;

  item.command = 'copilot-tracer.refresh';
  item.show();
}
