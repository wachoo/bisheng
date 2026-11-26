import request from "@/controllers/request";
import type { AssetKind, CompanyBoard } from "./companyBoards";

export type OperationalKind = Exclude<AssetKind, "skill">;
export type MonitorScope = { topic: string; scene: string; department: string; kind: string };
export type OperationalAsset = {
  id: string;
  kind: OperationalKind;
  name: string;
  department_id: number | null;
  scene_ids: string[];
  monitored: boolean;
  success: number;
  failed: number;
  last: string | null;
};
export type MonitorSnapshot = {
  filters: { topics: { id: string; name: string }[]; scenes: { id: string; name: string; topic_id: string }[] };
  assets: OperationalAsset[];
  days: { day: number; success: number; failed: number }[];
};
export type MonitorIssue = {
  run_id: string;
  asset_id: string;
  opened_at: string;
  resolved_at: string | null;
  comment: string | null;
  measure: string | null;
};
export type IssueSnapshot = { pending: number; closed: number; rows: MonitorIssue[]; details: boolean };
export type IssueStage = "pending" | "closed";
export type RunReceipt = {
  id: string;
  asset_id: string;
  status: string;
  ended_at: string;
  active_seconds: number | null;
  department_id: number | null;
  started_at: string | null;
  source: string | null;
  output: string | null;
  issue: { comment: string | null } | null;
  own: boolean;
};
const root = "/api/v1/company-boards/monitoring";

function periodParams(period: string) {
  const [year, month] = period.split("-").map(Number);
  return { year, month };
}
export function getMonitoring(board: CompanyBoard, period: string, scope: MonitorScope) {
  return request.get<unknown, MonitorSnapshot>(root, { params: { board, ...periodParams(period), ...scope } });
}
export function getMonitorIssues(
  period: string,
  scope: MonitorScope,
  stage: IssueStage,
  offset: number,
  limit: number,
  search = "",
  run_id = "",
) {
  return request.get<unknown, IssueSnapshot>(root + "/feedback", {
    params: {
      ...periodParams(period),
      ...scope,
      stage,
      offset,
      limit,
      search,
      run_id,
    },
  });
}
export function getMonitorRun(period: string, id: string) {
  return request.get<unknown, RunReceipt>(root + "/runs/" + encodeURIComponent(id), {
    params: periodParams(period),
  });
}
