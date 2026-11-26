import { Button, Input, Tabs } from "@bisheng/ui";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { userContext } from "@/contexts/userContext";
import { getBoardAccess, getBoardOverview, type CompanyBoard, type BoardOverview } from "@/controllers/API/companyBoards";
import { AssetDirectory, AssetMix, RunList } from "./BoardPanels";
import { BoardLedger } from "./BoardLedger";
import { FeedbackPanel } from "./FeedbackPanel";
import { formatMeasure } from "./measures";
import "./boards.css";

function currentMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return parts.find(p => p.type === "year")?.value + "-" + parts.find(p => p.type === "month")?.value;
}
interface SummaryMetric { key: string; value: number | null; unit?: string; detail?: string }
function MetricStrip({ metrics }: { metrics: SummaryMetric[] }) {
  const { t } = useTranslation("companyBoards");
  return <div className="cb-metric-strip">{metrics.map(({key, value, unit, detail}) =>
    <section className="cb-metric" key={key}><h2>{t(key)}</h2>
      <strong>{formatMeasure(value)}{unit && value != null && <small> {t(unit)}</small>}</strong>
      {detail && <p>{t(detail)}</p>}</section>)}</div>;
}
function Strategy({ data }: { data: BoardOverview }) {
  const { t } = useTranslation("companyBoards");
  const { strategy: stats } = data;
  const metrics = [
    {key:"buildEmployees", value:stats.employee_built, target:stats.employee_target},
    {key:"launched", value:stats.scene_launched, target:stats.scene_target},
    {key:"verified", value:stats.knowledge_verified, target:stats.knowledge_planned},
  ];
  return <><div className="cb-grid"><section className="cb-panel"><div className="cb-panel-heading"><h2>{t("annualPlan")}</h2><span>{data.year}</span></div>
    <p className="cb-note">{t("registeredProgress")} · {data.cutoff}</p><div className="cb-plan">{metrics.map(({key,value,target}) => {
      const pct = target && target > 0 ? 100 * value / target : null;
      return <div key={key}><div className="cb-plan-title"><span>{t(key)}</span><span><b>{formatMeasure(value)}</b> / {formatMeasure(target)}</span></div>
        <div className="cb-track"><i style={{width:Math.min(100, pct || 0) + "%"}} /></div>
        <small>{pct === null ? t("noTarget") : formatMeasure(pct, 1) + "%"}</small></div>;
    })}</div></section><AssetMix overview={data}/></div>
    <BoardLedger overview={data} editable={false}/></>;
}
function Impact({ data }: { data: BoardOverview }) {
  const { t } = useTranslation("companyBoards");
  const r = data.runtime;
  const hours = r.active_seconds == null ? null : r.active_seconds / 3600;
  const rating = data.satisfaction;
  return <><MetricStrip metrics={[{key:"successful",value:r.successful_tasks},{key:"hours",value:hours,unit:"hour",detail:"includesFailed"},
    {key:"coverage",value:r.timing_coverage == null ? null : r.timing_coverage * 100, unit:"percent"},{key:"deliverables",value:r.deliverables}]} />
    <section className="cb-panel"><div className="cb-panel-heading"><h2>{t("outputMix")}</h2><span>{t("periodCount")}</span></div><div className="cb-stats">
      <div><span>{t("fileOutputs")}</span><b>{formatMeasure(r.file_outputs)}</b><small>{t("fileRule")}</small></div>
      <div><span>{t("codeVersions")}</span><b>{formatMeasure(r.code_versions)}</b><small>{t("versionRule")}</small></div>
      <div><span>{t("workDays")}</span><b>{formatMeasure(hours == null ? null : hours / 8)}</b><small>{t("dayRule")}</small></div></div></section>
    <section className="cb-panel"><div className="cb-panel-heading"><h2>{t("observedQuality")}</h2><span>{data.cutoff}</span></div>
      <div className="cb-stats"><div><span>{t("measuredSatisfaction")}</span>
        <b>{rating.positive_rate == null ? "—" : formatMeasure(rating.positive_rate * 100) + "%"}</b>
        <small>{t("feedbackLinks", {linked:rating.linked, total:rating.successful, negative:rating.negative})}</small></div>
      <div><span>{t("observedTiming")}</span><b>{r.observed_timing_coverage == null ? "—" : formatMeasure(r.observed_timing_coverage * 100) + "%"}</b>
        <small>{t("timedCount", {count:r.timed_tasks})}</small></div></div></section>
    <RunList overview={data}/></>;
}
function Activity({data, period}: {data:BoardOverview; period:string}) {
  const { t } = useTranslation("companyBoards");
  const r = data.runtime;
  return <><MetricStrip metrics={[{key:"employeeUses",value:r.successful_tasks},{key:"knowledgeUses",value:r.knowledge_success},
    {key:"skillUses",value:r.skill_calls},{key:"toolUses",value:r.tool_success}]} />
    <div className="cb-grid"><AssetMix overview={data}/><section className="cb-panel"><div className="cb-panel-heading"><h2>{t("usageRank")}</h2><span>{t("topFive")}</span></div>
      {r.usage.length ? <ol className="cb-ranking">{[...r.usage].sort((a,b) => b.count - a.count || a.asset_id.localeCompare(b.asset_id)).slice(0,5).map(item =>
        <li key={item.kind + item.asset_id}><span>{data.assets.find(asset => asset.id === item.asset_id)?.name || item.asset_id}</span><strong>{formatMeasure(item.count)}</strong></li>)}</ol> : <p className="cb-empty">{t("noUses")}</p>}
    </section></div><section className="cb-panel"><div className="cb-panel-heading"><h2>{t("departmentUsage")}</h2><span>{period}</span></div>
      {r.department_usage.length ? <ol className="cb-ranking">{r.department_usage.map(row => <li key={row.department_id ?? "unknown"}>
        <span>{data.departments.find(d => d.id === row.department_id)?.name || t("unassigned")}</span><strong>{formatMeasure(row.count)}</strong></li>)}</ol> : <p className="cb-empty">{t("noUses")}</p>}
    </section><AssetDirectory overview={data} period={period}/></>;
}
export function CompanyBoardPage({ board }: {board:CompanyBoard}) {
  const { t } = useTranslation("companyBoards");
  const { user } = useContext(userContext);
  const [params, setParams] = useSearchParams();
  const today = currentMonth();
  const requestedPeriod = params.get("period") || "";
  const period = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(requestedPeriod) && requestedPeriod >= "2000-01" && requestedPeriod <= today ? requestedPeriod : today;
  const [year, month] = period.split("-").map(Number);
  const key = [user?.user_id, user?.tenant_id];
  const access = useQuery({queryKey:["company-boards", "access", ...key], queryFn:getBoardAccess});
  const data = useQuery({queryKey:["company-boards","overview", ...key, board, year, month], queryFn:() => getBoardOverview(board, year, month), enabled:Boolean(access.data?.[board])});
  const tabs = board === "lead" ? ["strategy","impact","activity"] : ["monitor","feedback", ...(access.data?.manage ? ["register"] : [])];
  const tab = tabs.find(item => item === params.get("view")) || tabs[0];
  const setParam = (name:string, value:string) => { const next = new URLSearchParams(params); next.set(name,value); setParams(next); };
  const overview = data.data;
  const runtime = overview?.runtime;
  return <main className="company-board">
    <div className="cb-frame"><header className="cb-heading"><div><h1>{t(board === "lead" ? "leadTitle" : "monitorTitle")}</h1>
      <p>{t(board === "lead" ? "leadDescription" : "monitorDescription")}</p></div>
      <label className="cb-period">{t("period")}<Input type="month" min="2000-01" max={today} value={period} aria-label={t("period")}
        onChange={e => {if (e.target.value && e.target.value <= today) setParam("period", e.target.value);}} /></label></header>
      {access.data?.[board] && <Tabs items={tabs.map(item => ({key:item, label:t(item)}))} activeKey={tab} onChange={v => setParam("view", v)} />}
      {access.isError || data.isError ? <div className="cb-panel cb-inline" role="alert">{t("loadFailed")}<Button onClick={() => access.isError ? void access.refetch() : void data.refetch()}>{t("retry")}</Button></div>
        : access.isLoading || (access.data?.[board] && data.isInitialLoading) ? <div className="cb-panel" role="status">{t("loading")}</div>
        : !access.data?.[board] ? <p className="cb-panel">{t("denied")}</p> : overview && runtime && <div className="cb-content" key={board + tab + period}>
          {tab === "strategy" && <Strategy data={overview}/>}
          {tab === "impact" && <Impact data={overview}/>}
          {tab === "activity" && <Activity data={overview} period={period}/>}
          {tab === "monitor" && <><MetricStrip metrics={[{key:"observed",value:runtime.observed_runs},{key:"successful",value:runtime.successful_tasks},
            {key:"failed",value:runtime.failed_tasks},{key:"toolFailure",value:runtime.tool_failure}]} />
            <RunList overview={overview}/><AssetDirectory overview={overview} period={period}/></>}
          {tab === "feedback" && <FeedbackPanel year={year} month={month} manage={Boolean(access.data.resolve)}/>}
          {tab === "register" && <BoardLedger overview={overview} editable={Boolean(access.data.manage)}/>}
          {["activity","impact","monitor"].includes(tab) && <aside className="cb-provenance"><b>{t("collectionScope")}</b><span>{runtime.scope}</span><p>{runtime.coverage_note}</p></aside>}
        </div>}
    </div></main>;
}
