// ---------------------------------------------------------------------------
// Status-bar UI helpers
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import type {PacingResult} from './types.js';
import {classifyStatus} from './pacing.js';
import {buildDeltaExplanation, buildPacingNarrative} from './insights.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Formats a number with thousands separators. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Renders a smooth unicode gauge of `width` chars filled proportionally. */
function gauge(pct: number, width = 20, warn = false, danger = false): string {
  const p = Math.max(0, Math.min(1, pct));
  const filled = Math.round(p * width);
  const empty = width - filled;
  const block = danger ? '▓' : warn ? '▒' : '█';
  return block.repeat(filled) + '░'.repeat(empty);
}

/**
 * Compact 5-char mini gauge for the status bar text.
 * Uses fractional block characters for smooth sub-character precision.
 */
function miniGauge(pct: number): string {
  const width = 5;
  const p = Math.max(0, Math.min(1, pct));
  const blocks = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const totalUnits = width * 8;
  const filled = Math.round(p * totalUnits);
  const fullBlocks = Math.floor(filled / 8);
  const remainder = filled % 8;
  const emptyBlocks = width - fullBlocks - (remainder > 0 ? 1 : 0);
  return '▕' +
      '█'.repeat(fullBlocks) +
      (remainder > 0 ? blocks[remainder] : '') +
      '░'.repeat(Math.max(0, emptyBlocks)) +
      '▏';
}

/** Friendly time remaining string. */
function timeLeft(daysRemaining: number): string {
  if (daysRemaining <= 1) {
    return 'last day';
  }
  if (daysRemaining <= 7) {
    return `${daysRemaining} days left`;
  }
  const weeks = Math.floor(daysRemaining / 7);
  const days = daysRemaining % 7;
  return days > 0 ? `${weeks}w ${days}d left` : `${weeks}w left`;
}

/** Returns a contextual "smart tip" based on usage patterns. */
function smartTip(result: PacingResult): string {
  const {
    banked,
    baseDailyBudget,
    avgDailyUsage,
    remaining,
    daysRemaining,
    multiplier,
    projectedEnd,
    monthlyLimit,
    timeOfDayProgress,
  } = result;
  // Suppress unused-variable warnings — they're destructured for readability
  void avgDailyUsage;
  void remaining;

  if (result.unit === 'credits' && monthlyLimit === 300) {
    return '$(warning) Using AI Credits with default limit (300). Set `copilot-tracer.monthlyLimit` in settings (e.g., 1,500 for Pro, 7,000 for Pro+, 20,000 for Max).';
  }

  // End of day and haven't used much — encourage usage
  if (timeOfDayProgress > 0.75 && avgDailyUsage < baseDailyBudget * 0.5) {
    return '$(lightbulb) Under-utilizing today — perfect time for complex tasks!';
  }
  // Big surplus banked
  if (banked > baseDailyBudget * 3) {
    return '$(lightbulb) Large surplus! Consider tackling hard refactors or explorations.';
  }
  // Heavily overspent
  if (banked < -baseDailyBudget * 2) {
    return '$(lightbulb) Significantly overspent. Try batch-editing or manual coding to recover.';
  }
  // Projected to exceed
  if (projectedEnd > monthlyLimit * 1.1) {
    return '$(lightbulb) On pace to exceed your quota. Ease off on auto-completions.';
  }
  // Under-using consistently
  if (multiplier > 1.5 && remaining > monthlyLimit * 0.5) {
    return '$(lightbulb) You have tons of headroom — use Copilot more aggressively!';
  }
  // Last few days
  if (daysRemaining <= 3 && remaining > baseDailyBudget * 3) {
    return '$(lightbulb) Month almost over with surplus — go all out!';
  }
  return '';
}

// Thin Unicode separator
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
 * The tooltip is a polished mini-dashboard with:
 *  - Status headline with icon
 *  - Quick stats table
 *  - Visual gauges for quota, time, and today progress
 *  - Clear rate breakdown (Base Rate vs Allowance vs Actual)
 *  - Banked/overspent summary & projection
 *  - Session usage
 *  - Smart contextual tips
 */
export function showPacing(
    item: vscode.StatusBarItem,
    result: PacingResult,
    _source: 'personal'|'org'|'copilot-internal',
    _orgName?: string,
    ): void {
  const status = classifyStatus(result);
  const narrative = buildPacingNarrative(result);
  const deltaExplanation = buildDeltaExplanation(result);

  const {
    dailyAllowance,
    baseDailyBudget,
    avgDailyUsage,
    banked,
    remaining,
    monthlyLimit,
    dayOfMonth,
    daysInMonth,
    daysRemaining,
    projectedEnd,
    sessionUsed,
    usedRequests,
    timeOfDayProgress,
  } = result;

  const allowance = Math.round(dailyAllowance);
  const sessionText =
      (sessionUsed && sessionUsed > 0) ? ` +${sessionUsed}` : '';

  // Mini bar: 5 chars showing monthly quota consumption
  const usedPct = usedRequests / Math.max(monthlyLimit, 1);
  const miniBar = miniGauge(usedPct);

  // ---- Status-bar text ----
  if (result.unlimited) {
    item.text = `$(github-copilot)${SEP}Unlimited${sessionText}`;
    item.backgroundColor = undefined;
    item.color = undefined;
  } else {
    switch (status) {
      case 'exhausted':
        item.text = `$(github-copilot)${SEP}${miniBar} 0 left`;
        item.backgroundColor =
            new vscode.ThemeColor('statusBarItem.errorBackground');
        item.color = undefined;
        break;
      case 'over-budget':
        item.text = `$(github-copilot)${SEP}${miniBar} ${allowance}/d${sessionText} $(warning)`;
        item.backgroundColor =
            new vscode.ThemeColor('statusBarItem.warningBackground');
        item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        break;
      case 'ahead':
        item.text = `$(github-copilot)${SEP}${miniBar} ${allowance}/d${sessionText}`;
        item.backgroundColor = undefined;
        item.color = undefined;
        break;
      default:
        item.text = `$(github-copilot)${SEP}${miniBar} ${allowance}/d${sessionText}`;
        item.backgroundColor = undefined;
        item.color = undefined;
        break;
    }
  }

  // ---- Tooltip (MarkdownString) — Mini Dashboard ----
  const mntUsedPct = usedRequests / Math.max(monthlyLimit, 1);
  const mntTimePct = dayOfMonth / daysInMonth;
  const isPaceOver = mntUsedPct > mntTimePct;

  // Status headline
  const headline = (() => {
    if (result.unlimited) {
      return `$(check) **Unlimited Plan** — no monthly quota limits`;
    }
    switch (status) {
      case 'exhausted':
        return `$(error) **Quota Exhausted** — ${fmt(monthlyLimit)} / ${
            fmt(monthlyLimit)} used`;
      case 'over-budget':
        return `$(warning) **Over Budget** — slow down to recover`;
      case 'ahead':
        return `$(rocket) **Ahead of Schedule!** — extra headroom available`;
      default:
        return `$(check) **On Track** — pacing is healthy`;
    }
  })();

  const bankedAbs = Math.round(Math.abs(banked));

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.supportHtml = true;

  // ---- Header ----
  md.appendMarkdown(`### $(github-copilot) Copilot Tracer\n\n`);
  md.appendMarkdown(`${headline}\n\n`);
  md.appendMarkdown(`---\n\n`);

  const unitLabel = result.unit === 'credits' ? 'credits' : 'requests';

  // ---- Quick Stats ----
  md.appendMarkdown(`#### $(pulse) Quick Stats\n\n`);
  md.appendMarkdown(`| | |\n`);
  md.appendMarkdown(`|:---|:---|\n`);
  if (result.unlimited) {
    md.appendMarkdown(`| **Remaining** | **Unlimited** |\n`);
    md.appendMarkdown(`| **Today's Budget** | **Unlimited** |\n`);
  } else {
    md.appendMarkdown(`| **Remaining** | **${fmt(Math.round(remaining))}** of ${
        fmt(monthlyLimit)} ${unitLabel} |\n`);
    md.appendMarkdown(`| **Today's Budget** | **${allowance}** ${unitLabel}/day |\n`);
  }
  md.appendMarkdown(`| **Month Progress** | Day ${dayOfMonth} of ${
      daysInMonth} · ${timeLeft(daysRemaining)} |\n`);
  if (sessionUsed !== undefined) {
    const tokensStr = result.sessionTokens && result.sessionTokens > 0 ?
        ` (${fmt(result.sessionTokens)} tokens)` : '';
    if (result.unlimited) {
      md.appendMarkdown(`| **This Session** | ${
          sessionUsed === 0 ? `No requests yet` :
                              `**${fmt(sessionUsed)}** requests${tokensStr}`} |\n`);
    } else {
      md.appendMarkdown(`| **This Session** | ${
          sessionUsed === 0 ? `No ${unitLabel} yet` :
                              `**${fmt(sessionUsed)}** ${unitLabel}${tokensStr}`} |\n`);
    }
  }
  md.appendMarkdown(`\n`);

  if (!result.unlimited) {
    // ---- Visual Gauges ----
    md.appendMarkdown(`#### $(graph) Progress\n\n`);
    md.appendMarkdown('```\n');
    md.appendMarkdown(
        `  Quota  ${gauge(mntUsedPct, 22, isPaceOver, mntUsedPct > 0.9)}  ${
            Math.round(mntUsedPct * 100)}% used\n`);
    md.appendMarkdown(`  Time   ${gauge(mntTimePct, 22)}  ${
        Math.round(mntTimePct * 100)}% elapsed\n`);
    md.appendMarkdown(`  Day    ${gauge(timeOfDayProgress, 22)}  ${
        Math.round(timeOfDayProgress * 100)}% of today\n`);
    md.appendMarkdown('```\n\n');

    // Pace comparison one-liner
    const paceIcon = isPaceOver ? '$(warning)' : '$(check)';
    const paceLabel = isPaceOver ?
        `Using quota **faster** than time is passing` :
        `Using quota **slower** than time — you're banking ${unitLabel}`;
    md.appendMarkdown(`${paceIcon} ${paceLabel}\n\n`);

    md.appendMarkdown(`---\n\n`);

    // ---- Rate Breakdown ----
    md.appendMarkdown(`#### $(list-ordered) Rate Breakdown\n\n`);
    md.appendMarkdown(`| Metric | Rate | What It Means |\n`);
    md.appendMarkdown(`|:---|---:|:---|\n`);
    md.appendMarkdown(`| $(calendar) **Base Rate** | ${
        baseDailyBudget.toFixed(
            1)}/day | Quota ÷ days in month *(fixed ceiling)* |\n`);
    md.appendMarkdown(`| $(arrow-right) **Your Allowance** | ${
        dailyAllowance.toFixed(
            1)}/day | Remaining ÷ days left *(your actual budget)* |\n`);
    md.appendMarkdown(`| $(history) **Your Average** | ${
        avgDailyUsage.toFixed(
            1)}/day | How fast you've actually been using |\n\n`);

    // Delta explanation
    md.appendMarkdown(`> ${deltaExplanation}\n\n`);

    // Banked / Overspent
    if (bankedAbs > 0) {
      const bankIcon = banked >= 0 ? '$(verified)' : '$(warning)';
      const bankLabel = banked >= 0 ?
          `**+${fmt(bankedAbs)} banked** — saved vs expected schedule` :
          `**${fmt(bankedAbs)} overspent** — used more than expected`;
      md.appendMarkdown(`${bankIcon} ${bankLabel}\n\n`);
    }

    // Projection
    if (usedRequests > 0) {
      const projIcon = projectedEnd > monthlyLimit ? '$(warning)' : '$(check)';
      const projLabel = projectedEnd > monthlyLimit ?
          `Projected: **~${fmt(projectedEnd)}** — over the ${
              fmt(monthlyLimit)} limit!` :
          `Projected: **~${fmt(projectedEnd)}** / ${
              fmt(monthlyLimit)} by month end`;
      md.appendMarkdown(`${projIcon} ${projLabel}\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    // ---- Smart Tip ----
    const tip = smartTip(result);
    if (tip) {
      md.appendMarkdown(`${tip}\n\n`);
      md.appendMarkdown(`---\n\n`);
    }
  }

  // ---- Guidance ----
  if (!result.unlimited) {
    md.appendMarkdown(`$(info) _${narrative.guidance}_\n\n`);
  }

  // ---- Footer ----
  const sourceLabel = _source === 'org' && _orgName ? _orgName : _source;
  md.appendMarkdown(
      `_$(sync) [Refresh](command:copilot-tracer.refresh) · ${sourceLabel}_\n`);

  item.tooltip = md;
  item.command = 'copilot-tracer.refresh';
  item.show();
}
