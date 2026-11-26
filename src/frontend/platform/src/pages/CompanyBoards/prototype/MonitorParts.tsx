import { useTranslation } from "react-i18next";
import { useContext, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { userContext } from "@/contexts/userContext";
import type { MonitorScope, OperationalAsset, OperationalKind } from "@/controllers/API/companyMonitoring";
import type { PrototypeViewProps } from "./types";

export const healthStates = ["异常", "关注", "正常", "暂无执行", "未监测"] as const;
export type Health = (typeof healthStates)[number];
export const colors: Record<Health, string> = {
  异常: "color-mix(in srgb, rgb(var(--danger)) 64%, rgb(var(--text-3)))",
  关注: "color-mix(in srgb, rgb(var(--warning)) 64%, rgb(var(--text-3)))",
  正常: "color-mix(in srgb, rgb(var(--success)) 64%, rgb(var(--text-3)))",
  暂无执行: "rgb(var(--brand-muted))",
  未监测: "rgb(var(--border-deep))",
};
export const kindNames: Record<OperationalKind, string> = {
  employee: "数字员工",
  knowledge: "知识库",
  tool: "工具／MCP",
};
export const fmt = (value: number) => value.toLocaleString("zh-CN");
export const ratio = (num: number, den: number) => (den ? ((num / den) * 100).toFixed(1) + "%" : "—");
export function health(row: OperationalAsset): Health {
  if (!row.monitored) return "未监测";
  const total = row.success + row.failed;
  if (!total) return "暂无执行";
  if (row.kind !== "employee") return 100 * row.failed > 5 * total ? "异常" : "正常";
  return 100 * row.success >= 98 * total ? "正常" : 100 * row.success >= 95 * total ? "关注" : "异常";
}
export function assetTarget(id: string) {
  const query = new URLSearchParams({ window: "month" });
  return "asset:" + id + "?" + query.toString();
}
export function stamp(utc: string | null) {
  if (!utc) return "—";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(utc));
}
export function useMonitorIdentity() {
  const { user } = useContext(userContext);
  return [user?.tenant_id, user?.user_id];
}
export function useMonitorFilters(fixedTopic?: string) {
  const [params, setParams] = useSearchParams();
  const scope: MonitorScope = {
    topic: fixedTopic ?? params.get("om-topic") ?? "",
    scene: params.get("om-scene") ?? "",
    department: params.get("om-department") ?? "",
    kind: params.get("om-kind") ?? "",
  };
  function change(key: keyof MonitorScope | string, value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("om-" + key, value);
        else next.delete("om-" + key);
        if (key === "topic") next.delete("om-scene");
        if (key !== "page") next.delete("om-page");
        return next;
      },
      { replace: true },
    );
  }
  function setHealth(entry: string, value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("om-ledger-entry", entry);
        next.set("om-ledger-health", value);
        next.delete("om-page");
        return next;
      },
      { replace: true },
    );
  }
  return { scope, change, params, setHealth };
}
export function Panel({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="al-panel">
      <div className="al-panel-head">
        <h3>{title}</h3>
        {extra}
      </div>
      <div className="al-panel-body">{children}</div>
    </section>
  );
}
export function DataTable({
  headers,
  rows,
  empty = "没有匹配的记录",
}: {
  headers: ReactNode[];
  rows: ReactNode[][];
  empty?: string;
}) {
  return (
    <div className="al-table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((v, i) => (
              <th key={i}>{v}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="al-empty" colSpan={headers.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export function Pager({
  page,
  total,
  size = 12,
  setPage,
}: {
  page: number;
  total: number;
  size?: number;
  setPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="al-paging">
      <span>共 {fmt(total)} 项</span>
      <div>
        <button className="al-button" data-op-step="-1" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <span>
          {page} / {pages}
        </span>
        <button className="al-button" data-op-step="1" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
export function Filters({
  props,
  scope,
  change,
  topics,
  scenes,
  fixedTopic = false,
}: {
  props: PrototypeViewProps;
  scope: MonitorScope;
  change: (key: string, v: string) => void;
  topics: { id: string; name: string }[];
  scenes: { id: string; name: string }[];
  fixedTopic?: boolean;
}) {
  const { t } = useTranslation("companyBoards", { keyPrefix: "monitorView" });
  const controls: {
    key: keyof MonitorScope;
    title: string;
    all: string;
    items: { id: string; name: string }[];
  }[] = [
    ...(!fixedTopic ? [{ key: "topic" as const, title: "专题", all: "全部专题", items: topics }] : []),
    { key: "scene", title: "业务场景", all: "全部场景", items: scenes },
    {
      key: "department",
      title: "归属部门",
      all: "全部部门",
      items: [
        ...props.data.departments.map((d) => ({ id: String(d.id), name: d.name })),
        { id: "unknown", name: "归属待核实" },
      ],
    },
    {
      key: "kind",
      title: "资产类型",
      all: "全部类型",
      items: Object.entries(kindNames).map(([id, name]) => ({ id, name })),
    },
  ];
  return (
    <div className="al-toolbar al-operations-filters" role="group" aria-label={t("filters")}>
      {controls.map((c) => (
        <label key={c.key} className="al-revision-select">
          {c.title}
          <select
            className="al-select"
            data-op-field={c.key === "kind" ? "type" : c.key}
            value={scope[c.key]}
            onChange={(e) => change(c.key, e.target.value)}
          >
            <option value="">{c.all}</option>
            {c.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

export function HealthHelp() {
  return (
    <details className="wr-help op-health-help">
      <summary aria-label="查看三类资产健康判定规则" title="健康判定规则">
        ?
      </summary>
      <div style={{ whiteSpace: "normal", width: "19em" }}>
        <strong>数字员工</strong>按执行成功率分级，达到 98% 为正常，95% 至不足 98% 为关注，低于 95% 为异常。
        <br />
        <strong>知识库</strong>按检索失败率分级，超过 5% 为异常，其余为正常。检索成功返回空结果也计成功。
        <br />
        <strong>工具／MCP</strong>按调用失败率分级，超过 5% 为异常，其余为正常。超时和报错计为失败。
        <br />
        监测覆盖以截至日已有终态采集证据的资产计。当期无终态显示“暂无执行”，缺少接入证据显示“未监测”。
      </div>
    </details>
  );
}
