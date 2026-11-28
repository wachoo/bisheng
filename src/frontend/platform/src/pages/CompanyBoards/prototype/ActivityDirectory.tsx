import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TrendPeriod } from "@/controllers/API/activityTrends";
import type { AssetKind, BoardAsset } from "@/controllers/API/companyBoards";
import { aggregation, fmt, pct, kinds, kindNames } from "./ActivityData";
import { Table, Link, Options, useText } from "./ActivityWidgets";
import type { PrototypeDetailProps } from "./types";

function Card({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <article className="va-card">
      <div className="va-title">
        <h2>{title}</h2>
        <span>{caption}</span>
      </div>
      {children}
    </article>
  );
}
export default function Directory({
  props,
  point,
  fresh,
  published,
  nav,
}: {
  props: PrototypeDetailProps;
  point?: TrendPeriod;
  fresh: BoardAsset[];
  published: BoardAsset[] | null;
  nav: ReactNode;
}) {
  const t = useText(),
    { data, open, registers } = props;
  const [route, scope] = props.target.split(":"),
    isNew = route === "activity-new",
    category = kinds.includes(scope as AssetKind) ? (scope as AssetKind) : null;
  const { t: planText } = useTranslation("boardPlans");
  const scopedDepartment = isNew && scope && !category ? scope : null;
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  if (scopedDepartment && !data.departments.some(d => String(d.id) === scopedDepartment))
    return <p className="al-empty">{planText("departmentUnavailable")}</p>;
  const dates = new Map(
    data.ledger
      .filter((r) => r.kind === "release" && r.asset_key && r.effective_date && r.effective_date <= data.cutoff)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date))
      .map((r) => [r.asset_key!, r.effective_date!]),
  );
  for (const a of data.assets)
    if (a.published_at && a.published_at <= data.cutoff) dates.set(a.id, a.published_at);
  const profiles = new Map(
    registers
      .filter((r) => r.kind === "asset-profile" && r.date <= data.cutoff)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => [r.parent_id, r.fields.direction]),
  );
  const owners = new Map(data.departments.map((d) => [d.id, d.name])),
    pool = (isNew ? fresh : published || []).filter(a => (!category || a.kind === category) &&
      (!scopedDepartment || a.department_id?.toString() === scopedDepartment));
  const scoped = pool.filter(
    (a) =>
      (filter === "all" || filter === a.kind || (owners.has(a.department_id) && filter === "department:" + a.department_id)) &&
      [a.name, owners.get(a.department_id), a.id, a.kind === "knowledge" ? a.knowledge_category_name : profiles.get(a.id)]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const entries = scoped
    .map((a) => ({ a, metric: aggregation(point, a.id), uses: aggregation(point, a.id).uses(a.kind) }))
    .sort((a, b) =>
      isNew
        ? (dates.get(b.a.id) || "").localeCompare(dates.get(a.a.id) || "") ||
          a.a.name.localeCompare(b.a.name, "zh-CN")
        : (b.uses ?? -1) - (a.uses ?? -1) || a.a.name.localeCompare(b.a.name, "zh-CN"),
    );
  const table = (
    <div className="va-body">
      <Table
        heads={["资产名称", "资产类型", "归属部门", "首次正式发布日期"].map(t)}
        rows={entries.map(({ a }) => [
          <Link to={"asset:" + a.id} open={open} title={a.name} />,
          t(kindNames[a.kind]),
          a.department_id != null ? (
            <Link to={"department:" + a.department_id + "?view=published"} open={open} title={owners.get(a.department_id) || "—"} />
          ) : (
            "—"
          ),
          dates.get(a.id) || "—",
        ])}
      />
    </div>
  );
  const btn = (id: string, label: string) => (
    <button key={id} type="button" data-filter={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label}
    </button>
  );
  const searchLabel = t(isNew ? "搜索资产或部门" : category === "knowledge" ? "搜索资产、业务分类或部门" : "搜索资产、业务方向或部门");
  const historical = !isNew && data.catalog_as_of.slice(0, 7) !== data.cutoff.slice(0, 7);
  const historyNote = historical ? (
    <p className="al-caption">{t("历史目录仅展示已登记首发日期且当前仍在目录内的资产。")}</p>
  ) : null;
  const toolbar = (
    <div className={"al-toolbar" + (isNew ? " al-drill-toolbar" : "")}>
      {isNew ? (
        <div className="al-filter" role="group" aria-label={t("按资产类型筛选")}>
          {btn("all", t("全部") + " " + pool.length)}
          {kinds.map(k => btn(k, t(kindNames[k]) + " " + pool.filter(a => a.kind === k).length))}
        </div>
      ) : (
        <Options label={t("贡献部门")} value={filter} set={setFilter}
          options={[["all", t("全部")], ...data.departments.map(d => ["department:" + d.id, d.name])]} />
      )}
      <input
        className="al-search"
        placeholder={searchLabel}
        aria-label={searchLabel}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {isNew && (
        <input
          type="month"
          className="al-select"
          value={props.period}
          aria-label={t("统计月份")}
          onChange={(e) => e.target.value && props.changePeriod(e.target.value)}
        />
      )}
    </div>
  );
  if (isNew)
    return (
      <>
        {nav}
        {toolbar}
        {historyNote}
        <section className="va">
          <Card title={t("新增资产明细")} caption={fmt(entries.length) + " " + t("项")}>
            {table}
          </Card>
        </section>
      </>
    );
  const kpi = (label: ReactNode, value: number | string | null, unit = "") => (
    <div className="va-kpi">
      <span>{label}</span>
      <b>
        {typeof value === "string" ? value : fmt(value)}
        <small>{unit}</small>
      </b>
    </div>
  );
  const usage = (list: typeof entries) =>
    list.some((r) => r.uses !== null) ? list.reduce((s, r) => s + (r.uses || 0), 0) : null;
  const actions = { employee: "有效执行", knowledge: "有效检索", skill: "有效使用", tool: "有效调用" };
  if (!category)
    return (
      <>
        {nav}
        {toolbar}
        {historyNote}
        <section className="va">
          <div className="va-kpis">
            {kinds.map((k) => {
              const group = entries.filter((r) => r.a.kind === k);
              return (
                <div key={k} className="va-kpi">
                  <Link to={"activity-catalog:" + k} title={t(kindNames[k]) + " · " + t("概览")} open={open} />
                  <b>
                    {fmt(published ? group.length : null)}
                    <small>{t("项")}</small>
                  </b>
                  <span>
                    {t(actions[k])} {fmt(usage(group))} {t("次")}
                  </span>
                </div>
              );
            })}
          </div>
          <Card title={t("已发布资产")} caption={fmt(published ? entries.length : null) + " " + t("项")}>
            {table}
          </Card>
        </section>
      </>
    );
  const total = usage(entries),
    days = Number(data.cutoff.slice(8, 10)),
    groups = new Map<string, typeof entries>();
  entries.forEach((r) => {
    const name = r.a.kind === "knowledge" ? (r.a.knowledge_category_name || t("未归类")) : (profiles.get(r.a.id) || t("未登记业务方向"));
    groups.set(name, [...(groups.get(name) || []), r]);
  });
  const distribution = [...groups]
    .map(([name, r]) => ({ name, n: r.length, uses: usage(r) }))
    .sort((a, b) => (b.uses ?? -1) - (a.uses ?? -1) || b.n - a.n);
  const top = entries.filter((r) => r.uses > 0).slice(0, 3),
    ids = new Set(entries.map((r) => r.a.id));
  const totalMetrics = aggregation(
    point ? { ...point, rows: point.rows.filter((r) => ids.has(r.asset_id)) } : undefined,
  );
  const failures = totalMetrics.rows.filter((r) => r.kind === category).reduce((s, r) => s + r.failed, 0);
  const labels = { employee: "高频数字员工", knowledge: "知识库热度", skill: "常用 Skill", tool: "常用工具" };
  return (
    <>
      {nav}
      {toolbar}
      {historyNote}
      <section className="va" data-va-overview>
        {category === "skill" && <p className="al-caption">{t("skillUsageScope")}</p>}
        <div className="va-kpis">
          {kpi(t(kindNames[category]) + " · " + t("数量"), published ? entries.length : null, t("项"))}
          {kpi(t(actions[category]), total, t("次"))}
          {category === "employee" ? (
            <>
              {kpi(t("作业工时"), totalMetrics.hours, t("小时"))}
              {kpi(t("好评率"), pct(totalMetrics.rating))}
            </>
          ) : (
            <>
              {kpi(t("日均使用"), total === null ? null : total / days, t("次 / 日"))}
              {category !== "skill" &&
                kpi(t("成功率"), pct(total != null && total + failures ? total / (total + failures) : null))}
            </>
          )}
        </div>
        <div className="va-columns">
          <Card title={t("业务分布")} caption={t("按有效使用次数")}>
            {distribution.map((d) => (
              <div className="va-direction" key={d.name}>
                <span>{d.name}</span>
                <span className="va-track">
                  <i style={{ width: ((d.uses || 0) / Math.max(distribution[0].uses || 0, 1)) * 100 + "%" }} />
                </span>
                <small>
                  {d.n} {t("项")}
                </small>
                <strong>
                  {fmt(d.uses)} {t("次")}
                </strong>
              </div>
            ))}
            {!distribution.length && <p className="va-note">{t("当前筛选范围内暂无记录")}</p>}
          </Card>
          <Card title={t(labels[category])} caption={t("按有效使用次数")}>
            {top.map((r) => (
              <div key={r.a.id} className="va-top-row">
                <span className="va-position">
                  {String(top.findIndex((p) => p.uses === r.uses) + 1).padStart(2, "0")}
                </span>
                <Link to={"asset:" + r.a.id} open={open} title={r.a.name} />
                <strong>
                  {fmt(r.uses)} {t("次")}
                </strong>
              </div>
            ))}
            {!top.length && <p className="va-note">{t("当前筛选范围内暂无记录")}</p>}
          </Card>
        </div>
        <Card title={t(kindNames[category]) + " · " + t("明细")} caption={fmt(entries.length) + " " + t("项")}>
          {table}
        </Card>
      </section>
    </>
  );
}
