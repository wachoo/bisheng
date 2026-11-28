import request from "@/controllers/request";

type Issue = { run_id: string; asset_id: string; opened_at: string; resolved_at: string | null; measure: string | null };
type FeedbackSnapshot = { pending: number; closed: number; total: number; rows: Issue[] };

export function getBoardFeedback(year: number, month: number, offset: number) {
  return request.get<unknown, FeedbackSnapshot>("/api/v1/company-boards/feedback", {
    params: { year, month, offset, limit: 10 },
  });
}

export function resolveBoardIssue(runId: string, measure: string) {
  return request.put("/api/v1/company-boards/feedback/" + encodeURIComponent(runId) + "/resolution", { measure });
}
