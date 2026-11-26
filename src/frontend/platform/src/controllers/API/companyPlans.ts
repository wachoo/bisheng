import request from "@/controllers/request";

export type PlanKind = "topic" | "scene" | "collection";
export interface PlanPeriod {
  id?: string;
  start: string;
  end: string | null;
}
export interface SupportPeriod extends PlanPeriod {
  department: number;
}
export interface PlanItem {
  kind: PlanKind;
  id: string;
  name: string;
  version: string;
  topic_id?: string;
  department_id?: number | null;
  planned_date?: string | null;
  completed_date?: string | null;
  category?: string | null;
  asset_key?: string | null;
  supports?: SupportPeriod[];
  recognition?: PlanPeriod[];
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
  departments: { id: number; name: string }[];
  knowledge: { id: string; name: string }[];
}
interface ItemInput {
  id: string | null;
  version: string | null;
  name: string;
}
interface PlannedInput extends ItemInput {
  topic_id: string;
  department_id: number;
  planned_date: string | null;
  completed_date: string | null;
}
export type PlanEdit =
  | (Targets & { kind: "targets" })
  | (ItemInput & { kind: "topic" })
  | (PlannedInput & { kind: "scene"; supports: SupportPeriod[]; recognition: PlanPeriod[] })
  | (PlannedInput & { kind: "collection"; category: string; asset_key: string | null });

export function readCompanyPlan(year: number) {
  return request.get<unknown, PlanData>("/api/v1/company-boards/planning/" + year);
}
export function saveCompanyPlan(year: number, edit: PlanEdit) {
  return request.put("/api/v1/company-boards/planning/" + year, edit);
}
