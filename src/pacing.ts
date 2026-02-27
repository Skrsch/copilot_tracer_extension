// ---------------------------------------------------------------------------
// Daily pacing calculation
// ---------------------------------------------------------------------------

import type {PacingResult} from './types.js';

// ---------------------------------------------------------------------------
// Core pacing — all numbers are daily-focused
// ---------------------------------------------------------------------------

/**
 * Calculates daily-budget metrics: how many requests you can use per
 * remaining day, how that compares to the base rate, and whether you've
 * banked or overspent vs. the expected schedule.
 */
export function calculatePacing(
    usedRequests: number,
    monthlyLimit: number,
    now: Date = new Date(),
    remainingTotal?: number,
    sessionStartRequests?: number,
    ): PacingResult {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayOfMonth = now.getDate();  // 1-based

  const daysRemaining =
      Math.max(1, daysInMonth - dayOfMonth + 1);  // incl today
  const baseDailyBudget = monthlyLimit / daysInMonth;
  const remaining = remainingTotal !== undefined ? remainingTotal :
                                                   monthlyLimit - usedRequests;
  const dailyAllowance = Math.max(0, remaining) / daysRemaining;

  // Time of day progress (0.0 at midnight, 0.5 at noon, 0.99 at 11:59 PM)
  const timeOfDayProgress =
      (now.getHours() * 60 + now.getMinutes()) / (24 * 60);

  // Average daily usage so far (including partial current day)
  const effectiveDaysElapsed =
      Math.max(0.1, dayOfMonth - 1 + timeOfDayProgress);
  const avgDailyUsage = usedRequests / effectiveDaysElapsed;

  // Expected usage by NOW (smoothly increases throughout the day)
  const expectedByNow = effectiveDaysElapsed * baseDailyBudget;
  const banked = expectedByNow - usedRequests;  // + = saved, − = overspent

  const multiplier = baseDailyBudget > 0 ? dailyAllowance / baseDailyBudget : 1;
  const projectedEnd = dayOfMonth > 0 ?
      Math.round((usedRequests / effectiveDaysElapsed) * daysInMonth) :
      0;

  const sessionUsed = sessionStartRequests !== undefined ?
      Math.max(0, usedRequests - sessionStartRequests) :
      undefined;

  return {
    usedRequests,
    monthlyLimit,
    remaining,
    dayOfMonth,
    daysInMonth,
    daysRemaining,
    baseDailyBudget,
    dailyAllowance,
    avgDailyUsage,
    expectedByNow,
    banked,
    multiplier,
    projectedEnd,
    timeOfDayProgress,
    sessionUsed,
  };
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

export type UsageStatus = 'on-track'|'over-budget'|'ahead'|'exhausted';

/** Classify budget health based on daily pacing. */
export function classifyStatus(result: PacingResult): UsageStatus {
  const {remaining, banked, baseDailyBudget} = result;

  if (remaining <= 0) {
    return 'exhausted';
  }
  if (banked < 0) {
    return 'over-budget';
  }
  // Banked more than a full day's budget → clearly ahead
  if (banked > baseDailyBudget) {
    return 'ahead';
  }
  return 'on-track';
}
