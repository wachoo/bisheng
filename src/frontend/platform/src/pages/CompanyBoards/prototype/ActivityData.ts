import { useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PrototypeViewProps } from "./types";
import { getMonitoring, type MonitorSnapshot } from "@/controllers/API/companyMonitoring";
import { userContext } from "@/contexts/userContext";
import type { AssetKind, BoardOverview, CompanyBoard } from "@/controllers/API/companyBoards";
import { getActivityTrends, type TrendPeriod, type TrendRow } from "@/controllers/API/activityTrends";

export const kinds: AssetKind[] = ["employee", "knowledge", "skill", "tool"];
export const kindNames = { employee: "数字员工", knowledge: "知识库", skill: "Skill", tool: "工具/MCP" };
export const kindColors = { employee: "#286889", knowledge: "#328e81", skill: "#6385ae", tool: "#9a855f" };

export function sceneAssets(props: PrototypeViewProps, sceneIds: Set<string>) {
  const { data, registers } = props;
  const ids = new Set(
    data.ledger
      .filter(
        (r) =>
          r.kind === "release" &&
          sceneIds.has(r.parent_id) &&
          r.effective_date &&
          r.effective_date <= data.cutoff &&
          r.asset_key,
      )
      .map((r) => r.asset_key),
  );
  for (const r of registers)
    if (
      r.kind === "scene-asset" &&
      sceneIds.has(r.parent_id) &&
      r.date <= data.cutoff &&
      (!r.fields.end || r.fields.end >= data.cutoff) &&
      r.fields.asset
    )
      ids.add(r.fields.asset);
  return ids;
}
export function useTopicMonitoring(props: PrototypeViewProps, enabled: boolean) {
  const { user } = useContext(userContext);
  const scope = { topic: "", scene: "", department: "", kind: "" };
  return useQuery<MonitorSnapshot>({
    queryKey: ["company-board-monitoring", user?.tenant_id, user?.user_id, props.board, props.period, scope],
    queryFn: () => getMonitoring(props.board, props.period, scope),
    enabled,
    staleTime: 60000,
  });
}

export function useBoardTrends(data: BoardOverview, board: CompanyBoard) {
  const { user } = useContext(userContext);
  return useQuery({
    queryKey: ["company-boards", "trends", user?.user_id, user?.tenant_id, board, data.year, data.month],
    queryFn: () => getActivityTrends(board, data.year, data.month || 12),
    staleTime: 60000,
  });
}

export function aggregation(period?: TrendPeriod, asset?: string, department = "all") {
  const rows = (period?.rows || []).filter(
    (r) =>
      (!asset || r.asset_id === asset) &&
      (department === "all" || (r.department_id?.toString() || "unassigned") === department),
  );
  const count = (
    group: TrendRow[],
    field: keyof Pick<
      TrendRow,
      "successful" | "entered" | "failed" | "timed" | "active_seconds" | "negative" | "linked"
    >,
  ) => group.reduce((total, row) => total + row[field], 0);
  const employees = rows.filter((r) => r.kind === "employee");
  const success = count(employees, "successful"),
    failed = count(employees, "failed"),
    timed = count(employees, "timed");
  const linked = count(employees, "linked"),
    negative = count(employees, "negative");
  const hasEvents = rows.length > 0;
  const files =
    period?.files_known && hasEvents
      ? count(
          rows.filter((r) => r.kind === "file"),
          "successful",
        )
      : null;
  const versions = hasEvents
    ? count(
        rows.filter((r) => r.kind === "version"),
        "successful",
      )
    : null;
  const uses = (kind?: AssetKind) =>
    hasEvents
      ? rows.reduce(
          (n, r) =>
            n +
            ((!kind || r.kind === kind) && kinds.includes(r.kind as AssetKind)
              ? r.kind === "skill"
                ? r.entered
                : r.successful
              : 0),
          0,
        )
      : null;
  const attempts = success + failed;
  const healthy = attempts ? success / attempts : null;
  const metered = rows.filter((r) => r.tokens !== null);
  const tokens = metered.length ? metered.reduce((sum, r) => sum + r.tokens, 0) : null;
  const rounds = employees.length ? employees.reduce((sum, r) => sum + r.rounds, 0) : null;
  const outputs = rows.filter((r) => (r.kind === "file" || r.kind === "version") && r.successful > 0);
  return {
    rows,
    uses,
    files,
    versions,
    tokens,
    rounds,
    outputs,
    deliveries: files === null || versions === null ? null : files + versions,
    success: hasEvents ? success : null,
    failed: hasEvents ? failed : null,
    hours: timed ? count(employees, "active_seconds") / 3600 : null,
    timed,
    timerCoverage: attempts ? timed / attempts : null,
    rating: success && linked === success ? (success - negative) / success : null,
    health: healthy === null ? "未监测" : healthy >= 0.98 ? "正常" : healthy >= 0.95 ? "关注" : "异常",
  };
}
export function monthlyReleases(data: BoardOverview) {
  return data.ledger.filter(
    (r) =>
      r.kind === "release" &&
      r.effective_date &&
      r.effective_date <= data.cutoff &&
      r.effective_date.slice(0, 7) === data.cutoff.slice(0, 7),
  );
}
export function fmt(n: number | null | undefined, digits = 2) {
  return n == null || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        maximumFractionDigits:
          Math.abs(n) > 0 && Math.abs(n) < 10 ** -digits
            ? Math.min(8, 1 - Math.floor(Math.log10(Math.abs(n))))
            : digits,
      }).format(n);
}
export const pct = (n: number | null | undefined) => (n == null ? "—" : fmt(n * 100, 1) + "%");
