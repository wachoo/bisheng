import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useResearchReport } from "@/controllers/API/companyResearchReport";
import type { BoardAsset } from "@/controllers/API/companyBoards";
import type { MonitorSnapshot } from "@/controllers/API/companyMonitoring";
import { health } from "./MonitorParts";
import type { TrendPeriod } from "@/controllers/API/activityTrends";
import { aggregation, fmt, pct, sceneAssets, useBoardTrends, useTopicMonitoring } from "./ActivityData";
import { Chart, Link, Metric, Panel, Table, TrendNotice, useText } from "./ActivityWidgets";
import type { PrototypeDetailProps, PrototypeViewProps } from "./types";

const categories = ["document", "image", "page", "other"] as const;
const categoryNames = { document: "文档", image: "图片", page: "前端页面", other: "其他" };
function valuation(metrics: ReturnType<typeof aggregation>, registers: PrototypeViewProps["registers"]) {
  if (metrics.deliveries === null) return { hours: null, value: null };
  const rates = registers.filter((r) => r.kind === "value-rate").sort((a, b) => b.date.localeCompare(a.date));
  let hours = 0,
    value = 0;
  for (const output of metrics.outputs) {
    const valid = rates.filter(
      (r) =>
        r.date <= output.output_day &&
        r.fields.category === output.output_category &&
        r.fields.unit === output.kind,
    );
    if (!valid.length || valid[0].date === valid[1]?.date) return { hours: null, value: null };
    const labor = output.successful * Number(valid[0].fields.hours);
    hours += labor;
    value += labor * Number(valid[0].fields.hourly);
  }
  return { hours, value };
}

function associatedAssets(props: PrototypeViewProps, topic: string) {
  const ids = sceneAssets(
    props,
    new Set(props.data.ledger.filter((s) => s.kind === "scene" && s.parent_id === topic).map((s) => s.id)),
  );
  for (const asset of props.data.assets) if (asset.topic_id === topic) ids.add(asset.id);
  return ids;
}
const colors = ["var(--al-blue)", "var(--al-teal)", "var(--al-slate)", "var(--al-amber)"];

type Dot = { x: number; y: number; r: number };
/** Pack largest first. Radius is proportional to the square root of observed use. */
function bubblePositions(values: number[], width: number, height: number): Dot[] {
  if (!values.length || !width || !height) return [];
  const total = values.reduce((a, b) => a + b, 0);
  for (let density = 0.46; density > 0.005; density *= 0.8) {
    const placed: Dot[] = [];
    for (let i = 0; i < values.length; i++) {
      const radius = Math.sqrt((values[i] * width * height * density) / (total * Math.PI));
      let spot: Dot | null = null;
      for (let j = 0; j < 4200; j++) {
        const ring = (Math.sqrt(j) * Math.min(width, height)) / 38,
          angle = j * 2.399963 + i;
        const x = width / 2 + ring * Math.cos(angle) * Math.sqrt(width / height);
        const y = height / 2 + ring * Math.sin(angle) * Math.sqrt(height / width);
        if (x - radius < 2 || y - radius < 2 || x + radius > width - 2 || y + radius > height - 2) continue;
        if (placed.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= (radius + p.r + 2) ** 2)) {
          spot = { x, y, r: radius };
          break;
        }
      }
      if (!spot) break;
      placed.push(spot);
    }
    if (placed.length === values.length) return placed;
  }
  return [];
}

function Cloud({ props, point }: { props: PrototypeViewProps; point?: TrendPeriod }) {
  const t = useText();
  const [topic, setTopic] = useState("all"),
    [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ob = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  const topics = props.data.ledger.filter((r) => r.kind === "topic");
  const associations = new Map(topics.map((r) => [r.id, associatedAssets(props, r.id)]));
  const employees = props.data.assets.filter(
    (r) => r.kind === "employee" && (topic === "all" || associations.get(topic)?.has(r.id)),
  );
  const data = employees
    .map((asset) => ({ asset, metrics: aggregation(point, asset.id) }))
    .filter((r) => r.metrics.success && r.metrics.success > 0)
    .sort((a, b) => (b.metrics.success || 0) - (a.metrics.success || 0) || a.asset.id.localeCompare(b.asset.id));
  const dots = bubblePositions(
    data.map((r) => r.metrics.success || 0),
    size.width,
    size.height,
  );
  const active = data.find((r) => r.asset.id === hover);
  const name = (asset: BoardAsset) =>
    topics
      .filter((r) => associations.get(r.id)?.has(asset.id))
      .map((r) => r.name)
      .join("、") || "—";
  return (
    <>
      <div className="al-cloud-toolbar">
        <div className="al-bubble-filters" aria-label={t("专题")}>
          {[{ id: "all", name: t("全部") }, ...topics].map((r, i) => (
            <button
              key={r.id}
              data-bubble-topic={r.id}
              aria-pressed={topic === r.id}
              onClick={() => setTopic(r.id)}
            >
              {i > 0 && <i className="al-dot" style={{ background: colors[(i - 1) % 4] }} />}
              {r.name}
            </button>
          ))}
        </div>
        <span className="al-caption">
          {employees.length} {t("名数字员工")}
        </span>
      </div>
      <div className="al-cloud-wrap">
        <div className="al-cloud" ref={box} data-ready="true" role="group" aria-label={t("数字员工使用气泡云")}>
          {!data.length && <p className="al-empty">{t("暂无可核对数据")}</p>}
          {dots.map((p, i) => {
            const { asset, metrics } = data[i];
            const color = topics.findIndex((topic) => associations.get(topic.id)?.has(asset.id));
            const title = asset.name + " · " + fmt(metrics.success) + " " + t("次");
            return (
              <button
                key={asset.id}
                className="al-bubble"
                data-app={asset.id}
                data-uses={metrics.success}
                data-label={p.r * 2 >= 57 ? "name" : "none"}
                data-count={p.r * 2 >= 83 ? "yes" : "no"}
                style={
                  {
                    left: p.x,
                    top: p.y,
                    width: p.r * 2,
                    height: p.r * 2,
                    "--bubble-color": colors[Math.max(0, color) % 4],
                    "--bubble-font": Math.max(11, Math.min(38, p.r * 0.8)) + "px",
                  } as CSSProperties
                }
                aria-label={title}
                onMouseEnter={() => setHover(asset.id)}
                onFocus={() => setHover(asset.id)}
                onMouseLeave={() => setHover(null)}
                onBlur={() => setHover(null)}
                onClick={() => props.open("asset:" + asset.id, asset.name)}
              >
                <span className="al-bubble-name">{Array.from(asset.name)[0]}</span>
              </button>
            );
          })}
        </div>
        {active && (
          <div className="al-bubble-tooltip" role="status" style={{ left: 4, top: 4 }}>
            <b>{active.asset.name}</b>
            <span>
              {name(active.asset)} · {fmt(active.metrics.success)} {t("次")} · {t("好评率")}{" "}
              {pct(active.metrics.rating)}
            </span>
          </div>
        )}
      </div>
      <div className="al-cloud-legend">
        <span>{t("气泡大小 · 使用次数")}</span>
        <span>{props.period}</span>
      </div>
    </>
  );
}

function topicSummary(props: PrototypeViewProps, id: string, snapshot?: MonitorSnapshot) {
  const ids = associatedAssets(props, id);
  const scoped = props.data.assets.filter((a) => a.kind !== "skill" && ids.has(a.id));
  if (!snapshot) return { count: scoped.length, abnormal: null, unknown: null };
  const related = snapshot.assets.filter((a) => ids.has(a.id));
  return {
    count: scoped.length,
    abnormal: related.filter((a) => health(a) === "异常").length,
    unknown: related.filter((a) => !a.monitored).length,
  };
}
export default function Impact(props: PrototypeViewProps) {
  const { data, period, open } = props;
  const t = useText();
  const query = useBoardTrends(data, props.board),
    series = query.data;
  const monitoring = useTopicMonitoring(
    props,
    data.ledger.some((r) => r.kind === "topic"),
  );
  const month = data.month || 12;
  const totals = aggregation(series?.year),
    point = series?.months[month - 1],
    current = aggregation(point);
  const months = Array.from({ length: month }, (_, i) => aggregation(series?.months[i]));
  const target = (id: string) => () =>
    open(
      id.startsWith("labor") ? id : "deliveries:" + month,
      id.startsWith("labor") ? t("数字员工总工时") : t("交付物产出明细"),
    );
  const topics = data.ledger.filter((r) => r.kind === "topic"),
    topicList = useRef<HTMLDivElement>(null);
  const title = t("年度累计") + " · " + t("已观测 Web 运行");
  return (
    <section id="al-business" className="al-view" aria-label={t("业务赋能")}>
      {query.isError && <TrendNotice retry={query.refetch} />}
      {monitoring.isError && <TrendNotice retry={monitoring.refetch} />}
      <div className="al-stats">
        <Metric
          name={t("数字员工完成任务数")}
          value={fmt(totals.success)}
          unit={t("次")}
          note={title + " · " + t("成功执行")}
          open={open}
          to="applications:year"
          detailTitle={t("年度数字员工任务台账")}
        />
        <Metric
          name={t("数字员工总工时")}
          value={fmt(totals.hours)}
          unit={t("小时")}
          note={t("年度累计 · 有效执行时长")}
          open={open}
          to="labor:year"
        />
        <Metric
          name={t("年度交付物产出")}
          value={fmt(totals.deliveries)}
          unit={t("件")}
          note={t("年度累计 · 文件及项目版本")}
          open={open}
          to="deliveries:year"
          detailTitle={t("交付物产出明细")}
        />
        <Metric
          name={t("好评率")}
          value={pct(totals.rating)}
          note={title}
          open={open}
          to="ratings"
          detailTitle={t("业务服务好评率")}
        />
      </div>
      <div className="al-business-overview">
        <Panel
          title={t("数字员工使用分布")}
          action={<Link to="applications" open={open} title={t("数字员工明细")} />}
        >
          <Cloud props={props} point={point} />
        </Panel>
        <section className="al-panel al-topic-control">
          <div className="al-panel-head">
            <h3>{t("业务专题")}</h3>
            <div className="al-topic-controls">
              <button
                className="al-link al-topic-register"
                data-detail="topic-register"
                onClick={() => open("topic-register", t("专题台账"))}
              >
                {t("专题台账")} ↗
              </button>
              {[-1, 1].map((d) => (
                <button
                  key={d}
                  data-topic-scroll={d}
                  aria-label={t(d < 0 ? "向上查看专题" : "向下查看专题")}
                  onClick={() => topicList.current?.scrollBy({ top: d * 155, behavior: "smooth" })}
                >
                  {d < 0 ? "↑" : "↓"}
                </button>
              ))}
            </div>
          </div>
          <div className="al-topic-scroll" ref={topicList} role="region" aria-label={t("业务专题列表")}>
            {!topics.length && <p className="al-empty">{t("暂无已登记专题")}</p>}
            {topics.map((r) => {
              const m = topicSummary(props, r.id, monitoring.data);
              return (
                <button
                  key={r.id}
                  className="al-topic-entry"
                  data-detail={"topic-operations:" + r.id}
                  onClick={() => open("topic-operations:" + r.id, r.name)}
                >
                  <div className="al-topic-summary-title">
                    <h3>{r.name}</h3>
                    <span className="al-topic-entry-arrow">{t("查看运行")} ↗</span>
                  </div>
                  <div className="al-topic-counts">
                    <div>
                      <strong>{m.count}</strong>
                      <span>{t("运行管理资产")}</span>
                    </div>
                    <div>
                      <strong>{fmt(m.abnormal)}</strong>
                      <span>{t("异常资产")}</span>
                      {!!m.unknown && (
                        <small className="al-caption">
                          {t("未监测")} {m.unknown}
                        </small>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
        <div className="al-production-charts">
          <Panel
            title={t("作业工时")}
            action={
              <button
                className="al-production-value"
                data-detail={"labor:" + month}
                onClick={target("labor:" + month)}
              >
                {fmt(current.hours)}
                <small>
                  {t("小时")} · {month} {t("月")} ↗
                </small>
              </button>
            }
          >
            <Chart
              name={t("作业工时")}
              unit={t("小时")}
              period={period}
              cutoff={data.cutoff}
              selected={month}
              values={months.map((m) => m.hours)}
              line={{
                name: t("好评率"),
                unit: "%",
                percent: true,
                values: months.map((m) => (m.rating === null ? null : m.rating * 100)),
              }}
            />
          </Panel>
          <Panel
            title={t("交付物产出")}
            action={
              <button
                className="al-production-value"
                data-detail={"deliveries:" + month}
                onClick={target("deliveries:" + month)}
              >
                {fmt(current.deliveries)}
                <small>
                  {t("件")} · {month} {t("月")} ↗
                </small>
              </button>
            }
          >
            <Chart
              name={t("交付物产出")}
              unit={t("件")}
              period={period}
              cutoff={data.cutoff}
              selected={month}
              values={months.map((m) => m.deliveries)}
              line={{
                name: t("Token 消耗"),
                unit: t("百万 Token"),
                values: months.map((m) => (m.tokens === null ? null : m.tokens / 1e6)),
              }}
            />
          </Panel>
        </div>
      </div>
    </section>
  );
}

export function ImpactDetail(props: PrototypeDetailProps) {
  const { target, data, open, period } = props;
  const t = useText(),
    query = useBoardTrends(data, props.board);
  const [mode, setMode] = useState(() =>
      target.startsWith("labor") && new URLSearchParams(window.location.search).get("laborMode") === "equiv"
        ? "equiv"
        : "hours",
    ),
    [needle, setNeedle] = useState(""),
    [topic, setTopic] = useState("all");
  const [route, scope] = target.split(":");
  const monitoring = useTopicMonitoring(
    props,
    route === "topic-scenes" || (route === "topic-register" && data.ledger.some((r) => r.kind === "topic")),
  );
  const maxMonth = data.month || 12;
  const selected = scope === "year" ? 0 : Number(scope) || maxMonth;
  const needEquivalent = route === "labor" && mode === "equiv";
  const report = useResearchReport("lead", data.year, selected || maxMonth, needEquivalent);
  const series = query.data,
    point = selected ? series?.months[selected - 1] : series?.year,
    totals = aggregation(point);
  const months = Array.from({ length: maxMonth }, (_, i) => aggregation(series?.months[i]));
  const topics = data.ledger.filter((r) => r.kind === "topic");
  const select = (
    <label className="al-month-picker">
      <span>{t("统计期间")}</span>
      <select
        className="al-select"
        aria-label={t("选择统计期间")}
        value={selected}
        onChange={(e) => open(route + ":" + (Number(e.target.value) || "year"), props.title)}
      >
        <option value={0}>
          {data.year} {t("年累计")}
        </option>
        {months.map((_, i) => (
          <option value={i + 1} key={i}>
            {i + 1} {t("月")}
          </option>
        ))}
      </select>
    </label>
  );
  if (needEquivalent && report.isLoading) return <p role="status" className="al-empty">{t("正在读取看板…")}</p>;
  if (needEquivalent && report.isError) return <TrendNotice retry={report.refetch} />;
  if (query.isError) return <TrendNotice retry={query.refetch} />;
  if (monitoring.isError) return <TrendNotice retry={monitoring.refetch} />;
  if (route === "ratings")
    return (
      <Panel
        title={t("月度好评率")}
        action={
          <strong>
            {t("年度累计")} {pct(aggregation(series?.year).rating)}
          </strong>
        }
      >
        <Table
          heads={[t("月份"), t("好评率")]}
          rows={months.map((m, i) => [i + 1 + " " + t("月"), pct(m.rating)])}
        />
      </Panel>
    );
  if (route === "deliveries")
    return (
      <>
        {select}
        <Panel title={t("产出类型")}>
          <Table
            heads={[t("交付物类型"), t("数量（件）")]}
            rows={[
              ...categories.map((k) => [
                t(categoryNames[k]),
                fmt(
                  totals.deliveries === null
                    ? null
                    : totals.outputs.filter((r) => r.output_category === k).reduce((n, r) => n + r.successful, 0),
                ),
              ]),
              [
                t("待归类文件与版本"),
                fmt(
                  totals.deliveries === null
                    ? null
                    : totals.outputs.filter((r) => !r.output_category).reduce((n, r) => n + r.successful, 0),
                ),
              ],
              [t("合计"), fmt(totals.deliveries)],
            ]}
          />
        </Panel>
        <Panel title={t("交付物产出与 Token 消耗")}>
          <Chart
            name={t("交付物产出")}
            unit={t("件")}
            period={period}
            cutoff={data.cutoff}
            selected={selected}
            values={months.map((m) => m.deliveries)}
            line={{
              name: t("Token 消耗"),
              unit: t("百万 Token"),
              values: months.map((m) => (m.tokens === null ? null : m.tokens / 1e6)),
            }}
          />
        </Panel>
      </>
    );
  if (route === "labor") {
    const estimate = mode === "equiv",
      days = mode === "days",
      unit = t(days ? "工作日" : "小时");
    const val = (m: ReturnType<typeof aggregation>) =>
      estimate ? valuation(m, props.registers).hours : m.hours === null ? null : days ? m.hours / 8 : m.hours;
    const direct = estimate && report.data?.source === "direct" ? report.data : null;
    const legacy = valuation(totals, props.registers);
    const asNumber = (v: string | number | null | undefined) => v == null ? null : Number(v);
    const equivalentDays = direct ? asNumber(direct.metrics.equivalent_days) : legacy.hours === null ? null : legacy.hours / 8;
    const equivalentValue = direct ? asNumber(direct.metrics.equivalent_value) : legacy.value === null ? null : legacy.value / 10000;
    const sourceNote = direct ? t("科研与经营") + " · " + data.year + "-" + String(direct.source_month).padStart(2, "0") : t("等效人工工作量");

    const modeText = t(estimate ? "等效人工工作量" : days ? "作业工作日" : "实际执行工时");
    return (
      <>
        {select}
        <div className="al-toolbar">
          {[
            ["hours", "实际执行工时"],
            ["days", "作业工作日"],
            ["equiv", "等效人工工作量"],
          ].map(([key, label]) => (
            <button
              key={key}
              data-labor={key}
              className="al-button"
              aria-pressed={key === mode}
              onClick={() => setMode(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="al-stats">
          <Metric
            name={t(direct ? "截至所选月年累计" : selected ? "所选月累计" : "年度累计")}
            value={fmt(direct ? equivalentDays === null ? null : equivalentDays * 8 : val(totals))}
            unit={unit}
            note={direct ? sourceNote : modeText}
          />
          {estimate ? (
            <>
              <Metric
                name={t("等效人工工作日")}
                value={fmt(equivalentDays)}
                unit={t("人天")}
                note={t("8 小时 / 人天")}
              />
              <Metric
                name={t("等效工作量价值")}
                value={fmt(equivalentValue)}
                unit={t("万元")}
                note={direct ? sourceNote : t("按交付日生效参数估算")}
              />
            </>
          ) : (
            <Metric
              name={t("工时计量覆盖率")}
              value={pct(totals.timerCoverage)}
              note={t("已观测成功和失败任务")}
            />
          )}
          <Metric
            name={t("同期交付物")}
            value={fmt(totals.deliveries)}
            unit={t("件")}
            note={t("文件及项目版本")}
            open={open}
            to={"deliveries:" + (selected || "year")}
          />
        </div>
        <Panel title={t(direct ? "截至各月累计等效工时" : estimate ? "月度等效工作量（估算）" : "月度作业趋势")}>
          <Chart
            name={modeText}
            unit={unit}
            period={period}
            cutoff={data.cutoff}
            selected={selected}
            values={direct ? months.map((_, i) => {
              const days = asNumber(direct.history?.find((entry) => entry.month === i + 1)?.equivalent_days);
              return days === null ? null : days * 8;
            }) : months.map((m) => val(m))}
          />
        </Panel>
        <div className="al-info">
          {t(
            direct ? "年度累计值按填报月份展示，每人天按 8 小时折算。" : estimate
              ? "按交付日匹配成果类别、文件或版本单位、折算工时与小时单价。缺少分类或有效参数时暂缺估值。"
              : "成功和失败任务均累计主动工作时间，扣除排队、暂停、人工等待和纯工具等待。每个工作日按 8 小时折算。",
          )}
        </div>
      </>
    );
  }
  if (route === "topic-register")
    return (
      <Panel title={t("建设与运行")}>
        <Table
          heads={["专题", "年度计划资产", "年度已上线", "本期运行管理资产", "本期异常资产", "未监测"].map(t)}
          rows={topics.map((r) => {
            const scenes = new Set(
              data.ledger.filter((s) => s.kind === "scene" && s.parent_id === r.id).map((s) => s.id),
            );
            const plan = data.ledger.filter((s) => s.kind === "release" && s.parent_id && scenes.has(s.parent_id));
            const stat = topicSummary(props, r.id, monitoring.data);
            return [
              <Link key={r.id} to={"topic-operations:" + r.id} title={r.name} open={open} />,
              plan.length,
              plan.filter((s) => s.effective_date && s.effective_date <= data.cutoff).length,
              stat.count,
              fmt(stat.abnormal),
              fmt(stat.unknown),
            ];
          })}
        />
      </Panel>
    );
  if (route === "topic-scenes") {
    const measured = new Map((data.scene_usage || []).map((r) => [r.id, r]));
    const included = new Map<string,{id:string;name:string}>();
    data.ledger.filter(s=>s.kind==="scene" && s.parent_id===scope && s.effective_date && s.effective_date<=data.cutoff)
      .forEach(s=>included.set(s.id,s));
    for(const r of measured.values()) if(r.topic===scope) included.set(r.id,r);
    if(props.board==="monitor") monitoring.data?.filters.scenes.filter(s=>s.topic_id===scope).forEach(s=>included.set(s.id,s));
    const scenes = [...included.values()]
      .sort(
        (a, b) =>
          (measured.get(b.id)?.month ?? -1) - (measured.get(a.id)?.month ?? -1) ||
          a.name.localeCompare(b.name, "zh-CN"),
      );
    return (
      <Panel title={t("场景使用与评价")}>
        <Table
          heads={["场景", "有效使用次数", "作业工时（小时）", "好评率"].map(t)}
          rows={scenes.map((s) => {
            const m = measured.get(s.id);
            return [
              <Link open={open} to={(props.board==="monitor"?"monitor:scene:":"strategy:scene:") + s.id} title={s.name} />,
              fmt(m?.month),
              fmt(m?.month_hours),
              pct(m?.month_positive_rate),
            ];
          })}
        />
        <p className="al-caption">{t("仅计入能归属到场景的执行。使用共用资产且未指定场景的任务保留为未归属。")}</p>
      </Panel>
    );
  }
  if (route !== "applications") return null;
  const dep = (a: BoardAsset) => data.departments.find((d) => d.id === a.department_id)?.name || "—";
  const assets = data.assets
    .filter(
      (a) =>
        a.kind === "employee" &&
        (topic === "all" || associatedAssets(props, topic).has(a.id)) &&
        (a.name + dep(a)).toLowerCase().includes(needle.toLowerCase()),
    )
    .map((a) => ({ a, m: aggregation(point, a.id) }))
    .sort((a, b) => (b.m.success ?? -1) - (a.m.success ?? -1));
  return (
    <>
      <div className="al-toolbar">
        <div className="al-filter">
          {[{ id: "all", name: t("全部") }, ...topics].map((r) => (
            <button key={r.id} aria-pressed={topic === r.id} onClick={() => setTopic(r.id)}>
              {r.name}
            </button>
          ))}
        </div>
        <input
          className="al-search"
          placeholder={t("搜索数字员工或部门")}
          aria-label={t("搜索数字员工或部门")}
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
      </div>
      <Panel
        title={t("数字员工任务明细")}
        action={
          <span className="al-caption">
            {t("成功执行合计")}{" "}
            {assets.some((r) => r.m.success !== null)
              ? fmt(assets.reduce((s, r) => s + (r.m.success || 0), 0))
              : "—"}{" "}
            {t("次")}
          </span>
        }
      >
        <Table
          heads={["数字员工", "归属部门", "所属专题", "成功执行数（次）", "交付物（件）", "好评率"].map(t)}
          rows={assets.map(({ a, m }) => [
            <Link
              open={open}
              to={"asset:" + a.id + "?window=" + (scope === "year" ? "year" : "month")}
              title={a.name}
            />,
            dep(a),
            topics
              .filter((r) => associatedAssets(props, r.id).has(a.id))
              .map((r) => r.name)
              .join("、") || "—",
            fmt(m.success),
            fmt(m.deliveries),
            pct(m.rating),
          ])}
        />
      </Panel>
    </>
  );
}
