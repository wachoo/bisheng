import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { resolveBoardIssue } from "@/controllers/API/boardFeedback";
import {
  getMonitorIssues,
  getMonitorRun,
  type IssueStage,
  type MonitorScope,
} from "@/controllers/API/companyMonitoring";
import {
  assetTarget,
  DataTable,
  fmt,
  Pager,
  Panel,
  stamp,
  useMonitorFilters,
  useMonitorIdentity,
} from "./MonitorParts";
import type { PrototypeDetailProps, PrototypeViewProps } from "./types";

const stageLabel: Record<IssueStage, string> = { pending: "待处理", closed: "已处理" };
function useIssues(
  props: PrototypeViewProps,
  scope: MonitorScope,
  stage: IssueStage,
  page: number,
  limit: number,
  search = "",
  id = "",
) {
  const user = useMonitorIdentity();
  return useQuery({
    queryKey: ["monitor-issues", ...user, props.period, scope, stage, page, limit, search, id],
    queryFn: () => getMonitorIssues(props.period, scope, stage, (page - 1) * limit, limit, search, id),
    enabled: props.access.monitor,
  });
}
function workerName(props: PrototypeViewProps, id: string) {
  return props.data.assets.find((a) => a.id === "assistant:" + id)?.name || id;
}
export function MonitorFeedback({
  props,
  scope,
  hasEmployees,
}: {
  props: PrototypeViewProps;
  scope: MonitorScope;
  hasEmployees: boolean;
}) {
  const { params, change } = useMonitorFilters();
  const stage: IssueStage = params.get("om-feedbackTab") === "closed" ? "closed" : "pending";
  const q = useIssues(props, scope, stage, 1, 5);
  const result = q.data,
    items = result?.rows || [];
  return (
    <section className="om-panel om-feedback">
      <header>
        <h2>反馈问题管理</h2>
        <div className="fb-tabs" role="group" aria-label="问题状态">
          {(["pending", "closed"] as const).map((s) => (
            <button
              key={s}
              data-feedback-tab={stageLabel[s]}
              aria-pressed={s === stage}
              onClick={() => change("feedbackTab", s)}
            >
              {stageLabel[s]} <strong>{result ? fmt(result[s]) : "—"}</strong>
            </button>
          ))}
        </div>
      </header>
      <div className="fb-preview-tools">
        <span>
          {items.length > 0 &&
            (stage === "pending" ? "按提出时间" : "按处理时间") + " · 最近 " + items.length + " 条"}
        </span>
        {
          <button
            className="al-link"
            disabled={!props.access.resolve}
            title={props.access.resolve ? undefined : "当前账号仅可查阅反馈数量"}
            data-feedback-open={stageLabel[stage]}
            onClick={() => props.open("monitor:feedback:" + stage, "反馈问题管理")}
          >
            查看全部 ↗
          </button>
        }
      </div>
      <div className="fb-preview">
        {q.isError ? (
          <button className="al-link" onClick={() => void q.refetch()}>
            反馈加载失败 · 重试
          </button>
        ) : items.length ? (
          items.map((row) => (
            <button
              key={row.run_id}
              className="fb-preview-row"
              data-detail={"monitor:issue:" + row.run_id}
              onClick={() => props.open("monitor:issue:" + row.run_id, "反馈问题详情")}
            >
              <span>{row.measure || row.comment || "用户提交差评"}</span>
              <small>
                {workerName(props, row.asset_id)} · {row.resolved_at ? "处理于 " : "提出于 "}
                {stamp(row.resolved_at || row.opened_at).slice(5)}
              </small>
            </button>
          ))
        ) : (
          <DataTable
            headers={["反馈内容", "数字员工", stage === "pending" ? "提出时间" : "最近处置时间"]}
            rows={[]}
            empty={
              q.isLoading
                ? "正在读取反馈…"
                : !result?.details && result?.[stage]
                  ? "当前账号仅可查看反馈数量"
                  : !hasEmployees
                    ? "当前范围没有数字员工反馈"
                    : "暂无" + stageLabel[stage] + "问题"
            }
          />
        )}
      </div>
    </section>
  );
}

export function FeedbackQueue({
  props,
  scope,
  initial,
}: {
  props: PrototypeDetailProps;
  scope: MonitorScope;
  initial: IssueStage;
}) {
  const [stage, setStage] = useState(initial),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const q = useIssues(props, scope, stage, page, 12, search);
  const result = q.data;
  return (
    <>
      <div className="al-toolbar fb-queue-tools">
        <div className="al-filter">
          {(["pending", "closed"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={stage === s}
              onClick={() => {
                setStage(s);
                setPage(1);
              }}
            >
              {stageLabel[s]}
            </button>
          ))}
        </div>
        <input
          className="al-search"
          data-search
          aria-label="搜索反馈、数字员工或执行编号"
          placeholder="搜索反馈内容、员工或执行编号"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          maxLength={160}
        />
      </div>
      <Panel
        title="反馈问题清单"
        extra={
          <span className="al-caption">
            {stageLabel[stage]} · {result ? fmt(result[stage]) : "—"} 条
          </span>
        }
      >
        <div className="fb-ledger">
          <DataTable
            headers={["反馈内容", "数字员工", "提出时间", "最近处置时间", "处置状态"]}
            empty={q.isError ? "反馈数据读取失败" : q.isLoading ? "正在读取反馈…" : "没有匹配的记录"}
            rows={(result?.rows || []).map((row) => [
              <>
                <button
                  className="al-link"
                  data-detail={"monitor:issue:" + row.run_id}
                  onClick={() => props.open("monitor:issue:" + row.run_id, "反馈问题详情")}
                >
                  {row.comment || "用户提交差评"} ↗
                </button>
                {row.measure && <small className="fb-resolution">处理结果 · {row.measure}</small>}
              </>,
              <button
                className="al-link"
                onClick={() =>
                  props.open(
                    assetTarget("assistant:" + row.asset_id),
                    workerName(props, row.asset_id),
                  )
                }
              >
                {workerName(props, row.asset_id)} ↗
              </button>,
              stamp(row.opened_at),
              stamp(row.resolved_at),
              <span className={"fb-status fb-" + stage}>{stageLabel[stage]}</span>,
            ])}
          />
        </div>
        <Pager total={result?.[stage] || 0} page={page} setPage={setPage} />
      </Panel>
    </>
  );
}
export function FeedbackItem({
  props,
  scope,
  id,
}: {
  props: PrototypeDetailProps;
  scope: MonitorScope;
  id: string;
}) {
  const identity = useMonitorIdentity(),
    cache = useQueryClient();
  const draftKey = ["board-feedback-draft", ...identity, id];
  const [measure, setMeasure] = useState(() => cache.getQueryData<string>(draftKey) || "");
  function updateDraft(value: string) {
    setMeasure(value);
    cache.setQueryData(draftKey, value);
  }
  // Request the issue itself, retaining state as of the selected reporting date.
  const pending = useIssues(props, scope, "pending", 1, 1, "", id),
    closed = useIssues(props, scope, "closed", 1, 1, "", id);
  const save = useMutation({
    mutationFn: () => resolveBoardIssue(id, measure.trim()),
    onSuccess: async () => {
      updateDraft("");
      await cache.invalidateQueries({ queryKey: ["monitor-issues"] });
    },
  });
  const row = pending.data?.rows[0] || closed.data?.rows[0];
  if (!row)
    return (
      <p className="al-empty">
        {pending.isLoading || closed.isLoading
          ? "正在读取反馈…"
          : pending.isError || closed.isError
            ? "反馈数据读取失败"
            : "当前范围内没有该条反馈"}
      </p>
    );
  const name = workerName(props, row.asset_id),
    state = row.resolved_at ? "已处理" : "待处理";
  return (
    <>
      <Panel
        title="反馈内容"
        extra={<span className={"fb-status fb-" + (row.resolved_at ? "closed" : "pending")}>{state}</span>}
      >
        <p className="fb-comment">{row.comment || "用户提交了差评，未记录文字说明。"}</p>
        <DataTable
          headers={["数字员工", "原始执行", "提出时间", "最近处置时间"]}
          rows={[
            [
              <button
                className="al-link"
                onClick={() => props.open(assetTarget("assistant:" + row.asset_id), name)}
              >
                {name} ↗
              </button>,
              <button className="al-link" onClick={() => props.open("monitor:run:" + row.run_id, "执行记录详情")}>
                {row.run_id} ↗
              </button>,
              stamp(row.opened_at),
              stamp(row.resolved_at),
            ],
          ]}
        />
      </Panel>
      <Panel title="处置记录">
        <DataTable
          headers={["时间", "事项", "处置结果"]}
          rows={[
            [stamp(row.opened_at), "提出差评", "—"],
            ...(row.resolved_at ? [[stamp(row.resolved_at), "标记为已处理", row.measure || "—"]] : []),
          ]}
        />
        {!row.resolved_at && props.access.resolve && (
          <div data-feedback-form>
            <label>
              处置结果
              <textarea
                required
                rows={3}
                maxLength={400}
                value={measure}
                onChange={(e) => updateDraft(e.target.value)}
                placeholder="填写核查结果和处理措施"
              />
            </label>
            <button
              className="al-button"
              type="button"
              data-feedback-close
              disabled={!measure.trim() || save.isLoading || save.isSuccess}
              onClick={() => save.mutate()}
            >
              标记为已处理
            </button>
            {save.isError && <p role="alert">保存失败，请重试。</p>}
            {save.isSuccess && <p role="status">已保存。历史月份按当时的截止日展示处置状态。</p>}
          </div>
        )}
      </Panel>
    </>
  );
}
export function FeedbackRun({ props, id }: { props: PrototypeDetailProps; id: string }) {
  const identity = useMonitorIdentity();
  const q = useQuery({
    queryKey: ["company-monitor-run", ...identity, props.period, id],
    queryFn: () => getMonitorRun(props.period, id),
    enabled: props.access.resolve || props.access.manage,
  });
  const row = q.data;
  if (!row) return <p className="al-empty">{q.isLoading ? "正在读取执行…" : "当前范围无可查阅的执行"}</p>;
  const employee = props.data.assets.find((a) => a.id === row.asset_id)?.name || row.asset_id;
  const department = props.data.departments.find((d) => d.id === row.department_id)?.name || "归属待核实";
  const label = row.status === "success" ? "成功" : row.status === "failed" ? "失败" : "已取消";
  return (
    <>
      <section className="wm">
        <header className="wm-head">
          <div>
            <div className="wm-kicker">{employee} / 执行详情</div>
            <h1>单次执行</h1>
            <p>
              {row.id} · 使用部门：{department}
            </p>
          </div>
        </header>
        <article className="wm-panel">
          <div className="wm-panel-title">
            <h2>执行日志</h2>
          </div>
          <ol className="wm-steps">
            <li>
              <div>
                <strong>开始执行</strong>
                <small>{row.started_at ? stamp(row.started_at) : "开始时间未采集"}</small>
              </div>
            </li>
            <li className={row.status === "success" ? "" : "wm-failed"}>
              <div>
                <strong>执行结束</strong>
                <small>{stamp(row.ended_at)}</small>
              </div>
              <span className={"wm-badge " + (row.status === "success" ? "wm-ok" : "wm-bad")}>{label}</span>
            </li>
          </ol>
          <p>主动工时（秒） · {row.active_seconds ?? "未采集"}</p>
        </article>
      </section>
      <div className="fb-evidence">
        <Panel title="原始资料摘录">
          <blockquote className="fb-excerpt">
            {row.source || (row.own ? "未记录可展示的原始资料。" : "原始资料仅执行发起人可查看。")}
          </blockquote>
        </Panel>
        <Panel title="输出摘录">
          <blockquote className="fb-excerpt">
            {row.output || (row.own ? "未记录可展示的输出。" : "执行输出仅执行发起人可查看。")}
          </blockquote>
        </Panel>
      </div>
      {row.issue && (
        <Panel title="关联差评">
          <p className="fb-comment">{row.issue.comment || "用户提交了差评，未记录文字说明。"}</p>
        </Panel>
      )}
    </>
  );
}
