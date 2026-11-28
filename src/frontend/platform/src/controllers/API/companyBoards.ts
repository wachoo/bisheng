import request from "@/controllers/request";

export type CompanyBoard = "lead" | "monitor";
export type AssetKind = "employee" | "knowledge" | "skill" | "tool";
export type LedgerKind = "goal" | "topic" | "scene" | "release" | "collection";
export type GoalIndicator = "employee" | "scene" | "knowledge";
export type BoardAccess = { lead: boolean; monitor: boolean; manage: boolean; resolve: boolean };
export type BoardAsset = { id: string; name: string; kind: AssetKind; topic_id?: string; knowledge_category_name?: string | null; description?: string | null; department_id: number | null; published_at?: string | null };
export type BoardDepartment = { id: number; name: string };
export type LedgerInput = {
  kind: LedgerKind;
  name: string;
  year: number;
  indicator: GoalIndicator | null;
  asset_key: string | null;
  target: number | null;
  unit: string | null;
  department_id: number | null;
  parent_id: string | null;
  effective_date: string | null;
};
export type LedgerRow = LedgerInput & { id: string; revision: number; is_featured?: boolean };
export type BoardRun = { id: string; asset_id: string; status: string; ended_at: string; active_seconds: number | null };
export type RuntimeMetrics = {
  scope: string; observed_runs: number; successful_tasks: number | null; failed_tasks: number | null;
  active_seconds: number | null; timed_tasks: number; timing_coverage: number | null;
  tool_success: number | null; tool_failure: number | null; skill_calls: number | null;
  knowledge_success: number | null; file_outputs: number | null; code_versions: number | null;
  deliverables: number | null; coverage_note: string; recent_runs: BoardRun[];
  usage: { kind: AssetKind; asset_id: string; count: number }[];
  department_usage: { department_id: number | null; count: number }[];
  detail_access: boolean;
  observed_timing_coverage: number | null;
};
export type SceneUsage = {
  id:string; name:string; topic:string; topic_name?:string; asset_ids?:string[]; department_id:number|null; launched:string|null;
  year:number; last90:number; month:number; positive_rate:number|null; month_positive_rate:number|null;
  month_hours:number|null;month_linked:number;month_negative:number;last_used:string|null;
};
export type BoardOverview = {
  scene_asset_links?: Record<string, string[]>;
  scene_service?: {
    uses: number; users: number;
    employees: {
      asset_id: string; name: string; scenes: { id: string; name: string }[];
      uses: number; users: number; monitored: boolean;
    }[];
  } | null;
  scene_usage?: SceneUsage[];
  year: number; month: number | null; cutoff: string; catalog_as_of: string; assets: BoardAsset[]; departments: BoardDepartment[];
  ledger: LedgerRow[]; runtime: RuntimeMetrics;
  strategy: { employee_built: number; scene_launched: number; knowledge_verified: number; employee_target: number | null; scene_target: number | null; knowledge_target: number | null; knowledge_planned: number; knowledge_categories: {id:string; name:string; planned_date:string | null; target:number; completed:number}[] };
  satisfaction: { successful: number; linked: number; negative: number; positive_rate: number | null };
};
const base = "/api/v1/company-boards";
export function getBoardAccess() {
  return request.get<unknown, BoardAccess>(base + "/access");
}
export function getBoardOverview(board: CompanyBoard, year: number, month: number) {
  return request.get<unknown, BoardOverview>(base + "/overview", { params: { board, year, month } });
}
export function saveLedger(input: LedgerInput, existing?: LedgerRow) {
  return existing
    ? request.put<unknown, LedgerRow>(base + "/ledger/" + encodeURIComponent(existing.id), { ...input, revision: existing.revision })
    : request.post<unknown, LedgerRow>(base + "/ledger", input);
}
export function getBoardLedger(year: number) {
  return request.get<unknown, LedgerRow[]>(base + "/ledger", { params: {year} });
}
