// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type PlanType = 'individual'|'business';

export interface UsageItem {
  sku: string;
  grossQuantity: number;
  netQuantity?: number;
  unitType?: string;
  pricePerUnit?: number;
}

export interface UsageResult {
  usedRequests: number;
  /** Indicates whether the data is from personal or org-level billing */
  source: 'personal'|'org'|'copilot-internal';
  orgName?: string;
  /**
   * Exact monthly quota returned by the Copilot API (overrides user setting)
   */
  quotaFromApi?: number;
  /** Exact remaining requests returned by the Copilot API */
  remainingFromApi?: number;
}

/** Quota data returned by the Copilot internal token API. */
export interface CopilotQuota {
  used: number;
  remaining: number;
  /** The actual monthly quota ceiling (e.g. 300) */
  quota: number;
  /** ISO timestamp when the quota resets (start of next month) */
  resetAt: string;
}

export interface PacingResult {
  /** Total requests used so far this month */
  usedRequests: number;
  monthlyLimit: number;
  /** Remaining requests (from API or computed) */
  remaining: number;
  dayOfMonth: number;
  daysInMonth: number;
  /** Days remaining including today (≥ 1) */
  daysRemaining: number;
  /** Original budget per day: monthlyLimit / daysInMonth */
  baseDailyBudget: number;
  /** Current daily allowance: remaining / daysRemaining — the hero number */
  dailyAllowance: number;
  /** Average daily usage so far: usedRequests / dayOfMonth */
  avgDailyUsage: number;
  /** Expected usage by end of today: dayOfMonth × baseDailyBudget */
  expectedByNow: number;
  /** Requests banked (+) or overspent (−) vs expected schedule */
  banked: number;
  /** dailyAllowance / baseDailyBudget — how much more/less than normal */
  multiplier: number;
  /** Projected total usage by month end at current rate */
  projectedEnd: number;
  /** How much of the current day has passed (0.0 to 1.0) */
  timeOfDayProgress: number;
  /** Requests used in the current VS Code session */
  sessionUsed?: number;
}

export interface ValidatedSettings {
  token: string;
  username: string;
  monthlyLimit: number;
  orgName: string;
  planType: PlanType|'auto';
  refreshIntervalMinutes: number;
}
