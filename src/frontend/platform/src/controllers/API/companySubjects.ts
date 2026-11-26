import request from "@/controllers/request";
import type { CompanyBoard } from "./companyBoards";
export type SubjectRun = {
  id: string;
  start: string | null;
  end: string;
  status: string;
};
type Snapshot = {
  series: { date: string; success: number; failed: number; entered: number }[];
  known: boolean;
  last: string | null;
  total: number | null;
  rows: SubjectRun[];
  latest: SubjectRun | null;
};
export function getAssetActivity(
  board: CompanyBoard,
  asset: string,
  year: number,
  month: number,
  window: string,
  department: string,
  status: string,
  search: string,
  page: number,
) {
  return request.get<unknown, Snapshot>(
    "/api/v1/company-boards/asset-activity",
    {
      params: {
        board,
        asset,
        year,
        month,
        window,
        department,
        status,
        search,
        page,
      },
    },
  );
}
