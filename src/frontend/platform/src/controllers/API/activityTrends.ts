import request from "@/controllers/request";
import type { AssetKind, CompanyBoard } from "./companyBoards";

export type TrendRow = {
  kind: AssetKind | "file" | "version" | "model";
  asset_id: string | null;
  department_id: number | null;
  successful: number;
  failed: number;
  cancelled: number;
  entered: number;
  timed: number;
  active_seconds: number;
  linked: number;
  negative: number;
  tokens: number | null;
  rounds: number;
  output_category: "document" | "image" | "page" | "other" | null;
  output_day: string | null;
};
export type TrendPeriod = { month: number; rows: TrendRow[]; files_known: boolean };
export type TrendSeries = { months: TrendPeriod[]; year: TrendPeriod; last90: TrendPeriod };
export function getActivityTrends(board: CompanyBoard, year: number, month: number) {
  return request.get<unknown, TrendSeries>("/api/v1/company-boards/trends", { params: { board, year, month } });
}
