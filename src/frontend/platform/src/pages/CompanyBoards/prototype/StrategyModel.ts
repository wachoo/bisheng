import type { AssetKind, BoardOverview, SceneUsage } from "@/controllers/API/companyBoards";
import type { PrototypeViewProps } from "./types";

export function rankedScenes(scenes: SceneUsage[], cutoff: string) {
  return scenes
    .filter(
      (s) =>
        s.launched &&
        s.launched <= cutoff &&
        s.last90 > 0 &&
        s.positive_rate != null &&
        s.positive_rate >= 0.9,
    )
    .sort((a, b) => b.last90 - a.last90 || b.positive_rate! - a.positive_rate! || a.id.localeCompare(b.id));
}

export function constructionAssetTarget(assetId: string, month?: string) {
  return "asset:" + assetId + (month ? "?window=month&month=" + month : "?window=year");
}
export const kinds: { kind: AssetKind; label: string; unit: string; color: string }[] = [
  { kind: "employee", label: "数字员工", unit: "位", color: "var(--al-blue)" },
  { kind: "knowledge", label: "知识库", unit: "个", color: "var(--al-teal)" },
  { kind: "skill", label: "Skill", unit: "项", color: "var(--al-slate)" },
  { kind: "tool", label: "工具/MCP", unit: "项", color: "var(--al-amber)" },
];

export function strategyRows(data: BoardOverview) {
  const topics = data.ledger.filter((row) => row.kind === "topic");
  const scenes = data.ledger.filter((row) => row.kind === "scene");
  const plans = data.ledger.filter((row) => row.kind === "release");
  const published = plans.filter(
    (row) =>
      row.effective_date &&
      row.effective_date <= data.cutoff &&
      Number(row.effective_date.slice(0, 4)) === data.year,
  );
  const workers = published.filter((row) => /^(assistant|flow|app):/.test(row.asset_key || ""));
  const depCounts = new Map<number, number>();
  for (const row of published)
    if (row.department_id != null)
      depCounts.set(row.department_id, (depCounts.get(row.department_id) || 0) + 1);
  const depRanks = Array.from(depCounts, ([id, count]) => ({
    id,
    count,
    name: data.departments.find((d) => d.id === id)?.name || "未归属",
  })).sort((a, b) => b.count - a.count || a.id - b.id);
  const workerRanks = data.runtime.usage
    .filter((r) => r.kind === "employee")
    .map((r) => ({
      id: r.asset_id,
      count: r.count,
      name: data.assets.find((a) => a.id === r.asset_id)?.name || r.asset_id,
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { topics, scenes, plans, published, workers, depRanks, workerRanks };
}

export function sceneAssetIds(
  data: BoardOverview,
  registers: PrototypeViewProps["registers"],
  scene: string,
) {
  const managed = data.scene_asset_links?.[scene];
  if (managed) return new Set(managed);
  const ids = new Set<string>(data.scene_usage?.find((s) => s.id === scene)?.asset_ids || []);
  for (const row of data.ledger) {
    if (
      row.kind === "release" &&
      row.parent_id === scene &&
      row.asset_key &&
      row.effective_date &&
      row.effective_date <= data.cutoff
    )
      ids.add(row.asset_key);
  }
  for (const row of registers) {
    if (row.date && row.date > data.cutoff) continue;
    if (
      row.kind === "scene-asset" &&
      row.parent_id === scene &&
      (!row.fields.end || row.fields.end >= data.cutoff)
    ) {
      if (row.fields.asset) ids.add(row.fields.asset);
    } else if (row.kind === "case" && row.fields.scene === scene) {
      for (const id of (row.fields.assets || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean))
        ids.add(id);
    }
  }
  return ids;
}

export function strategyTopicAssets(
  data: BoardOverview,
  registers: PrototypeViewProps["registers"],
  topic?: string,
) {
  if (!topic) return new Set<string>();
  const ids = new Set(
    data.ledger
      .filter((r) => r.kind === "scene" && r.parent_id === topic)
      .flatMap((s) => Array.from(sceneAssetIds(data, registers, s.id))),
  );
  for (const asset of data.assets) {
    if (asset.topic_id === topic) ids.add(asset.id);
  }
  for (const row of registers.filter(
    (r) => r.kind === "case" && r.parent_id === topic && (!r.date || r.date <= data.cutoff),
  )) {
    for (const id of (row.fields.assets || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean))
      ids.add(id);
  }
  return ids;
}
