import { API_BASE_URL } from "./api";

export interface OwnerOverview {
  last30AppOpens: number;
  last30Matches: number;
  last12MonthsDarts: number;
  currentMonthActiveInstalls: number;
  latestEstimatedAccuracy: number;
  latestAvgCorrectionsPerMatch: number;
}

export interface OwnerDayValue {
  day: string;
  app_opens?: number;
  matches_played?: number;
}

export interface OwnerMonthValue {
  month: string;
  active_installs?: number;
  total_darts?: number;
  avg_estimated_accuracy?: number;
  avg_corrections_per_match?: number;
  matches_played?: number;
}

export interface OwnerAnalyticsDashboardPayload {
  overview: OwnerOverview;
  dailyAppOpens: OwnerDayValue[];
  monthlyActiveInstalls: OwnerMonthValue[];
  matchesPerDay: OwnerDayValue[];
  dartsPerMonth: OwnerMonthValue[];
  x01QualityPerMonth: OwnerMonthValue[];
}

export async function getOwnerAnalyticsDashboard(): Promise<OwnerAnalyticsDashboardPayload> {
  const res = await fetch(`${API_BASE_URL}/api/owner-analytics/dashboard`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(String(payload?.detail ?? "Failed to fetch owner analytics dashboard"));
  }
  return res.json() as Promise<OwnerAnalyticsDashboardPayload>;
}
