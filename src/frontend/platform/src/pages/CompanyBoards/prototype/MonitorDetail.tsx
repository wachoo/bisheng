import type { MonitorScope } from "@/controllers/API/companyMonitoring";
import { useMonitoring } from "./Monitor";
import { fmt as metric, pct } from "./ActivityData";
import { FeedbackItem, FeedbackQueue, FeedbackRun } from "./MonitorFeedback";
import {
  assetTarget,
  DataTable,
  Filters,
  fmt,
  health,
  healthStates,
  HealthHelp,
  kindNames,
  Pager,
  Panel,
  stamp,
  useMonitorFilters,
} from "./MonitorParts";
import type { PrototypeDetailProps } from "./types";

const healthClass: Record<string, string> = {
  异常: "al-health-alert",
  关注: "v8-health-watch",
  正常: "v8-health-ok",
};
const healthOrder = ["all", ...healthStates];
function TopicSummary({ props, topic }: { props: PrototypeDetailProps; topic: string }) {
  const scoped = props.data.scene_usage?.filter(s => s.topic === topic) || [];
  const count = scoped.reduce((n,s)=>n+s.month,0);
  const linked = scoped.reduce((n,s)=>n+s.month_linked,0);
  const negative = scoped.reduce((n,s)=>n+s.month_negative,0);
  const hours = scoped.some(s=>s.month_hours!=null) ? scoped.reduce((n,s)=>n+(s.month_hours||0),0) : null;
  const totals = {success:count, hours, rating:count>0 && linked===count ? 1-negative/count : null};
  return (
    <Panel
      title="数字员工作业与评价"
      extra={
        <button className="al-link" onClick={() => props.open("topic-scenes:" + topic, "场景使用与评价")}>
          查看场景使用 ↗
        </button>
      }
    >
      <DataTable
        headers={["有效使用次数", "作业工时（小时）", "好评率"]}
        rows={[[metric(totals.success), metric(totals.hours), pct(totals.rating)]]}
      />
      <span className="al-caption">按执行当日可唯一归属的场景汇总。跨场景共用且归属未明的执行计入公司总量。</span>
    </Panel>
  );
}

function Ledger({
  props,
  topic,
  initialHealth,
  initialKind = "",
}: {
  props: PrototypeDetailProps;
  topic?: string;
  initialHealth: string;
  initialKind?: string;
}) {
  const controls = useMonitorFilters(topic);
  const page = Math.max(1, Number(controls.params.get("om-page")) || 1);
  const saved = controls.params.get("om-ledger-health");
  const selected =
    controls.params.get("om-ledger-entry") === props.target && saved && healthOrder.includes(saved)
      ? saved
      : healthOrder.includes(initialHealth)
        ? initialHealth
        : "all";
  const setPage = (value: number) => controls.change("page", String(value));
  const scope: MonitorScope = { ...controls.scope, kind: controls.scope.kind || initialKind };
  const query = useMonitoring(props, scope);
  const snap = query.data;
  function change(key: string, value: string) {
    controls.change(key, value);
  }
  if (!snap)
    return (
      <p className="al-empty">
        {query.isError ? (
          <button className="al-link" onClick={() => void query.refetch()}>
            运行数据读取失败 · 重试
          </button>
        ) : (
          "正在读取运行台账…"
        )}
      </p>
    );
  const scoped = snap.assets;
  const filtered = scoped
    .filter((a) => selected === "all" || health(a) === selected)
    .sort(
      (a, b) =>
        healthOrder.indexOf(health(a)) - healthOrder.indexOf(health(b)) ||
        b.success + b.failed - (a.success + a.failed) ||
        a.id.localeCompare(b.id),
    );
  const actualPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 12)));
  const scenes = new Map(snap.filters.scenes.map((s) => [s.id, s.name]));
  const depts = new Map(props.data.departments.map((d) => [d.id, d.name]));
  const pageRows = filtered.slice((actualPage - 1) * 12, actualPage * 12);
  return (
    <>
      {topic && (
        <>
          <TopicSummary props={props} topic={topic} />
          <div className="al-toolbar al-operations-filters">
            <label className="al-revision-select">
              专题
              <select
                className="al-select"
                data-operations-topic
                value={topic}
                onChange={(e) =>
                  props.open(
                    "topic-operations:" + e.target.value,
                    e.target.selectedOptions[0].text + " · 资产运行",
                  )
                }
              >
                {snap.filters.topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
      <div className="op-ledger" data-op-view={topic ? "topic/" + topic : "register"}>
        <Filters props={props} scope={scope} change={change} {...snap.filters} fixedTopic={!!topic} />
        <div className="al-stats op-counts" role="group" aria-label="按健康状态筛选">
          {healthOrder.map((status) => (
            <button
              type="button"
              key={status}
              className="al-stat"
              data-op-health={status}
              aria-pressed={selected === status}
              onClick={() => controls.setHealth(props.target, status)}
            >
              <span className="al-stat-label">{status === "all" ? "纳入管理" : status}</span>
              <span className="al-stat-value">
                {fmt(status === "all" ? scoped.length : scoped.filter((a) => health(a) === status).length)}
                <small>项</small>
              </span>
            </button>
          ))}
        </div>
        <Panel
          title="资产运行台账"
          extra={
            <span className="al-caption">
              {selected === "all" ? "全部状态" : selected} · {fmt(filtered.length)} 项
            </span>
          }
        >
          <DataTable
            headers={[
              "资产名称",
              "类型",
              "归属部门",
              <>
                健康状态 <HealthHelp />
              </>,
              "运行或调用总数",
              "成功数",
              "失败数",
              "最近运行",
            ]}
            rows={pageRows.map((row) => {
              const label = health(row),
                dept = depts.get(row.department_id ?? -1);
              return [
                <>
                  <button
                    className="al-link"
                    onClick={() => props.open(assetTarget(row.id), row.name)}
                  >
                    {row.name} ↗
                  </button>
                  {row.scene_ids.length > 0 && (
                    <small>
                      {row.scene_ids
                        .map((id) => scenes.get(id))
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  )}
                </>,
                kindNames[row.kind],
                dept ? (
                  <button className="al-link" onClick={() => props.open("department:" + row.department_id, dept)}>
                    {dept} ↗
                  </button>
                ) : (
                  "归属待核实"
                ),
                <span className={"al-tag " + (healthClass[label] || "muted")}>{label}</span>,
                ...[row.success + row.failed, row.success, row.failed].map((v) => (row.monitored ? fmt(v) : "—")),
                stamp(row.last),
              ];
            })}
          />
          <Pager total={filtered.length} page={actualPage} setPage={setPage} />
        </Panel>
      </div>
    </>
  );
}

function SceneAssets({props,id}:{props:PrototypeDetailProps;id:string}) {
  const query=useMonitoring(props,{topic:"",scene:id,department:"",kind:""});
  if(!query.data)return <p className="al-empty">{query.isError?<button onClick={()=>void query.refetch()}>数据读取失败 · 重试</button>:"正在读取…"}</p>;
  const scene=query.data.filters.scenes.find(s=>s.id===id);
  const topic=query.data.filters.topics.find(t=>t.id===scene?.topic_id);
  return <Panel title="场景运行资产" extra={topic&&<button className="al-link" onClick={()=>props.open("topic-operations:"+topic.id,topic.name)}>{topic.name} ↗</button>}>
    <DataTable headers={["资产名称","类型","成功数","失败数","健康状态"]} rows={query.data.assets.map(a=>[
      <button className="al-link" onClick={()=>props.open(assetTarget(a.id),a.name)}>{a.name} ↗</button>,kindNames[a.kind],a.monitored?a.success:"—",a.monitored?a.failed:"—",health(a)])}/></Panel>;
}

export function MonitorDetail(props: PrototypeDetailProps) {
  const { scope } = useMonitorFilters(),
    [prefix, target, id, extra] = props.target.split(":");
  if(prefix==="monitor" && target==="scene")return <SceneAssets props={props} id={id}/>;
  if (prefix === "topic-operations") {
    const type = Object.entries(kindNames).find(([key, name]) => key === id || name === id)?.[0] || "";
    return (
      <Ledger key={props.target} props={props} topic={target} initialKind={type} initialHealth={extra || "all"} />
    );
  }
  if (prefix === "operations-register" || (prefix === "monitor" && target === "ledger"))
    return <Ledger key={props.target} props={props} initialHealth={id || "all"} />;
  if (prefix !== "monitor" && prefix !== "feedback-queue") return null;
  if (target === "run" && (props.access.resolve || props.access.manage))
    return <FeedbackRun props={props} id={id} />;
  if (!props.access.resolve) return <p className="al-empty">反馈处置明细仅对具有处置权限的账号开放。</p>;
  if (target === "feedback" || prefix === "feedback-queue")
    return (
      <FeedbackQueue
        key={props.target}
        props={props}
        scope={scope}
        initial={id === "closed" ? "closed" : "pending"}
      />
    );
  if (target === "issue") return <FeedbackItem key={props.target} props={props} scope={scope} id={id} />;
  return null;
}
