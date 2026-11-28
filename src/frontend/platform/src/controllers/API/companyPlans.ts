import request from "@/controllers/request";

export type PlanKind = "topic" | "scene" | "collection";
export interface PlanItem {
  kind: PlanKind;
  id: string;
  name: string;
  version: string;
  is_featured?: boolean;
  topic_id?: string;
  department_id?: number | null;
  planned_date?: string | null;
  completed_date?: string | null;
  target?: number;
  support_department_ids?: number[];
  supports?: { department: number }[];
  asset_keys?: string[];
}
export interface Targets {
  employee: number | null;
  scene: number | null;
  version: string | null;
}
export interface PlanData {
  targets: Targets;
  items: PlanItem[];
  built: number;
  assets: { id: string; kind: string; name: string }[];
  departments: { id: number; name: string }[];
  knowledge_progress: { id: string; completed: number }[];
  default_topic: string;
}
interface ItemInput {
  id: string | null;
  version: string | null;
  name: string;
}
interface PlannedInput extends ItemInput {
  topic_id: string;
  department_id: number | null;
  planned_date: string | null;
  completed_date: string | null;
}
export type PlanEdit =
  | (Targets & { kind: "targets" })
  | (ItemInput & { kind: "topic"; is_featured?: boolean; delete?: boolean })
  | (PlannedInput & { kind: "scene"; support_department_ids: number[]; asset_keys: string[] })
  | (ItemInput & { kind: "collection"; target: number; planned_date: string });

export function readCompanyPlan(year: number) {
  return request.get<unknown, PlanData>("/api/v1/company-boards/planning/" + year);
}
export function saveCompanyPlan(year: number, edit: PlanEdit) {
  return request.put("/api/v1/company-boards/planning/" + year, edit);
}
