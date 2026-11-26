import { useTranslation } from "react-i18next";
import { Segmented, StateView } from "@bisheng/ui";
import { Outlined } from "bisheng-icons";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getMonitoring,
  type MonitorScope,
  type MonitorSnapshot,
  type OperationalAsset,
} from "@/controllers/API/companyMonitoring";
import type { PrototypeViewProps } from "./types";
import {
  assetTarget,
  colors,
  Filters,
  fmt,
  health,
  healthStates,
  kindNames,
  ratio,
  useMonitorFilters,
  useMonitorIdentity,
} from "./MonitorParts";
import { MonitorTrend } from "./MonitorTrend";
import { MonitorFeedback } from "./MonitorFeedback";
import "./monitor.css";

export { MonitorDetail } from "./MonitorDetail";

export function useMonitoring(props: PrototypeViewProps, scope: MonitorScope) {
  const user = useMonitorIdentity();
  return useQuery({
    queryKey: ["company-board-monitoring", ...user, props.board, props.period, scope],
    queryFn: () => getMonitoring(props.board, props.period, scope),
  });
}

export function ManagementCards({
  assets,
  open,
}: {
  assets: OperationalAsset[];
  open: PrototypeViewProps["open"];
}) {
  const { t } = useTranslation("companyBoards", { keyPrefix: "monitorView" });
  const monitored = assets.filter((a) => a.monitored),
    success = monitored.reduce((n, a) => n + a.success, 0),
    fail = monitored.reduce((n, a) => n + a.failed, 0);
  const abnormal = monitored.filter(a => health(a) === "异常").length;
  const finished = success + fail;
  const metric = (label: string, value: string, unit: string, note: string, icon: ReactNode, tone: string, target?: string) => {
    const content = (
      <>
        <span className="om-metric-name">{label}{target && <Outlined.ArrowRightUp aria-hidden />}</span>
        <strong>{value}{unit && <em>{unit}</em>}</strong>
        <small>{note}</small>
        <span className="om-metric-icon" aria-hidden>{icon}</span>
      </>
    );
    return target ? (
      <button className="om-metric" data-tone={tone} type="button" data-op-drill={target}
        onClick={() => open("monitor:ledger:" + target, "资产运行台账")}>
        {content}
      </button>
    ) : <div className="om-metric" data-tone={tone}>{content}</div>;
  };
  return (
    <div className="om-metrics">
      {metric("纳入管理的资产", fmt(assets.length), "项", fmt(monitored.length) + " 项已监测",
        <Outlined.Dashboard />, "primary", "all")}
      {metric("运行成功率", ratio(success, finished), "",
        monitored.length ? fmt(finished) + " 次已结束运行" : t("successDefinition"), <Outlined.CheckCircle />, "neutral")}
      {metric("失败次数", monitored.length ? fmt(fail) : "—", monitored.length ? "次" : "",
        monitored.length ? fmt(monitored.filter(a => a.failed > 0).length) + " 项资产有失败记录" : t("noMonitoring"),
        <Outlined.FileSearch />, fail ? "danger" : "neutral")}
      {metric("异常资产", monitored.length || !assets.length ? fmt(abnormal) : "—",
        monitored.length || !assets.length ? "项" : "",
        monitored.length ? fmt(monitored.filter(a => health(a) === "关注").length) + " 项处于关注状态" : t("unknownHealth"),
        <Outlined.Info />, abnormal ? "danger" : "neutral", "异常")}
    </div>
  );
}

function HealthRing({ snapshot, open }: { snapshot: MonitorSnapshot; open: PrototypeViewProps["open"] }) {
  const { t } = useTranslation("companyBoards", { keyPrefix: "monitorView" });
  const { assets } = snapshot, total = assets.length;
  const counts = healthStates.map((status) => assets.filter((a) => health(a) === status).length);
  let angle = 0;
  const gradient = healthStates
    .flatMap((status, i) => {
      if (!counts[i]) return [];
      const start = angle;
      angle += (counts[i] / total) * 100;
      return colors[status] + " " + start + "% " + angle + "%";
    })
    .join(",");
  return (
    <section className="om-panel om-health-panel">
      <header>
        <h2>资产健康分布</h2>
        <span>{t("assetCount", { total: fmt(total) })}</span>
      </header>
      <div className="om-health">
        <div
          className="om-ring"
          style={{ background: gradient ? "conic-gradient(" + gradient + ")" : "var(--al-line)" }}
        >
          <div>
            <strong>{ratio(total - counts[4], total)}</strong>
            <span>监测覆盖率</span>
          </div>
        </div>
        <div className="om-legend">
          {healthStates.map((s, i) => (
            <button
              key={s}
              type="button"
              className="om-legend-row"
              data-op-drill={s}
              onClick={() => open("monitor:ledger:" + s, "资产运行台账")}
            >
              <i style={{ background: colors[s] }} />
              <span>{s}</span>
              <strong>{fmt(counts[i])}</strong>
              <small>{ratio(counts[i], total)}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Rankings({
  props,
  assets,
  oneType,
}: {
  props: PrototypeViewProps;
  assets: OperationalAsset[];
  oneType: boolean;
}) {
  const { t } = useTranslation("companyBoards", { keyPrefix: "monitorView" });
  const { params, change, scope } = useMonitorFilters();
  const mode = params.get("om-list") === "leaders" ? "leaders" : "abnormal";
  const abnormal = mode === "abnormal";
  const rows = abnormal
    ? assets
        .filter((a) => health(a) === "异常")
        .sort(
          (a, b) =>
            b.failed - a.failed ||
            b.failed / (b.failed + b.success) - a.failed / (a.failed + a.success) ||
            a.id.localeCompare(b.id),
        )
    : assets
        .filter((a) => health(a) === "正常" && a.success > 0)
        .sort((a, b) => b.success - a.success || a.id.localeCompare(b.id));
  const selected =
    abnormal || oneType
      ? rows.slice(0, 5)
      : Object.keys(kindNames).flatMap((kind) => rows.find((a) => a.kind === kind) ?? []);
  function emptyMessage() {
    if (!assets.length) return t("noAssets");
    const monitored = assets.filter(a => a.monitored);
    if (!monitored.length) return t("notRanked");
    if (monitored.every(a => a.success + a.failed === 0)) return t("noRuns");
    return abnormal ? t("noAnomalies") : t("noLeaders");
  }
  const depts = new Map(props.data.departments.map((d) => [d.id, d.name]));
  return (
    <section className="om-panel om-list">
      <header>
        <h2>重点资产</h2>
        <Segmented size="small" aria-label={t("rankingGroup")} value={mode}
          onChange={value => change("list", value)}
          options={[
            { value: "abnormal", label: <span data-op-list-choice="abnormal">{t("abnormalList")}</span> },
            { value: "leaders", label: <span data-op-list-choice="leaders">{t("leadersList")}</span> },
          ]} />
      </header>
      <div data-op-list={mode}>
        <p className="al-caption">
          {abnormal
            ? "按失败次数排序 · 最多 5 项"
            : oneType
              ? "健康正常 · 成功次数前 5"
              : "健康正常 · 各类型成功次数第一"}
        </p>
        <div className="om-ranking">
          {selected.length ? (
            selected.map((row) => {
              const num = abnormal ? row.failed : row.success;
              return (
                <button
                  key={row.id}
                  data-detail={"asset:" + row.id}
                  onClick={() => props.open(assetTarget(row.id), row.name)}
                >
                  <span className="om-asset-title">
                    {row.name}
                    <small>
                      {kindNames[row.kind]} · {depts.get(row.department_id ?? -1) || "待核实"}
                    </small>
                  </span>
                  <strong>
                    {fmt(num)}{" "}
                    <small>
                      次{row.kind === "employee" ? "执行" : row.kind === "knowledge" ? "检索" : "调用"}
                      {abnormal ? "失败" : "成功"}
                    </small>
                    <small className="om-ratio">
                      {abnormal ? "失败率 " : "成功率 "}
                      {ratio(num, row.success + row.failed)}
                    </small>
                  </strong>
                </button>
              );
            })
          ) : (
            <StateView size="inline" className="om-list-empty" title={emptyMessage()} />
          )}
        </div>
      </div>
    </section>
  );
}

function MonthPicker({ props }: { props: PrototypeViewProps }) {
  const { t, i18n } = useTranslation("companyBoards", { keyPrefix: "monitorView" });
  const monthFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    year: "numeric", month: "long", timeZone: "UTC",
  });
  const current = props.data.catalog_as_of.slice(0, 7);
  const [year, month] = current.split("-").map(Number);
  const months = Array.from(
    { length: Math.max(24, Math.min(12 * (year - Number(props.period.slice(0, 4)) + 1), 12 * 10)) },
    (_, i) => {
      const d = new Date(Date.UTC(year, month - 1 - i, 1));
      return d.toISOString().slice(0, 7);
    },
  );
  if (!months.includes(props.period)) months.push(props.period);
  return (
    <label className="al-month-picker">
      <span>{t("month")}</span>
      <select
        className="al-select"
        data-month
        aria-label={t("monthPicker")}
        value={props.period}
        onChange={(e) => props.changePeriod(e.target.value)}
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {monthFormat.format(new Date(m + "-01T00:00:00Z"))}
          </option>
        ))}
      </select>
    </label>
  );
}
export default function Monitor(props: PrototypeViewProps) {
  const { scope, change } = useMonitorFilters();
  const query = useMonitoring(props, scope);
  const snap = query.data;
  return (
    <>
      {!snap ? (
        query.isError ? (
          <p role="alert" className="al-empty">
            运行数据加载失败{" "}
            <button className="al-button" onClick={() => void query.refetch()}>
              重试
            </button>
          </p>
        ) : (
          <p role="status" className="al-empty">
            正在加载运行数据…
          </p>
        )
      ) : (
        <div className="om-dashboard" data-op-view="home/all">
          <div className="om-tools">
            <Filters props={props} scope={scope} change={change} {...snap.filters} />
            <div className="om-tool-actions">
              <MonthPicker props={props} />
              <button
                className="om-register-link"
                data-op-drill="all"
                onClick={() => props.open("monitor:ledger:all", "资产运行台账")}
              >
                资产运行台账 <Outlined.ArrowRightUp aria-hidden />
              </button>
            </div>
          </div>
          <ManagementCards assets={snap.assets} open={props.open} />
          <div className="om-grid">
            <MonitorTrend snapshot={snap} period={props.period} cutoff={props.data.cutoff} open={props.open} />
            <HealthRing snapshot={snap} open={props.open} />
            <Rankings props={props} assets={snap.assets} oneType={!!scope.kind} />
            <MonitorFeedback
              props={props}
              scope={scope}
              hasEmployees={snap.assets.some((a) => a.kind === "employee")}
            />
          </div>
        </div>
      )}
    </>
  );
}
