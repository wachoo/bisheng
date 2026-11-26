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
  const monitored = assets.filter((a) => a.monitored),
    success = monitored.reduce((n, a) => n + a.success, 0),
    fail = monitored.reduce((n, a) => n + a.failed, 0);
  const metric = (label: string, value: string, unit: string, note: string, target?: string) => {
    const content = (
      <>
        <span>
          {label}
          {target ? " ↗" : ""}
        </span>
        <strong>
          {value}
          {unit && <em>{unit}</em>}
        </strong>
        <small>{note}</small>
      </>
    );
    return target ? (
      <button
        className="om-metric"
        type="button"
        data-op-drill={target}
        onClick={() => open("monitor:ledger:" + target, "资产运行台账")}
      >
        {content}
      </button>
    ) : (
      <div className="om-metric">{content}</div>
    );
  };
  return (
    <div className="om-metrics">
      {metric("纳入管理的资产", fmt(assets.length), "项", fmt(monitored.length) + " 项已监测", "all")}
      {metric("运行成功率", ratio(success, success + fail), "", fmt(success + fail) + " 次已结束运行")}
      {metric(
        "失败次数",
        monitored.length ? fmt(fail) : "—",
        monitored.length ? "次" : "",
        monitored.length
          ? fmt(monitored.filter((a) => a.failed > 0).length) + " 项资产有失败记录"
          : "当前范围无监测记录",
      )}
      {metric(
        "异常资产",
        fmt(assets.filter((a) => health(a) === "异常").length),
        "项",
        fmt(assets.filter((a) => health(a) === "关注").length) + " 项处于关注状态",
        "异常",
      )}
    </div>
  );
}

function HealthRing({ snapshot, open }: { snapshot: MonitorSnapshot; open: PrototypeViewProps["open"] }) {
  const { assets } = snapshot,
    total = assets.length;
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
        <span>按资产计</span>
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
  const depts = new Map(props.data.departments.map((d) => [d.id, d.name]));
  return (
    <section className="om-panel om-list">
      <header>
        <h2>重点资产</h2>
        <div className="al-tabs" role="group" aria-label="重点资产名单">
          {(["abnormal", "leaders"] as const).map((key, i) => (
            <button
              key={key}
              data-op-list-choice={key}
              aria-pressed={mode === key}
              onClick={() => change("list", key)}
            >
              {i ? "表现突出的资产" : "重点关注的异常资产"}
            </button>
          ))}
        </div>
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
            <p className="om-empty">
              {abnormal ? "当前范围没有达到异常阈值的资产" : "当前范围没有健康正常且有成功记录的资产"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function MonthPicker({ props }: { props: PrototypeViewProps }) {
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
      <span>月度数据</span>
      <select
        className="al-select"
        data-month
        aria-label="选择统计月份"
        value={props.period}
        onChange={(e) => props.changePeriod(e.target.value)}
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {m.slice(0, 4)} 年 {Number(m.slice(5))} 月
            {m === current ? " · 截至 " + Number(props.data.catalog_as_of.slice(8)) + " 日" : ""}
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
      <div className="al-page-heading op-heading">
        <div>
          <h1>数据资产运行监控</h1>
          <p>监测数字员工执行、知识库检索和工具／MCP 调用。</p>
        </div>
        <div className="op-period">
          <span>
            {props.period}-01 至 {props.data.cutoff} · 数据截止 {props.data.catalog_as_of}
          </span>
          <MonthPicker props={props} />
        </div>
      </div>
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
            <button
              className="om-register-link"
              data-op-drill="all"
              onClick={() => props.open("monitor:ledger:all", "资产运行台账")}
            >
              资产运行台账 ↗
            </button>
          </div>
          <ManagementCards assets={snap.assets} open={props.open} />
          <div className="om-grid">
            <MonitorTrend snapshot={snap} period={props.period} cutoff={props.data.cutoff} />
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
