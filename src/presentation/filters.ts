import {
  type DependencyAnalysis,
  currentAdvisories,
} from "../domain/dependency/analysis";
import type { UpdateSeverity } from "../domain/version/classification";

export interface DashboardFilters {
  readonly severities: readonly UpdateSeverity[];
  readonly vulnerableOnly: boolean;
  readonly blockedOnly: boolean;
  readonly updatesOnly: boolean;
}

export const NO_FILTERS: DashboardFilters = {
  blockedOnly: false,
  severities: [],
  updatesOnly: false,
  vulnerableOnly: false,
};

export const hasActiveFilters = (filters: DashboardFilters): boolean =>
  filters.blockedOnly ||
  filters.vulnerableOnly ||
  filters.updatesOnly ||
  filters.severities.length > 0;

/** Whether a dependency passes every active filter (all filters must match). */
export function matchesFilters(
  item: DependencyAnalysis,
  filters: DashboardFilters
): boolean {
  if (filters.vulnerableOnly && currentAdvisories(item).length === 0) {
    return false;
  }
  if (filters.blockedOnly && item.status !== "blocked") {
    return false;
  }
  if (
    filters.updatesOnly &&
    item.status !== "update" &&
    item.status !== "blocked"
  ) {
    return false;
  }
  if (filters.severities.length > 0) {
    const severity = item.selection?.target?.severity;
    return severity !== undefined && filters.severities.includes(severity);
  }
  return true;
}
