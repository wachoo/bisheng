import request from "@/controllers/request";
import type { CompanyBoard } from "./companyBoards";

export type SupplementKind =
  | "project"
  | "subject"
  | "expense"
  | "receivable"
  | "receipt"
  | "estimate"
  | "recognition"
  | "case"
  | "collection-meta"
  | "asset-profile"
  | "scene-asset"
  | "scene-team"
  | "value-rate";

export interface SupplementalRow {
  id: string;
  revision: number;
  year: number;
  kind: SupplementKind;
  name: string;
  parent_id: string | null;
  date: string;
  fields: Record<string, string>;
}

const endpoint = "/api/v1/company-boards/registers";

export function getBoardRegisters(board: CompanyBoard | "manage", year: number, month: number) {
  return request.get<unknown, SupplementalRow[]>(endpoint, { params: { board, year, month } });
}

export function saveBoardRegister(data: SupplementalRow) {
  return request.put<unknown, SupplementalRow>(endpoint, data);
}
