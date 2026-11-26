import { useState } from "react";
import Directory from "./ActivityDirectory";
import type { AssetKind, BoardOverview } from "@/controllers/API/companyBoards";
import type { TrendPeriod } from "@/controllers/API/activityTrends";
import {
  aggregation,
  fmt,
  kinds,
  kindColors,
  kindNames,
  monthlyReleases,
  sceneAssets,
  pct,
  useBoardTrends,
} from "./ActivityData";
import { Chart, Link, Metric, Panel, Table, TrendNotice, useText } from "./ActivityWidgets";
import type { PrototypeDetailProps, PrototypeViewProps } from "./types";

export function Options({
  label,
  options,
  value,
  set,
}: {
  label: string;
  options: string[][];
  value: string;
  set: (value: string) => void;
}) {
  return (
    <label className="al-revision-select">
      {label}
      <select className="al-select" value={value} onChange={(e) => set(e.target.value)}>
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Tabs({
  label,
  options,
  value,
  set,
  attribute,
}: {
  label: string;
  options: string[][];
  value: string;
  set: (v: string) => void;
  attribute: string;
}) {
  return (
    <div className="al-tabs" role="group" aria-label={label}>
      {options.map(([key, name]) => (
        <button
          className="al-tab"
          type="button"
          {...{ [attribute]: key }}
          key={key}
          aria-pressed={key === value}
          onClick={() => set(key)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
function released(data: BoardOverview) {
  const keys = new Set(
    monthlyReleases(data)
      .filter((r) => r.asset_key)
      .map((r) => r.asset_key!),
  );
  return data.assets.filter((a) =>
    a.published_at
      ? a.published_at.slice(0, 7) === data.cutoff.slice(0, 7) && a.published_at <= data.cutoff
      : keys.has(a.id),
  );
}
function source(data: BoardOverview) {
  return data.cutoff.slice(0, 7) === data.catalog_as_of.slice(0, 7) ? data.assets : null;
}
function departmentCounts(data: BoardOverview, point?: TrendPeriod) {
  const fresh = released(data);
  return data.departments.map((d) => {
    const newly = kinds.map((k) => fresh.filter((a) => a.kind === k && a.department_id === d.id).length);
    const m = aggregation(point, undefined, String(d.id));
    return { ...d, newly, uses: kinds.map((k) => m.uses(k)), tokens: m.tokens };
  });
}
function HealthHelp() {
  const t = useText();
  return (
    <details className="wr-help">
      <summary title={t("健康程度口径")} aria-label={t("查看健康程度口径")}>
        ?
      </summary>
      <div>
        {t("按所选月份的执行成功率分级。")}
        <br />
        {t("绿 · 正常 ≥ 98%")}
        <br />
        {t("黄 · 关注 95% 至不足 98%")}
        <br />
        {t("红 · 异常低于 95%")}
        <br />
        {t("灰 · 暂无执行或未接入监测")}
      </div>
    </details>
  );
}
function WorkerTable({
  view,
  point,
  full = false,
}: {
  view: PrototypeViewProps;
  point?: TrendPeriod;
  full?: boolean;
}) {
  const t = useText();
  const { data, open, period, changePeriod } = view;
  const [sort, setSort] = useState("uses"),
    [dir, setDir] = useState(-1),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const departments = new Map(data.departments.map((d) => [d.id, d.name]));
  const entries = data.assets
    .filter((a) => a.kind === "employee")
    .map((a) => {
      const m = aggregation(point, a.id);
      const attempts = (m.success || 0) + (m.failed || 0);
      const rate = attempts ? (m.success || 0) / attempts : null;
      return { a, m, uses: m.uses("employee"), rate, dept: departments.get(a.department_id) || "—" };
    });
  const value = (r: (typeof entries)[number]) =>
    sort === "uses" ? r.uses : sort === "approvalRate" ? r.m.rating : r.rate;
  const compare = (a: (typeof entries)[number], b: (typeof entries)[number]) => {
    const v = value(a),
      w = value(b);
    return v === null ? (w === null ? 0 : 1) : w === null ? -1 : (v - w) * dir;
  };
  entries.sort((a, b) => compare(a, b) || (b.uses ?? -1) - (a.uses ?? -1) || a.a.id.localeCompare(b.a.id));
  let rank = 0;
  const matches = entries
    .map((r, i) => {
      if (!i || compare(r, entries[i - 1])) rank = i + 1;
      return { ...r, rank };
    })
    .filter((r) => (r.a.name + " " + r.dept).toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(matches.length / 12)),
    p = Math.min(page, pages);
  const list = full ? matches.slice((p - 1) * 12, p * 12) : matches;
  const result = (
    <div
      className={"wr-table-scroll " + (full ? "wr-full" : "wr-mini")}
      tabIndex={0}
      aria-label={t("数字员工排行")}
    >
      <table className="wr-table">
        <thead>
          <tr>
            <th className="wr-rankno">{t("排名")}</th>
            <th className="wr-name">{t("数字员工")}</th>
            {full && <th className="wr-dept">{t("归属部门")}</th>}
            {[
              ["uses", "使用次数"],
              ["approvalRate", "好评率"],
              ["health", "健康程度"],
            ].map(([k, label]) => (
              <th
                scope="col"
                className={"wr-sortcol wr-" + k}
                aria-sort={sort === k ? (dir > 0 ? "ascending" : "descending") : "none"}
                key={k}
              >
                <button
                  className="wr-sort"
                  data-worker-sort={k}
                  onClick={() => {
                    setDir(sort === k ? -dir : -1);
                    setSort(k);
                    setPage(1);
                  }}
                >
                  {t(label)}
                  <span aria-hidden>{sort === k ? (dir > 0 ? "↑" : "↓") : "↕"}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.a.id}>
              <td className="wr-num">{r.rank}</td>
              <td className="wr-name">
                <Link to={"asset:" + r.a.id} open={open} title={r.a.name} />
              </td>
              {full && <td className="wr-dept">{r.dept}</td>}
              <td className="wr-num">{fmt(r.uses)}</td>
              <td className="wr-num">{pct(r.m.rating)}</td>
              <td className="wr-health">
                <span
                  className={
                    "wr-status wr-" + ({ 正常: "ok", 关注: "watch", 异常: "error" }[r.m.health] || "idle")
                  }
                  title={pct(r.rate)}
                >
                  <i />
                  {t(r.m.health)}
                </span>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td className="al-empty" colSpan={full ? 6 : 5}>
                {t("没有匹配的数字员工")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
  const legend = (
    <span className="wr-legend">
      <small>
        {matches.length} {t("名")}
      </small>
      <HealthHelp />
      {!full && <Link open={open} to="worker-ranking" title={t("展开详榜")} />}
    </span>
  );
  return (
    <>
      {full && (
        <div className="al-toolbar wr-filters">
          <input
            type="month"
            className="al-select"
            aria-label={t("统计月份")}
            value={period}
            onChange={(e) => e.target.value && changePeriod(e.target.value)}
          />
          <div className="wr-query">
            <input
              className="al-search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              aria-label={t("搜索数字员工或部门")}
              placeholder={t("搜索数字员工或部门")}
            />
          </div>
        </div>
      )}
      <Panel title={t(full ? "数字员工排行" : "数字员工使用详榜")} action={legend}>
        {result}
        {full && (
          <div className="al-paging">
            <span>
              {t("共")} {matches.length} {t("条")}
            </span>
            <div>
              <button className="al-button" disabled={p === 1} onClick={() => setPage(p - 1)}>
                {t("上一页")}
              </button>
              <span>
                {p} / {pages}
              </span>
              <button className="al-button" disabled={p === pages} onClick={() => setPage(p + 1)}>
                {t("下一页")}
              </button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
export default function Activity(props: PrototypeViewProps) {
  const { data, period, open } = props;
  const t = useText(),
    request = useBoardTrends(data, props.board),
    series = request.data,
    month = data.month || 12,
    point = series?.months[month - 1];
  const [metric, setMetric] = useState("usage"),
    [kind, setKind] = useState("all"),
    [mode, setMode] = useState("assets");
  const tokens = metric === "tokens",
    group = aggregation(point),
    catalog = source(data),
    newly = released(data);
  const annualTokens = aggregation(series?.year).tokens;
  const counts = kinds.map((k) => (catalog ? catalog.filter((a) => a.kind === k).length : null)),
    maxCount = Math.max(1, ...counts.map((n) => n || 0));
  const rows = departmentCounts(data, point)
    .map((d) => {
      const values =
        mode === "assets" ? d.newly : mode === "usage" ? d.uses : [d.tokens === null ? null : d.tokens / 1e6];
      return {
        ...d,
        values,
        total: values.some((n) => n !== null) ? values.reduce<number>((s, n) => s + (n || 0), 0) : null,
      };
    })
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const max = Math.max(1, ...rows.map((r) => r.total || 0));
  const months = Array.from({ length: month }, (_, i) => aggregation(series?.months[i]));
  const link = (id: string, name: string) => <Link open={open} to={id} title={t(name)} />;
  return (
    <section className="al-view al-applications" id="al-adoption" aria-label={t("应用活力")}>
      {request.isError && <TrendNotice retry={request.refetch} />}
      <div className="al-stats al-app-stats al-adoption-metrics">
        <Metric
          name={t("AI 资产总数")}
          value={fmt(catalog?.length)}
          unit={t("项")}
          note={catalog ? t("截至") + " " + data.cutoff : t("历史发布目录缺采")}
          to="activity-catalog"
          detailTitle={t("资产台账 · 发布目录")}
          open={open}
        />
        <Metric
          name={t("月度新增资产")}
          value={fmt(newly.length)}
          unit={t("项")}
          note={t("本月首次正式发布 · 已登记")}
          to="activity-new"
          detailTitle={t("资产台账 · 月度新增")}
          open={open}
        />
        <Metric
          name={t("本月资产使用次数")}
          value={fmt(group.uses())}
          unit={t("次")}
          note={t("截至") + " " + data.cutoff + " · " + t("四类合计")}
          to="asset-usage"
          detailTitle={t("资产台账 · 使用明细")}
          open={open}
        />
        <Metric
          name={t("本月 Token 消耗")}
          value={fmt(group.tokens === null ? null : group.tokens / (group.tokens >= 1e8 ? 1e8 : 1e6))}
          unit={t(group.tokens >= 1e8 ? "亿 Token" : "百万 Token")}
          note={t("年度") + " " + fmt(annualTokens === null ? null : annualTokens / 1e8) + " " + t("亿 Token")}
          to="tokens"
          detailTitle={t("Token 消耗")}
          open={open}
        />
      </div>
      <div className="al-adoption-layout al-adoption-revised">
        <Panel title={t("AI 资产使用趋势")} action={link(tokens ? "tokens" : "usage-data:" + kind, "数据明细")}>
          <div className="al-adoption-chart-controls">
            <Tabs
              label={t("使用趋势指标")}
              options={[
                ["usage", t("资产使用次数")],
                ["tokens", t("Token 消耗")],
              ]}
              value={metric}
              set={setMetric}
              attribute="data-chart"
            />
            {!tokens && (
              <Options
                label={t("资产类型")}
                options={[["all", t("全部类型")], ...kinds.map((k) => [k, t(kindNames[k])])]}
                value={kind}
                set={setKind}
              />
            )}
          </div>
          {!tokens && <p className="al-caption">{t("发布目录 · 已观测 Web 运行与逐月调用记录")}</p>}
          <Chart
            selected={month}
            period={period}
            cutoff={data.cutoff}
            unit={t(tokens ? "百万 Token" : "次")}
            name={t(tokens ? "月度 Token 消耗" : "月度资产使用次数")}
            values={months.map((m) =>
              tokens
                ? m.tokens === null
                  ? null
                  : m.tokens / 1e6
                : m.uses(kind === "all" ? undefined : (kind as AssetKind)),
            )}
          />
        </Panel>
        <Panel
          title={t("部门贡献与使用")}
          action={
            <span>
              {link("departments", "部门明细")}　{link("strategy:department-ranking", "年度沉淀排行")}
            </span>
          }
        >
          <Tabs
            label={t("部门统计维度")}
            options={[
              ["assets", t("本月新增")],
              ["usage", t("资产使用")],
              ["tokens", t("Token 消耗")],
            ]}
            value={mode}
            set={setMode}
            attribute="data-dept-chart"
          />
          <div className="al-chart-legend">
            <span className="v4-scope-note">{t(mode === "assets" ? "本月首次正式发布" : "按使用部门")}</span>
            {mode === "tokens" ? (
              <span>{t("百万 Token")}</span>
            ) : (
              kinds.map((k) => (
                <span key={k}>
                  <i className="al-dot" style={{ background: kindColors[k] }} />
                  {t(kindNames[k])}
                </span>
              ))
            )}
          </div>
          <div
            className="al-department-rows"
            style={{ overflowY: "auto", maxHeight: "13rem", alignContent: "start" }}
          >
            {rows.map((r) => (
              <button
                key={r.id}
                className="al-department-row"
                onClick={() => open((mode === "assets" ? "activity-new:" : "department:") + r.id, r.name)}
              >
                <span title={r.name}>{r.name}</span>
                <span className="al-bar-track">
                  {r.values.map((n, i) =>
                    n === null ? null : (
                      <span key={i} style={{ width: (n / max) * 100 + "%", background: kindColors[kinds[i]] }} />
                    ),
                  )}
                </span>
                <strong>{fmt(r.total)}</strong>
              </button>
            ))}
          </div>
        </Panel>
        <Panel
          title={t("AI 资产构成")}
          action={
            <span>
              {link("app-ranking", "分类使用明细")}　{link("activity-catalog", "资产明细")}
            </span>
          }
        >
          <div className="al-bars-list">
            {kinds.map((k, i) => (
              <button key={k} type="button" onClick={() => open("activity-catalog:" + k, t(kindNames[k]))}>
                <span>
                  <i className="al-dot" style={{ background: kindColors[k] }} />
                  {t(kindNames[k])}
                </span>
                <span className="al-bar-track">
                  <span style={{ width: ((counts[i] || 0) / maxCount) * 100 + "%", background: kindColors[k] }} />
                </span>
                <strong>{fmt(counts[i])}</strong>
              </button>
            ))}
          </div>
        </Panel>
        <WorkerTable view={props} point={point} />
      </div>
    </section>
  );
}

export function ActivityDetail(props: PrototypeDetailProps) {
  const [route, scope] = props.target.split(":");
  if (
    ![
      "asset-usage",
      "usage-data",
      "tokens",
      "departments",
      "usage-ledger",
      "app-ranking",
      "worker-ranking",
      "activity-catalog",
      "activity-new",
    ].includes(route)
  )
    return null;
  return <Detail key={props.target} {...props} route={route} scope={scope} />;
}
function Detail(props: PrototypeDetailProps & { route: string; scope: string }) {
  const { data, open, route, scope } = props,
    t = useText(),
    request = useBoardTrends(data, props.board),
    series = request.data,
    month = data.month || 12;
  const [kind, setKind] = useState(scope || (route === "app-ranking" ? "employee" : "all")),
    [dept, setDept] = useState("all"),
    [when, setWhen] = useState("month"),
    [topic, setTopic] = useState("all");
  const point = when === "90" ? series?.last90 : series?.months[(Number(when) || month) - 1];
  const depOptions = [
    ["all", t("全公司")],
    ...data.departments.map((d) => [String(d.id), d.name]),
    ["unassigned", t("未归属部门")],
  ];
  const topics = data.ledger.filter((r) => r.kind === "topic"),
    sceneOwners = new Map(data.ledger.filter((r) => r.kind === "scene").map((r) => [r.id, r.parent_id]));
  const releaseOwners = new Map<string, Set<string>>();
  for (const [scene, topicId] of sceneOwners) {
    if (!topicId) continue;
    for (const asset of sceneAssets(props, new Set([scene]))) {
      const mapped = releaseOwners.get(asset) || new Set<string>();
      mapped.add(topicId);
      releaseOwners.set(asset, mapped);
    }
  }
  const directory = route === "activity-catalog" || route === "activity-new";
  const link = (id: string, name: string) => {
    const params = new URLSearchParams();
    if (id.startsWith("asset:") && !directory) {
      if (dept !== "all") params.set("department", dept);
      params.set("window", Number(when) ? "month" : when);
      if (Number(when)) params.set("month", when);
    }
    return <Link open={open} to={id + (params.size ? "?" + params.toString() : "")} title={name} />;
  };
  const nav = (
    <div className="al-tabs al-register-views" role="group" aria-label={t("资产台账视图")}>
      {[
        ["activity-catalog", "发布目录"],
        ["activity-new", "月度新增"],
        ["usage-ledger", "使用明细"],
        ["app-ranking", "分类使用榜"],
      ].map(([k, name]) => (
        <button
          key={k}
          className="al-tab"
          aria-pressed={k === route || (k === "usage-ledger" && route === "asset-usage")}
          onClick={() => open(k, t(name))}
        >
          {t(name)}
        </button>
      ))}
    </div>
  );
  const filterKind = (
    <Options
      label={t("资产类型")}
      value={kind}
      set={setKind}
      options={[
        ...(route === "app-ranking" ? [] : [["all", t("全部类型")]]),
        ...kinds.map((k) => [k, t(kindNames[k])]),
      ]}
    />
  );
  const filterDept = <Options label={t("使用部门")} value={dept} set={setDept} options={depOptions} />;
  if (request.isError) return <TrendNotice retry={request.refetch} />;
  if (route === "worker-ranking") return <WorkerTable view={props} point={point} full />;
  if (route === "usage-data" || route === "tokens") {
    const tokens = route === "tokens";
    return (
      <Panel title={t("月度数据")}>
        <Table
          heads={(tokens
            ? ["月份", "Token 消耗（百万）"]
            : ["月份", "资产使用次数", "AI 交互轮次数（全公司）"]
          ).map(t)}
          rows={Array.from({ length: month }, (_, i) => {
            const m = aggregation(series?.months[i]);
            return [
              i + 1 + " " + t("月"),
              ...(tokens
                ? [fmt(m.tokens === null ? null : m.tokens / 1e6)]
                : [
                    fmt(m.uses(scope && kinds.includes(scope as AssetKind) ? (scope as AssetKind) : undefined)),
                    fmt(m.rounds),
                  ]),
            ];
          })}
        />
        <p className="al-caption">
          {t(
            tokens
              ? "仅计入带有真实用量回执的 Web 模型请求。"
              : "交互轮次覆盖正式 Web 助手已结束且具备最终回复的根请求。",
          )}
        </p>
      </Panel>
    );
  }
  if (route === "departments")
    return (
      <Panel title={t("部门明细")}>
        <Table
          heads={[
            "部门",
            "本月新增资产",
            "员工执行",
            "知识库检索",
            "Skill 使用",
            "工具调用",
            "使用次数",
            "Token（百万）",
          ].map(t)}
          rows={departmentCounts(data, point).map((r) => [
            link("department:" + r.id, r.name),
            link("activity-new:" + r.id, fmt(r.newly.reduce((a, b) => a + b, 0))),
            ...r.uses.map((n) => fmt(n)),
            fmt(aggregation(point, undefined, String(r.id)).uses()),
            fmt(r.tokens === null ? null : r.tokens / 1e6),
          ])}
        />
      </Panel>
    );

  if (directory)
    return (
      <Directory
        props={props}
        point={point}
        fresh={released(data)}
        published={source(data) || data.assets.filter((a) => a.published_at && a.published_at <= data.cutoff)}
        nav={nav}
      />
    );
  const assets = data.assets;
  const group = aggregation(point, undefined, dept);
  const rows = assets
    .filter((a) => (kind === "all" || a.kind === kind) && (topic === "all" || releaseOwners.get(a.id)?.has(topic)))
    .map((a) => {
      const m = aggregation(point, a.id, dept);
      return {
        a,
        m,
        uses: m.uses(a.kind),
        topics:
          topics
            .filter((r) => releaseOwners.get(a.id)?.has(r.id))
            .map((s) => s.name)
            .join("、") || "—",
      };
    })
    .sort((a, b) => (b.uses ?? -1) - (a.uses ?? -1) || a.a.name.localeCompare(b.a.name, "zh-CN"));
  if (route === "app-ranking") {
    let rank = 0;
    const measured = rows.filter((r) => r.uses !== null && r.uses > 0);
    return (
      <>
        {nav}
        <Panel title={t("完整排行")}>
          <div className="al-toolbar al-operations-filters">
            {filterKind}
            <Options
              label={t("周期")}
              value={when}
              set={setWhen}
              options={[
                ["month", t("当前月份")],
                ["90", t("近 90 天")],
                ...Array.from({ length: month }, (_, i) => [String(i + 1), i + 1 + " " + t("月")]),
              ]}
            />
            {filterDept}
            <Options
              label={t("所属专题")}
              value={topic}
              set={setTopic}
              options={[["all", t("全部专题")], ...topics.map((r) => [r.id, r.name])]}
            />
            {link("worker-ranking", t("数字员工详榜"))}
          </div>
          <Table
            heads={["排名", "资产名称", "所属专题", "使用次数", ...(kind === "employee" ? ["好评率"] : [])].map(t)}
            rows={measured.map((r, i) => {
              if (!i || r.uses !== measured[i - 1].uses) rank = i + 1;
              return [
                rank,
                link("asset:" + r.a.id, r.a.name),
                r.topics,
                fmt(r.uses),
                ...(kind === "employee" ? [pct(r.m.rating)] : []),
              ];
            })}
          />
        </Panel>
      </>
    );
  }
  return (
    <>
      {nav}
      <div className="al-toolbar">{filterDept}</div>
      <div className="al-info">
        <strong>
          {t("四类合计")} {fmt(group.uses())} {t("次")}
        </strong>{" "}
        · {t("仅计入已观测的使用事件，一项业务任务可使用多项资产。")}
      </div>
      <div className="al-stats">
        {kinds.map((k, i) => (
          <Metric
            key={k}
            name={t(kindNames[k])}
            value={fmt(group.uses(k))}
            unit={t("次")}
            note={t(["有效业务执行", "成功检索", "Skill 使用记录", "成功工具调用"][i])}
            to={k}
            open={(id) => setKind(id)}
          />
        ))}
      </div>
      <Panel
        title={(kind === "all" ? t("全部资产") : t(kindNames[kind as AssetKind])) + " · " + t("使用明细")}
        action={
          <button className="al-link" onClick={() => setKind("all")}>
            {t("查看全部类型")} ↗
          </button>
        }
      >
        <Table
          heads={["资产名称", "资产类型", "有效使用（次）", "采集状态"].map(t)}
          rows={rows.map((r) => [
            link("asset:" + r.a.id, r.a.name),
            t(kindNames[r.a.kind]),
            fmt(r.uses),
            t(r.uses === null ? "未监测" : "已统计"),
          ])}
        />
      </Panel>
    </>
  );
}
