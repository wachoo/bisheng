import { expect, it, vi } from "vitest";
import type { TrendPeriod, TrendRow } from "@/controllers/API/activityTrends";
import { aggregation } from "./ActivityData";

vi.mock("@/contexts/userContext", () => ({ userContext: {} }));
vi.mock("@/controllers/API/companyMonitoring", () => ({}));
vi.mock("@/controllers/API/activityTrends", () => ({}));

it("keeps historical Skill uses in observed totals without marking other departments as measured", () => {
  const employee: TrendRow = {
    kind: "employee", asset_id: "assistant:1", department_id: 10, successful: 3, failed: 0,
    cancelled: 0, entered: 0, timed: 0, active_seconds: 0, linked: 0, negative: 0,
    tokens: null, rounds: 0, output_category: null, output_day: null,
  };
  const skill: TrendRow = { ...employee, kind: "skill", asset_id: "skill:42", department_id: 20, successful: 0, entered: 2 };
  const period: TrendPeriod = { month: 1, rows: [employee, skill], files_known: true };
  expect(aggregation(period).uses()).toBe(5);
  expect(aggregation(period).uses("skill")).toBe(2);
  expect(aggregation(period, undefined, "10").uses()).toBe(3);
  expect(aggregation(period, undefined, "10").uses("skill")).toBeNull();
  expect(aggregation(period, "skill:43").uses("skill")).toBeNull();
});
