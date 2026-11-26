import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { userContext } from "@/contexts/userContext";
import request from "@/controllers/request";

export const metricGroups = {
  projects: ["projects", "ai_projects", "active_ai_projects", "budget"],
  finance: ["spending", "outstanding"],
  value: ["valued_scenes", "labor_value", "direct_savings", "equivalent_days", "equivalent_value"],
} as const;

export type ReportMetric = (typeof metricGroups)[keyof typeof metricGroups][number];
export type ResearchMetrics = Record<ReportMetric, number | string | null>;
export interface ResearchSubject {
  id: string;
  name: string;
  project: string;
  ai: boolean;
  start: string;
  end: string | null;
}

export interface ResearchReportInput {
  year: number;
  month: number;
  revision: number;
  metrics: ResearchMetrics;
  subjects: ResearchSubject[];
}
export interface ResearchReport extends ResearchReportInput {
  source: "empty" | "legacy" | "direct";
  source_month: number | null;
  history: {
    month: number;
    equivalent_days: string | number | null;
    equivalent_value: string | number | null;
  }[];
}

const endpoint = "/api/v1/company-boards/research-report";

export function useResearchReport(board: "lead" | "manage", year: number, month: number, enabled = true) {
  const { user } = useContext(userContext);
  return useQuery({
    queryKey: ["company-boards", "research-report", user?.tenant_id, user?.user_id, board, year, month],
    queryFn: () => request.get<unknown, ResearchReport>(endpoint, { params: { board, year, month } }),
    enabled,
  });
}

export function saveResearchReport(report: ResearchReportInput) {
  return request.put<unknown, ResearchReport>(endpoint, report);
}
