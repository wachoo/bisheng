import type { LedgerKind, LedgerRow } from "@/controllers/API/companyBoards";
import type { SupplementalRow, SupplementKind } from "@/controllers/API/companyRegisters";

export type RegisterKind = LedgerKind | SupplementKind;
type Parent = "project" | "receivable" | "topic" | "scene" | "asset" | "collection";
interface Definition {
  parent?: Parent;
  fields: string[];
  required: string[];
}
export const supplementForms: Record<SupplementKind, Definition> = {
  project: { fields: ["ai", "end", "budget"], required: ["ai"] },
  subject: { parent: "project", fields: ["ai", "end"], required: ["ai"] },
  expense: { parent: "project", fields: ["amount"], required: ["amount"] },
  receivable: { parent: "project", fields: ["contract", "amount"], required: ["contract", "amount"] },
  receipt: { parent: "receivable", fields: ["amount"], required: ["amount"] },
  estimate: {
    parent: "scene",
    fields: ["hours", "hourly", "saving"],
    required: ["hours", "hourly", "saving"],
  },
  recognition: { parent: "scene", fields: ["end"], required: [] },
  case: {
    parent: "topic",
    fields: ["scene", "assets", "summary", "action", "input", "sampleTitle", "sampleTable", "output"],
    required: ["scene"],
  },
  "collection-meta": { parent: "collection", fields: ["category"], required: ["category"] },
  "asset-profile": { parent: "asset", fields: ["direction", "description", "rules"], required: [] },
  "scene-asset": { parent: "scene", fields: ["asset", "end"], required: ["asset"] },
  "scene-team": { parent: "scene", fields: ["department", "end"], required: ["department"] },
  "value-rate": {
    fields: ["category", "unit", "hours", "hourly"],
    required: ["category", "unit", "hours", "hourly"],
  },
};
export const registerGroups: { name: string; kinds: RegisterKind[] }[] = [
  {
    name: "construction",
    kinds: ["goal", "topic", "scene", "scene-team", "release", "collection", "collection-meta"],
  },
  {
    name: "applications",
    kinds: ["case", "scene-asset", "asset-profile", "recognition", "estimate", "value-rate"],
  },
  { name: "finance", kinds: ["project", "subject", "expense", "receivable", "receipt"] },
];
export function isSupplement(kind: RegisterKind): kind is SupplementKind {
  return Object.prototype.hasOwnProperty.call(supplementForms, kind);
}

const destinations: Record<RegisterKind, string> = {
  goal: "strategy:goals",
  topic: "strategy:topics",
  case: "strategy:topics",
  scene: "strategy:construction",
  "scene-team": "strategy:construction",
  release: "strategy:plan",
  collection: "strategy:knowledge",
  "collection-meta": "strategy:knowledge",
  "scene-asset": "strategy:construction",
  "asset-profile": "strategy:assets:all",
  recognition: "strategy:highvalue",
  estimate: "strategy:forecast",
  project: "strategy:research",
  subject: "strategy:research:subject",
  expense: "strategy:spending",
  receivable: "strategy:receivables",
  receipt: "strategy:receivables",
  "value-rate": "labor:year",
};

export function registerTarget(kind: RegisterKind, row?: LedgerRow | SupplementalRow): string {
  if (!row) return destinations[kind];
  if (kind === "topic") return "strategy:topic:" + row.id;
  if (kind === "case" && row.parent_id) return "strategy:topic:" + row.parent_id;
  if (kind === "asset-profile" && row.parent_id) return "asset:" + row.parent_id;
  if (kind === "scene") return "strategy:scene:" + row.id;
  if (["scene-team", "scene-asset", "recognition", "estimate"].includes(kind) && row.parent_id)
    return "strategy:scene:" + row.parent_id;
  if (kind === "release" && "asset_key" in row && row.asset_key) return "asset:" + row.asset_key;
  return destinations[kind];
}
