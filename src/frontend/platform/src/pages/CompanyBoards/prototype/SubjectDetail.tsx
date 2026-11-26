import { Fragment, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { userContext } from "@/contexts/userContext";
import {
  getAssetActivity,
  type SubjectRun,
} from "@/controllers/API/companySubjects";
import {
  aggregation,
  fmt,
  kinds,
  kindNames,
  pct,
  useBoardTrends,
} from "./ActivityData";
import { Link, Panel, Table } from "./ActivityWidgets";
import { stamp } from "./MonitorParts";
import type { PrototypeDetailProps } from "./types";

const windows = [
  ["month", "所选月份"],
  ["year", "年度累计"],
  ["90", "近 90 天"],
];
const results: Record<string, string> = {
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
};
const dateTime = (s: string | null) =>
  s ? stamp(s.endsWith("Z") || s.includes("+") ? s : s + "Z") : "—";
type Series = {
  date: string;
  success: number;
  failed: number;
  entered: number;
}[];
function Trend({
  series,
  known,
  worker = false,
  skill = false,
}: {
  series: Series;
  known: boolean;
  worker?: boolean;
  skill?: boolean;
}) {
  if (!known)
    return (
      <div className={worker ? "wm-empty" : "al-empty"}>
        暂无可核对的运行数据
      </div>
    );
  const max = Math.max(
    1,
    ...series.map((d) => d.success + d.failed + d.entered),
  );
  return (
    <div
      className={worker ? "wm-chart" : "va-chart"}
      role="img"
      aria-label="分期运行趋势"
    >
      {series.map((d, i) => {
        const good = skill ? d.entered : d.success,
          all = good + d.failed,
          label =
            i % Math.ceil(series.length / 12) === 0 ? d.date.slice(5) : "";
        return worker ? (
          <div
            key={d.date}
            className="wm-bar"
            title={d.date + " 成功 " + good + "，失败 " + d.failed}
          >
            <span className="wm-val">{all || ""}</span>
            <span className="wm-column">
              <i
                className="wm-stack"
                style={{ height: (all / max) * 100 + "%" }}
              >
                <i className="wm-bar-fail" style={{ flex: d.failed }} />
                <i className="wm-bar-ok" style={{ flex: good }} />
              </i>
            </span>
            <small>{label}</small>
          </div>
        ) : (
          <div
            key={d.date}
            className="va-bin"
            title={d.date + " 有效 " + good + "，失败 " + d.failed}
          >
            <div>
              <b>{all || ""}</b>
              <i
                style={{
                  height: (77 * all) / max + "%",
                  background: all
                    ? "linear-gradient(to top,#439d8e " +
                      (100 * good) / all +
                      "%,#d9896e 0%)"
                    : undefined,
                }}
              />
            </div>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
function Definitions({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="va-details">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <article className="va-card">
      <div className="va-title">
        <h2>{title}</h2>
        <span>{hint}</span>
      </div>
      {children}
    </article>
  );
}
function Asset(
  props: PrototypeDetailProps & { id: string; params: URLSearchParams },
) {
  const { data, id, params, open } = props,
    asset = data.assets.find((a) => a.id === id);
  const [span, setSpan] = useState(
    windows.some(([k]) => k === params.get("window"))
      ? params.get("window")!
      : "month",
  );
  const [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const dep = params.get("department") || "",
    requestedMonth = Number(params.get("month"));
  const month =
    span === "month" &&
    requestedMonth >= 1 &&
    requestedMonth <= (data.month || 12)
      ? requestedMonth
      : data.month || 12;
  const depName = (key: string | number | null) =>
    data.departments.find((d) => String(d.id) === String(key))?.name ||
    "部门待归属";
  const { user } = useContext(userContext);
  const query = useQuery({
    queryKey: [
      "company-boards",
      "asset",
      user?.tenant_id,
      user?.user_id,
      props.board,
      id,
      props.period,
      month,
      span,
      dep,
      status,
      search,
      page,
    ],
    queryFn: () =>
      getAssetActivity(
        props.board,
        id,
        data.year,
        month,
        span,
        dep,
        status,
        search,
        page,
      ),
    enabled: !!asset,
  });
  const trends = useBoardTrends(data, props.board);
  if (!asset) return <p className="al-empty">当前资产目录中未找到此资产。</p>;
  const period =
    span === "month"
      ? trends.data?.months[month - 1]
      : span === "year"
        ? trends.data?.year
        : trends.data?.last90;
  const m = aggregation(period, id, dep || "all"),
    snap = query.data;
  if (query.isError)
    return (
      <p className="al-empty">
        <button className="al-link" onClick={() => void query.refetch()}>
          运行明细读取失败 · 重试
        </button>
      </p>
    );
  const dates = snap?.series ?? [],
    known = !!snap?.known,
    skill = asset.kind === "skill",
    worker = asset.kind === "employee",
    kb = asset.kind === "knowledge";
  const success = dates.reduce(
      (n, d) => n + (skill ? d.entered : d.success),
      0,
    ),
    failed = dates.reduce((n, d) => n + d.failed, 0),
    total = success + failed;
  const health = !known
    ? "未监测"
    : !total
      ? "暂无执行"
      : worker
        ? success / total >= 0.98
          ? "正常"
          : success / total >= 0.95
            ? "关注"
            : "异常"
        : failed / total > 0.05
          ? "异常"
          : "正常";
  const range =
    (span === "month"
      ? data.year + " 年 " + month + " 月"
      : windows.find(([k]) => k === span)?.[1]) +
    " · " +
    (dep ? depName(dep) : "全部使用部门");
  const cutoff =
    month === data.month
      ? data.cutoff
      : new Date(Date.UTC(data.year, month, 0)).toISOString().slice(0, 10);
  const days = dates.length
    ? Math.max(
        1,
        (Date.parse(cutoff) - Date.parse(dates[0].date)) / 86400000 + 1,
      )
    : 0;
  const profile = props.registers
    .filter((r) => r.kind === "asset-profile" && r.parent_id === id)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const owner = asset.department_id;
  const controls = (
    <div className="al-toolbar">
      <label className="al-revision-select">
        统计时期{" "}
        <select
          className="al-select"
          value={span}
          onChange={(e) => {
            setSpan(e.target.value);
            setPage(1);
          }}
        >
          {windows.map(([k, n]) => (
            <option key={k} value={k}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="al-caption">
        {kindNames[asset.kind]} · {range}
      </span>
      {owner != null && (
        <Link
          to={"department:" + owner + "?view=published"}
          open={open}
          title={depName(owner)}
        />
      )}
      {dep && (
        <Link
          to={"department:" + dep + "?view=usage&window=" + span}
          open={open}
          title={depName(dep) + " · 资产使用"}
        />
      )}
    </div>
  );
  const linkRun = (r: SubjectRun) => (
    <Link to={"monitor:run:" + r.id} open={open} title="单次执行">
      {r.id}
    </Link>
  );
  const wmKpi = (name: string, value: string, hint: string) => (
    <div className="wm-kpi">
      <span>{name}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
  const pages = Math.max(1, Math.ceil((snap?.total || 0) / 8));
  const scenes = new Set(
    data.ledger
      .filter(
        (r) =>
          r.kind === "release" &&
          r.asset_key === id &&
          r.effective_date &&
          r.effective_date <= data.cutoff,
      )
      .map((r) => r.parent_id),
  );
  props.registers
    .filter(
      (r) =>
        r.kind === "scene-asset" &&
        r.fields.asset === id &&
        r.date <= data.cutoff &&
        (!r.fields.end || r.fields.end >= data.cutoff),
    )
    .forEach((r) => scenes.add(r.parent_id));
  const related = data.ledger.filter(
    (r) => r.kind === "scene" && scenes.has(r.id),
  );
  const directTopic = data.ledger.find(r => r.kind === "topic" && r.id === asset?.topic_id);
  const attachments = (related.length > 0 || directTopic) && (
    <Card title="关联专题与场景">
      <Table
        heads={["建设专题", "应用场景"]}
        rows={[...(directTopic && !related.some(scene => scene.parent_id === directTopic.id)
          ? [[<Link to={(props.board === "monitor" ? "topic-operations:" : "strategy:topic:") + directTopic.id}
              title={directTopic.name} open={open} />, "—"]]
          : []), ...related.map((s) => {
          const topic = data.ledger.find((r) => r.id === s.parent_id);
          return [
            topic && (
              <Link
                to={(props.board==="monitor"?"topic-operations:":"strategy:topic:")+topic.id}
                title={topic.name}
                open={open}
              />
            ),
            <Link to={(props.board==="monitor"?"monitor:scene:":"strategy:scene:")+s.id} title={s.name} open={open} />,
          ];
        })]}
      />
    </Card>
  );
  if (worker)
    return (
      <>
        {controls}
        <section className="wm" data-wm-main>
          <div className="wm-head">
            <h2>数字员工运行监控</h2>
            <span className="wm-badge">{health}</span>
          </div>
          <div className="wm-summary">
            {wmKpi(
              "执行总数",
              fmt(known ? total : null),
              "本期已结束执行（次）",
            )}
            {wmKpi(
              "作业工时",
              fmt(m.hours),
              "成功及失败任务的主动工时（小时）",
            )}
            {wmKpi("好评率", pct(m.rating), "已关联评价的执行")}
            {wmKpi(
              "执行成功率",
              pct(total ? success / total : null),
              "成功 " +
                fmt(known ? success : null) +
                " / 失败 " +
                fmt(known ? failed : null),
            )}
          </div>
          <div className="wm-grid">
            <article className="wm-panel">
              <div className="wm-panel-title">
                <h2>执行趋势</h2>
                <span className="wm-legend">
                  <i />
                  成功 <i />
                  失败
                </span>
              </div>
              <Trend series={dates} known={known} worker />
            </article>
            <article className="wm-panel wm-latest">
              <div className="wm-panel-title">
                <h2>最近一次执行</h2>
              </div>
              {snap?.latest ? (
                <Definitions
                  rows={[
                    ["执行编号", linkRun(snap.latest)],
                    ["开始时间", dateTime(snap.latest.start)],
                    ["结束时间", dateTime(snap.latest.end)],
                    ["处理结果", results[snap.latest.status]],
                  ]}
                />
              ) : (
                <div className="wm-empty">
                  {!data.runtime.detail_access
                    ? "当前账号可查看汇总"
                    : "暂无可查阅执行"}
                </div>
              )}
            </article>
          </div>
          <article className="wm-panel wm-log">
            <div className="wm-panel-title">
              <h2>执行记录</h2>
              <div className="wm-tools">
                <label>
                  结果{" "}
                  <select
                    data-wm-filter
                    value={status}
                    onChange={(e) => {
                      setPage(1);
                      setStatus(e.target.value);
                    }}
                  >
                    <option value="">全部</option>
                    {Object.entries(results).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  data-wm-search
                  aria-label="搜索执行编号或时间"
                  placeholder="搜索编号或时间"
                  value={search}
                  onChange={(e) => {
                    setPage(1);
                    setSearch(e.target.value);
                  }}
                />
              </div>
            </div>
            <Table
              heads={["执行编号", "开始时间", "结束时间", "结果"]}
              rows={(snap?.rows || []).map((r) => [
                linkRun(r),
                dateTime(r.start),
                dateTime(r.end),
                results[r.status],
              ])}
            />
            {snap?.total != null && (
              <div className="wm-pager">
                <span>共 {snap.total} 条</span>
                <span>
                  <button
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </button>{" "}
                  {page} / {pages}{" "}
                  <button
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </button>
                </span>
              </div>
            )}
          </article>
        </section>
        {attachments}
      </>
    );
  const verb = skill ? "使用" : kb ? "检索" : "调用";
  const kpi = (name: string, value: string, unit = "") => (
    <div className="va-kpi">
      <span>{name}</span>
      <b>
        {value}
        <small>{unit}</small>
      </b>
    </div>
  );
  const rank =
    known && success > 0
      ? 1 +
        data.assets.filter(
          (a) =>
            a.kind === "knowledge" &&
            (aggregation(period, a.id, dep || "all").uses("knowledge") ?? 0) >
              success,
        ).length
      : null;
  return (
    <>
      {controls}
      <section className="va" data-va-single>
        <div className="va-kpis">
          {kpi(
            skill ? "使用次数" : "有效" + verb,
            fmt(known ? success : null),
            "次",
          )}
          {kpi(
            "日均" + (skill ? "" : "有效") + verb,
            fmt(known && days ? success / days : null),
            "次 / 日",
          )}
          {skill
            ? kpi("最近使用日期", dateTime(snap?.last ?? null).split(" ")[0])
            : kb
              ? kpi("知识库热度名次", fmt(rank))
              : kpi("失败调用", fmt(known ? failed : null), "次")}
          {!skill && kpi(verb + "成功率", pct(total ? success / total : null))}
        </div>
        <div className={skill ? "" : "va-columns"}>
          <Card title={verb + "趋势"} hint={range}>
            <Trend series={dates} known={known} skill={skill} />
          </Card>
          {!skill && (
            <Card title={kb ? "知识库运行" : "工具运行"}>
              <Definitions
                rows={[
                  ["运行状态", health],
                  ["统计范围", range],
                  [
                    "成功 / 失败",
                    known ? success + " / " + failed + " 次" : "—",
                  ],
                  ["最近" + verb + "日期", dateTime(snap?.last ?? null)],
                ]}
              />
            </Card>
          )}
        </div>
        {(kb || skill || profile || asset.description) && (
          <Card title={skill ? "Skill 内容" : "业务说明"}>
            <Definitions
              rows={[
                kb ? ["业务分类", asset.knowledge_category_name || "未归类"] : ["业务方向", profile?.fields.direction || "尚未登记"],
                ["说明", profile?.fields.description || asset.description || "—"],
                ...(skill
                  ? [
                      ["规则", profile?.fields.rules || "尚未登记"] as [
                        string,
                        string,
                      ],
                    ]
                  : []),
              ]}
            />
          </Card>
        )}
        {skill && (
          <Card title="使用明细" hint={range}>
            <Table
              heads={["日期", "使用次数"]}
              rows={known ? dates.map((d) => [d.date, fmt(d.entered)]) : []}
            />
          </Card>
        )}
        {attachments}
      </section>
    </>
  );
}
function Department(
  props: PrototypeDetailProps & { id: string; params: URLSearchParams },
) {
  const { data, id, params, open } = props;
  const [tab, setTab] = useState(params.get("view") || "usage"),
    [kind, setKind] = useState("all"),
    [search, setSearch] = useState("");
  const [span, setSpan] = useState(params.get("window") || "month");
  const trends = useBoardTrends(data, props.board),
    usage = tab === "usage",
    month = data.month || 12;
  const point =
    span === "year"
      ? trends.data?.year
      : span === "90"
        ? trends.data?.last90
        : trends.data?.months[month - 1];
  const owner = (n: number | null) =>
    n == null
      ? "部门待归属"
      : data.departments.find((d) => d.id === n)?.name || "部门待归属";
  const items = data.assets
    .filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        a.name.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .map((a) => {
      const facts = aggregation(point, a.id, id),
        used = facts.uses(a.kind),
        failures = facts.rows
          .filter((r) => r.kind === a.kind)
          .reduce((n, r) => n + r.failed, 0);
      return { a, used, failures };
    })
    .filter(({ a, used, failures }) =>
      usage
        ? !!used || failures > 0
        : String(a.department_id ?? "unassigned") === id &&
          (tab === "new"
            ? a.published_at?.slice(0, 7) === props.period
            : tab === "year"
              ? a.published_at?.slice(0, 4) === String(data.year)
              : true),
    )
    .sort(
      (a, b) =>
        (b.used || 0) - (a.used || 0) ||
        a.a.name.localeCompare(b.a.name, "zh-CN"),
    );
  return (
    <>
      <div className="al-toolbar">
        {[
          ["new", "本月新增"],
          ["published", "累计发布"],
          ["year", "年度沉淀"],
          ["usage", "资产使用"],
        ].map(([k, n]) => (
          <button
            key={k}
            className="al-button"
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
          >
            {n}
          </button>
        ))}
        {usage && (
          <select
            className="al-select"
            aria-label="统计时期"
            value={span}
            onChange={(e) => setSpan(e.target.value)}
          >
            {windows.map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        )}
      </div>
      <Panel
        title={
          (usage
            ? "使用资产"
            : tab === "new"
              ? "本月首次发布"
              : tab === "year"
                ? "年度首次发布"
                : "累计已发布") +
          " · " +
          items.length +
          " 项"
        }
      >
        <div className="al-toolbar">
          <div className="al-filter">
            {["all", ...kinds].map((k) => (
              <button
                key={k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "all" ? "全部" : kindNames[k as keyof typeof kindNames]}
              </button>
            ))}
          </div>
          <input
            className="al-search"
            placeholder="搜索资产名称"
            aria-label="搜索资产名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Table
          heads={
            usage
              ? [
                  "资产名称",
                  "类型",
                  "发布部门",
                  "使用次数",
                  ...(kind === "skill" ? [] : ["失败（次）"]),
                ]
              : ["资产名称", "类型", "首次发布部门", "首次发布日期"]
          }
          rows={items.map(({ a, used, failures }) => [
            <Link
              to={
                "asset:" +
                a.id +
                (usage ? "?department=" + id + "&window=" + span : "")
              }
              title={a.name}
              open={open}
            />,
            kindNames[a.kind],
            a.department_id == null ? (
              owner(null)
            ) : (
              <Link
                to={"department:" + a.department_id + "?view=published"}
                open={open}
                title={owner(a.department_id)}
              />
            ),
            ...(usage
              ? [
                  fmt(used),
                  ...(kind === "skill"
                    ? []
                    : [a.kind === "skill" ? "—" : fmt(failures)]),
                ]
              : [a.published_at || "—"]),
          ])}
        />
      </Panel>
      <p className="al-info">
        {usage
          ? "按执行或调用发生时的使用部门归集。"
          : "按资产首次正式发布时的部门归集。"}
      </p>
    </>
  );
}
export function SubjectDetail(props: PrototypeDetailProps) {
  const [target, query] = props.target.split("?"),
    split = target.indexOf(":"),
    id = target.slice(split + 1),
    params = new URLSearchParams(query);
  return target.startsWith("asset:") ? (
    <Asset {...props} id={id} params={params} />
  ) : (
    <Department {...props} id={id} params={params} />
  );
}
