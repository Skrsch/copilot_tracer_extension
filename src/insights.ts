// ---------------------------------------------------------------------------
// Shared insight builders
// ---------------------------------------------------------------------------

import {classifyStatus, type UsageStatus} from './pacing.js';
import type {PacingResult} from './types.js';

export interface PacingNarrative {
  status: UsageStatus;
  baselinePerDay: number;
  allowancePerDay: number;
  deltaPerDay: number;
  deltaPercent: number;
  guidance: string;
}

/**
 * Builds plain-language insight data from pacing metrics.
 */
export function buildPacingNarrative(result: PacingResult): PacingNarrative {
  const status = classifyStatus(result);
  const baselinePerDay = result.baseDailyBudget;
  const allowancePerDay = result.dailyAllowance;
  const deltaPerDay = allowancePerDay - baselinePerDay;
  const deltaPercent =
      baselinePerDay > 0 ? (deltaPerDay / baselinePerDay) * 100 : 0;

  const guidance = (() => {
    if (status === 'exhausted') {
      return 'Your monthly quota is fully used. Copilot completions may be limited until next month\'s reset.';
    }
    if (status === 'over-budget') {
      if (deltaPercent < -30) {
        return 'Usage is well above plan — consider pausing auto-completions and coding manually for a bit to recover allowance.';
      }
      return 'Slightly over budget. A small reduction in usage over the next few days will bring you back on track.';
    }
    if (status === 'ahead') {
      if (deltaPercent > 50) {
        return 'Large surplus built up! Great time for complex refactors, explorations, or using Copilot Chat freely.';
      }
      return 'Comfortably ahead of schedule. Feel free to lean on Copilot for your normal workflow.';
    }
    // on-track
    return 'Pacing looks healthy. Keep your current usage pattern — you\'re right on schedule.';
  })();

  return {
    status,
    baselinePerDay,
    allowancePerDay,
    deltaPerDay,
    deltaPercent,
    guidance,
  };
}

/**
 * Human-readable explanation of baseline vs allowance for quick UI contexts.
 * Uses plain language so users immediately understand the relationship.
 */
export function buildDeltaExplanation(result: PacingResult): string {
  const delta = result.dailyAllowance - result.baseDailyBudget;
  const abs = Math.abs(delta);
  const pct = result.baseDailyBudget > 0 ?
      Math.round((abs / result.baseDailyBudget) * 100) :
      0;
  const unitLabel = result.unit === 'credits' ? 'credits' : 'requests';

  if (abs < 0.6) {
    return '**Base Rate ≈ Allowance** — You\'re spending exactly on schedule. No adjustment needed.';
  }
  if (delta > 0) {
    return `**Allowance > Base Rate** (+${abs.toFixed(1)}/day, +${
        pct}%) — You saved ${unitLabel} earlier this month, so you can safely use **more** per day now.`;
  }
  return `**Allowance < Base Rate** (−${abs.toFixed(1)}/day, −${
      pct}%) — You used more than planned earlier, so your daily budget is tighter now to stay within quota.`;
}

/**
 * Builds a one-line summary that can be copied to clipboard.
 */
export function buildInsightSummary(
    result: PacingResult,
    source: 'personal'|'org'|'copilot-internal',
    orgName?: string,
    ): string {
  const n = buildPacingNarrative(result);
  const sourceLabel = source === 'org' && orgName ? `org:${orgName}` : source;

  return [
    `Copilot Tracer`,
    `allow ${Math.round(n.allowancePerDay)}/day`,
    `base ${Math.round(n.baselinePerDay)}/day`,
    `delta ${n.deltaPerDay >= 0 ? '+' : ''}${Math.round(n.deltaPerDay)}/day (${
        n.deltaPercent >= 0 ? '+' : ''}${Math.round(n.deltaPercent)}%)`,
    `burn ${Math.round(result.avgDailyUsage)}/day`,
    `remaining ${Math.round(result.remaining)}/${
        Math.round(result.monthlyLimit)}`,
    `forecast ${Math.round(result.projectedEnd)}/${
        Math.round(result.monthlyLimit)}`,
    `mode ${n.status}`,
    `source ${sourceLabel}`,
  ].join(' | ');
}
