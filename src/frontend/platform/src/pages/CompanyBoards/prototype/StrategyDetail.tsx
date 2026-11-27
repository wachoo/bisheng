import { useTranslation } from "react-i18next";
import { Fragment, useState, type ReactNode } from "react";
import { isReportView, ResearchReportDetail } from "./ResearchReportDetail";
import { CaseOutput } from "../CaseOutput";
import type { PrototypeDetailProps } from "./types";
import {
  constructionAssetTarget,
  kinds,
  rankedScenes,
  releaseKind,
  sceneAssetIds,
  strategyRows,
  strategyTopicAssets,
} from "./StrategyModel";
import { aggregation, fmt, pct, useBoardTrends } from "./ActivityData";

const sceneAttribution =
  "按执行当日数字员工唯一有效的场景关系统计。员工由多个场景共用且本次归属未确认时，该次执行仅计入公司总量。";
const archives = [
  ["construction", "年度场景建设台账"],
  ["plan", "专题计划资产台账"],
  ["highvalue", "高价值场景认定"],
  ["candidates", "场景价值榜"],
  ["research", "科研项目与课题"],
  ["spending", "年度 AI 经费支出"],
  ["budget", "在研项目预算"],
  ["forecast", "预估年度 AI 产值"],
  ["receivables", "合同本年度待收款"],
];
function Table({
  heads,
  rows,
  none = "没有匹配的记录",
}: {
  heads: string[];
  rows: ReactNode[][];
  none?: string;
}) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / 12));
  const selected = Math.min(page, pages);
  return (
    <>
      <div className="al-table-wrap">
        <table>
          <thead>
            <tr>
              {heads.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(12 * (selected - 1), 12 * selected).map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="al-empty" colSpan={heads.length}>
                  {none}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="al-paging">
        <span>共 {rows.length} 条</span>
        <div>
          <button className="al-button" disabled={selected <= 1} onClick={() => setPage(selected - 1)}>
            上一页
          </button>
          <span>
            {selected} / {pages}
          </span>
          <button className="al-button" disabled={selected >= pages} onClick={() => setPage(selected + 1)}>
            下一页
          </button>
        </div>
      </div>
    </>
  );
}
function Panel({ name, children, caption }: { name: string; children: ReactNode; caption?: ReactNode }) {
  return (
    <section className="al-panel">
      <div className="al-panel-head">
        <h3>{name}</h3>
        <span className="al-caption">{caption}</span>
      </div>
      {children}
    </section>
  );
}
function Stats({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="al-stats">
      {rows.map(([name, value]) => (
        <div className="al-stat" key={name}>
          <div className="al-stat-name">{name}</div>
          <div className="al-stat-value">{value}</div>
        </div>
      ))}
    </div>
  );
}
function Options({
  label,
  current,
  set,
  options,
}: {
  label: string;
  current: string;
  set: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="al-revision-select">
      {label}
      <select className="al-select" value={current} onChange={(e) => set(e.target.value)}>
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
const amount = (raw: string | number | undefined) =>
  raw != null && String(raw).trim() !== "" && Number.isFinite(Number(raw))
    ? (Number(raw) / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : "—";

export function StrategyDetail(props: PrototypeDetailProps) {
  if (!props.target.startsWith("strategy:")) return null;
  return <DetailBody key={props.target} {...props} />;
}
function DetailBody({ data, registers, target, period, open, board }: PrototypeDetailProps) {
  const { t: serviceText } = useTranslation("companyBoards", { keyPrefix: "sceneService" });
  const { t: caseText } = useTranslation("topicExample");
  const [, route, arg] = target.split(":");
  const trend = useBoardTrends(data, board).data?.months.find((m) => m.month === data.month);
  const { topics, scenes, plans, published, workers, depRanks, workerRanks } =
    strategyRows(data);
  const [q, search] = useState("");
  const [topic, pickTopic] = useState("all");
  const [department, pickDept] = useState("all");
  const [mode, setMode] = useState(route === "research" && arg === "subject" ? "subject" : "all");
  const [reverse, setReverse] = useState(false);
  const searchBox = (
    <input
      className="al-search"
      aria-label="搜索名称"
      placeholder="搜索名称、部门或专题"
      value={q}
      onChange={(e) => search(e.target.value)}
    />
  );
  const match = (...words: (string | null | undefined)[]) =>
    !q.trim() || words.some((w) => w?.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()));
  const link = (key: string, title: string, label?: string) => (
    <button className="al-link" type="button" onClick={() => open(key, title)}>
      {label || title} ↗
    </button>
  );
  const jump = (key: string, title: string) => link("strategy:" + key, title);
  const dept = (id: number | null) => data.departments.find((d) => d.id === id)?.name || "未归属";
  const top = (id: string | null) => topics.find((t) => t.id === id)?.name || "—";
  const asset = (id: string | null) => data.assets.find((a) => a.id === id);
  const assetName = (id: string | null) => asset(id)?.name || id || "—";
  const kindLabel = (id: string | null) => kinds.find((k) => k.kind === asset(id)?.kind)?.label || "—";
  const topicSelect = (
    <Options
      label="专题"
      current={topic}
      set={pickTopic}
      options={[["all", "全部专题"], ...topics.map((t) => [t.id, t.name] as [string, string])]}
    />
  );
  const depSelect = (
    <Options
      label="单位"
      current={department}
      set={pickDept}
      options={[
        ["all", "全部单位"],
        ...data.departments.map((d) => [String(d.id), d.name] as [string, string]),
      ]}
    />
  );
  const assetIds = (scene: string) => Array.from(sceneAssetIds(data, registers, scene));
  const support = (scene: string, owner: number | null) => [
    ...new Set(
      registers
        .filter(
          (r) =>
            r.kind === "scene-team" &&
            r.parent_id === scene &&
            r.date <= data.cutoff &&
            (!r.fields.end || r.fields.end >= data.cutoff),
        )
        .map((r) => Number(r.fields.department))
        .filter(id => id !== owner && data.departments.some(d => d.id === id)),
    ),
  ];
  const filters = (opts: [string, string][]) =>
    opts.map(([key, name]) => (
      <button key={key} data-filter={name} aria-pressed={mode === key} onClick={() => setMode(key)}>
        {name}
      </button>
    ));
  const scLink = (id: string, name: string) => jump("scene:" + id, name);
  if (route === "topics")
    return (
      <Panel name="已登记专题">
        <Table
          heads={["专题", "建设场景", "代表案例", "已发布资产"]}
          rows={topics.map((t) => [
            jump("topic:" + t.id, t.name),
            scenes.filter((s) => s.parent_id === t.id).length,
            registers.filter((r) => r.kind === "case" && r.parent_id === t.id && r.date <= data.cutoff)
              .length,
            data.assets.filter((a) => strategyTopicAssets(data, registers, t.id).has(a.id)).length,
          ])}
        />
      </Panel>
    );
  if (route === "goals")
    return (
      <Panel name="年度目标与建设进度" caption={data.cutoff}>
        <Table
          heads={["建设指标", "已完成", "年度目标", "完成率"]}
          rows={[
            [
              jump("annual", "数字员工建设"),
              data.strategy.employee_built,
              data.strategy.employee_target ?? "—",
              pct(
                data.strategy.employee_target
                  ? data.strategy.employee_built / data.strategy.employee_target
                  : null,
              ),
            ],
            [
              jump("construction", "业务场景投产"),
              data.strategy.scene_launched,
              data.strategy.scene_target ?? "—",
              pct(
                data.strategy.scene_target ? data.strategy.scene_launched / data.strategy.scene_target : null,
              ),
            ],
          ]}
        />
      </Panel>
    );
  if (route === "special")
    return (
      <Panel name="业务与经营明细">
        <div className="v4-archive">
          {archives.map(([key, name]) => (
            <button key={key} className="al-button" onClick={() => open("strategy:" + key, name)}>
              {name} ↗
            </button>
          ))}
        </div>
      </Panel>
    );
  if (isReportView(route))
    return <ResearchReportDetail year={data.year} month={Number(period.slice(5, 7))} view={route} subjectTab={arg === "subject"} cutoff={data.cutoff} />;
  if (route === "case") {
    const c = registers.find((r) => r.kind === "case" && r.id === arg && r.date <= data.cutoff);
    if (!c) return <Panel name="专题代表案例">当前期间未登记该案例</Panel>;
    return (
      <>
        <Panel name={c.name} caption={c.date}>
          {link("asset:" + c.fields.assets, assetName(c.fields.assets), caseText("viewEmployee"))}
          {c.fields.summary && <p className="al-info">{c.fields.summary}</p>}
          <div className="al-info">案例输入 · {c.fields.input || "尚未登记"}</div>
        </Panel>
        <Panel name={c.fields.sampleTitle || "案例输出"}>
          <CaseOutput fields={c.fields} empty="尚未登记案例输出" />
        </Panel>
      </>
    );
  }
  if (route === "knowledge") {
    const { knowledge_categories = [], knowledge_verified, knowledge_planned } = data.strategy;
    return (
      <Panel name="年度知识接入计划" caption={`已接入 ${knowledge_verified} 个 / 年度计划 ${knowledge_planned} 个`}>
        <Table
          heads={["业务分类", "计划数", "已接入", "计划完成日期"]}
          rows={knowledge_categories.map(row => [row.name, row.target, row.completed, row.planned_date || "—"])}
        />
      </Panel>
    );
  }
  if (route === "active") {
    const service = data.scene_service;
    const sceneDetails = new Set([...scenes.map(s => s.id), ...(data.scene_usage ?? []).map(s => s.id)]);
    const employees = (service?.employees ?? []).filter(row => match(row.name, ...row.scenes.map(s => s.name)));
    return (
      <>
        <Stats rows={[
          [serviceText("uses"), fmt(service?.uses) + serviceText("times")],
          [serviceText("users"), fmt(service?.users) + serviceText("people")],
        ]} />
        <div className="al-toolbar">
          <input className="al-search" aria-label={serviceText("search")} placeholder={serviceText("search")}
            value={q} onChange={e => search(e.target.value)} />
        </div>
        <Panel name={serviceText("detail")}>
          <Table heads={[serviceText("employee"), serviceText("scenes"), serviceText("uses"), serviceText("users")]}
            rows={employees.map(row => [
              asset(row.asset_id) ? link(constructionAssetTarget(row.asset_id), row.name) : row.name,
              row.scenes.map((s, index) => <Fragment key={s.id}>{index > 0 && "、"}{sceneDetails.has(s.id) ? scLink(s.id, s.name) : s.name}</Fragment>),
              row.monitored ? fmt(row.uses) : "—",
              row.monitored ? fmt(row.users) : "—",
            ])}
            none={q.trim() ? serviceText("noMatches") : serviceText("empty")}
          />
          <p className="al-chart-note">{serviceText("definition")}</p>
        </Panel>
      </>
    );
  }
  if (route === "construction" || route === "highvalue") {
    const recognized = registers.filter(
      (r) =>
        r.kind === "recognition" &&
        r.date &&
        r.date <= data.cutoff &&
        (!r.fields.end || r.fields.end >= data.cutoff),
    );
    const inYear = registers.filter(
      (r) => r.kind === "recognition" && r.date?.startsWith(String(data.year)) && r.date <= data.cutoff,
    );
    const rows = scenes.filter(
      (r) =>
        (topic === "all" || topic === r.parent_id) &&
        (department === "all"
          ? mode !== "support" || support(r.id, r.department_id).length > 0
          : (mode !== "support" && String(r.department_id) === department) ||
            (mode !== "owner" && support(r.id, r.department_id).includes(Number(department)))) &&
        match(r.name, top(r.parent_id), dept(r.department_id), ...support(r.id, r.department_id).map(dept)),
    );
    return (
      <>
        {route === "highvalue" && (
          <Stats
            rows={[
              ["有效认定", new Set(recognized.map((r) => r.parent_id)).size],
              ["本年新增", new Set(inYear.map((r) => r.parent_id)).size],
            ]}
          />
        )}
        <div className="al-toolbar">
          {topicSelect}
          {route === "construction" && (
            <>
              {depSelect}
              <Options
                label="建设责任"
                current={mode}
                set={setMode}
                options={[
                  ["all", "承建或支持"],
                  ["owner", "承建单位"],
                  ["support", "支持单位"],
                ]}
              />
            </>
          )}
          {searchBox}
        </div>
        <section className="al-panel">
          {route === "construction" ? (
            <Table
              heads={["场景名称", "所属专题", "AI 资产数", "承建单位", "支持单位", "投产日期"]}
              none={mode === "support" ? "尚未登记支持单位" : "没有匹配的记录"}
              rows={rows.map((r) => [
                scLink(r.id, r.name),
                top(r.parent_id),
                assetIds(r.id).length,
                dept(r.department_id),
                support(r.id, r.department_id).map(dept).join("、") || "—",
                r.effective_date && r.effective_date <= data.cutoff ? r.effective_date : "待投产",
              ])}
            />
          ) : (
            <Table
              heads={["场景名称", "所属专题", "AI 资产数", "价值认定"]}
              rows={rows
                .filter((r) => recognized.some((h) => h.parent_id === r.id))
                .map((r) => [scLink(r.id, r.name), top(r.parent_id), assetIds(r.id).length, "认定有效"])}
              none="暂无有效认定"
            />
          )}
        </section>
      </>
    );
  }
  if (route === "scene") {
    const usage = data.scene_usage?.find((r) => r.id === arg);
    const current = scenes.find((r) => r.id === arg);
    const s =
      current ||
      (usage && {
        id: usage.id,
        name: usage.name,
        parent_id: usage.topic,
        department_id: usage.department_id,
        effective_date: usage.launched,
      });
    if (!s) return <Panel name="建设台账">未找到该场景</Panel>;
    const estimate = registers
      .filter(
        (r) => r.kind === "estimate" && r.parent_id === s.id && r.year === data.year && r.date <= data.cutoff,
      )
      .at(-1);
    return (
      <>
        <Panel
          name="建设台账"
          caption={
            s.effective_date && s.effective_date.slice(0, 4) < String(data.year)
              ? "跨年沿用 · 往年投产"
              : undefined
          }
        >
          <Table
            heads={["所属专题", "承建单位", "支持单位", "投产日期"]}
            rows={[
              [
                usage?.topic_name || top(s.parent_id),
                dept(s.department_id),
                support(s.id, s.department_id).map(dept).join("、") || "—",
                s.effective_date || "待投产",
              ],
            ]}
          />
        </Panel>
        {usage && (
          <Panel name="场景使用情况">
            <Table
              heads={["本年成功执行", "近 90 天成功执行", "近 90 天好评率", "最近使用"]}
              rows={[[usage.year, usage.last90, pct(usage.positive_rate), usage.last_used || "—"]]}
            />
          </Panel>
        )}
        {estimate && (
          <Panel name="场景年度价值估算" caption={estimate.date}>
            <Table
              heads={["预计年度节约工时", "人工单价 / 元", "其他节约 / 万元", "预计年度价值 / 万元"]}
              rows={[
                [
                  estimate.fields.hours,
                  estimate.fields.hourly,
                  amount(estimate.fields.saving),
                  amount(
                    Number(estimate.fields.hours) * Number(estimate.fields.hourly) +
                      Number(estimate.fields.saving),
                  ),
                ],
              ]}
            />
          </Panel>
        )}
        <Panel name="关联 AI 资产">
          <Table
            heads={["资产名称", "类型"]}
            rows={assetIds(s.id).map((id) => [
              asset(id) ? link("asset:" + id, assetName(id)) : id,
              kindLabel(id),
            ])}
          />
        </Panel>
      </>
    );
  }
  if (route === "plan") {
    const scoped = plans.filter(
      (r) => topic === "all" || scenes.some((s) => s.id === r.parent_id && s.parent_id === topic),
    );
    const done = scoped.filter((r) => published.some((p) => p.id === r.id)).length;
    return (
      <>
        <Stats
          rows={[
            ["计划 AI 资产", scoped.length],
            ["已完成 AI 资产", done],
            ["完成率", scoped.length ? Math.round((100 * done) / scoped.length) + "%" : "—"],
          ]}
        />
        <div className="al-toolbar">
          {topicSelect}
          <Options
            label="上线状态"
            current={mode}
            set={setMode}
            options={[
              ["all", "全部状态"],
              ["done", "已上线"],
              ["waiting", "待上线"],
            ]}
          />
        </div>
        <Table
          heads={["AI 资产名称", "类型", "所属场景", "所属专题", "上线状态"]}
          rows={scoped.flatMap((r) => {
            const s = scenes.find((x) => x.id === r.parent_id);
            const ok = published.some((x) => x.id === r.id);
            return mode === "all" || (mode === "done") === ok
              ? [
                  [
                    link("asset:" + r.asset_key, assetName(r.asset_key)),
                    kindLabel(r.asset_key),
                    s ? scLink(s.id, s.name) : "—",
                    top(s?.parent_id || null),
                    ok ? "已上线" : "待上线",
                  ],
                ]
              : [];
          })}
        />
      </>
    );
  }
  if (route === "candidates") {
    const entries = rankedScenes(data.scene_usage || [], data.cutoff);
    const start = new Date(data.cutoff + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() - 89);
    return (
      <Panel name="入榜场景" caption="近 90 个自然日 · 好评率达到 90%">
        <div className="al-rank-period">
          <span>近 90 天</span>
          <span>
            {start.toISOString().slice(0, 10)}—{data.cutoff}
          </span>
        </div>
        <div className="al-rank-table">
          <Table
            heads={["场景", "使用次数", "好评率"]}
            rows={entries.map((s, i) => [
              <>
                <span className="al-rank-index">{i + 1}</span>
                {scLink(s.id, s.name)}
              </>,
              s.last90,
              pct(s.positive_rate),
            ])}
            none={data.scene_usage ? "所选期间暂无达到入榜条件的场景" : "缺少可按场景归属的执行与反馈记录"}
          />
        </div>
        <p className="al-chart-note">{sceneAttribution}</p>
      </Panel>
    );
  }
  if (route === "department-ranking" || route === "worker-ranking") {
    const worker = route === "worker-ranking";
    return (
      <>
        <div className="al-toolbar">
          {jump("department-ranking", "部门资产沉淀榜")}
          {jump("worker-ranking", "数字员工使用榜")}
          {searchBox}
        </div>
        <Panel name={worker ? "数字员工排行" : "完整排行"}>
          {worker && (
            <div className="al-toolbar">
              <button className="al-link" onClick={() => setReverse(!reverse)}>
                按使用次数 {reverse ? "↑" : "↓"}
              </button>
            </div>
          )}
          <Table
            heads={
              worker
                ? ["排名", "数字员工", "归属部门", "使用次数", "好评率", "健康程度"]
                : ["名次", "部门", ...kinds.map((k) => k.label), "沉淀资产（项）"]
            }
            rows={
              worker
                ? workerRanks
                    .filter((r) => match(r.name, dept(asset(r.id)?.department_id ?? null)))
                    .sort((a, b) => (reverse ? a.count - b.count : b.count - a.count))
                    .map((r) => [
                      workerRanks.findIndex((x) => x.count === r.count) + 1,
                      link("asset:" + r.id, r.name),
                      dept(asset(r.id)?.department_id ?? null),
                      r.count,
                      pct(aggregation(trend, r.id).rating),
                      aggregation(trend, r.id).health,
                    ])
                : depRanks
                    .filter((r) => match(r.name))
                    .map((r) => [
                      depRanks.findIndex((x) => x.count === r.count) + 1,
                      link("department:" + r.id + "?view=year", r.name),
                      ...kinds.map(
                        (k) =>
                          published.filter(
                            (a) => a.department_id === r.id && releaseKind(a) === k.kind,
                          ).length,
                      ),
                      r.count,
                    ])
            }
          />
        </Panel>
      </>
    );
  }
  if (route === "annual" || route === "month") {
    const subset = workers.filter(
      (r) =>
        (route === "annual" || Number(r.effective_date?.slice(5, 7)) === Number(arg)) &&
        (department === "all" || String(r.department_id) === department) &&
        match(assetName(r.asset_key), dept(r.department_id)),
    );
    return (
      <>
        <div className="al-toolbar">
          {depSelect}
          {searchBox}
        </div>
        <Panel name={"资产清单 · " + subset.length + " 项"}>
          <Table
            heads={["资产名称", "类型", "归属部门", "首次投产 / 发布", "关联专题"]}
            rows={subset.map((r) => [
              link(
                constructionAssetTarget(r.asset_key!, route === "month" ? arg : undefined),
                assetName(r.asset_key),
              ),
              kindLabel(r.asset_key),
              dept(r.department_id),
              r.effective_date,
              top(scenes.find((s) => s.id === r.parent_id)?.parent_id || null),
            ])}
          />
        </Panel>
        {route === "annual" && (
          <Panel name="按投产月份查看">
            {Array.from({ length: Number(period.slice(5, 7)) }, (_, i) => (
              <span key={i}>
                {link(
                  "strategy:month:" + (i + 1),
                  i + 1 + " 月新增数字员工",
                  i +
                    1 +
                    "月 · " +
                    workers.filter((w) => Number(w.effective_date?.slice(5, 7)) === i + 1).length +
                    " 位",
                )}
                　
              </span>
            ))}
          </Panel>
        )}
      </>
    );
  }
  const topicAssets = strategyTopicAssets(data, registers, arg);
  const rows = data.assets.filter(
    (a) =>
      (route === "topic" ? topicAssets.has(a.id) : arg === "all" || a.kind === arg) &&
      (department === "all" || String(a.department_id) === department) &&
      match(a.name, dept(a.department_id)),
  );
  const type = kinds.find((k) => k.kind === arg);
  const totals = (id: string) => data.runtime.usage.find((u) => u.asset_id === id)?.count;
  const table = (
    <Table
      heads={["资产名称", "资产类型", "归属部门", "首次正式发布日期"]}
      rows={rows.map((a) => [
        link("asset:" + a.id, a.name),
        kindLabel(a.id),
        a.department_id ? link("department:" + a.department_id + "?view=published", dept(a.department_id)) : dept(null),
        a.published_at || published.find((r) => r.asset_key === a.id)?.effective_date || "—",
      ])}
    />
  );
  if (route === "topic") {
    const cases = registers.filter((r) => r.kind === "case" && r.parent_id === arg && r.date <= data.cutoff);
    return (
      <>
        <Panel name="专题选录的已发布资产" caption={"截至 " + data.catalog_as_of}>
          {table}
        </Panel>
        <Panel name="专题代表案例">
          <Table
            heads={[caseText("label")]}
            rows={cases.map((c) => [link("asset:" + c.fields.assets, assetName(c.fields.assets))])}
            none={caseText("empty")}
          />
        </Panel>
      </>
    );
  }
  const uses = rows.reduce((sum, a) => sum + (totals(a.id) ?? 0), 0);
  const usage = rows.some((a) => totals(a.id) != null) ? uses : null;
  const verb = { employee: "执行", knowledge: "检索", skill: "使用", tool: "调用" };
  const ids = new Set(rows.map((r) => r.id));
  const scoped = trend && { ...trend, rows: trend.rows.filter((r) => r.asset_id && ids.has(r.asset_id)) };
  const metrics = aggregation(scoped);
  const events = scoped?.rows.filter((r) => r.kind === type?.kind) || [];
  const successes = events.reduce((n, r) => n + r.successful, 0);
  const attempts = successes + events.reduce((n, r) => n + r.failed, 0);
  const profiles = new Map(
    registers
      .filter((r) => r.kind === "asset-profile" && r.date <= data.cutoff)
      .map((r) => [r.parent_id, r.fields.direction]),
  );
  const distribution = new Map<string, { count: number; uses: number | null }>();
  for (const row of rows) {
    const key = (row.kind === "knowledge" ? row.knowledge_category_name : profiles.get(row.id)) || "未归类",
      group = distribution.get(key) || { count: 0, uses: null };
    group.count++;
    const uses = totals(row.id);
    if (uses != null) group.uses = (group.uses || 0) + uses;
    distribution.set(key, group);
  }
  const bars = [...distribution].sort(
    (a, b) => (b[1].uses || 0) - (a[1].uses || 0) || b[1].count - a[1].count,
  );
  const topRows = rows
    .filter((a) => totals(a.id) != null)
    .sort((a, b) => (totals(b.id) || 0) - (totals(a.id) || 0))
    .slice(0, 3);
  return (
    <>
      <div className="al-toolbar">
        {depSelect}
        {searchBox}
      </div>
      <section className="va">
        <div className="va-kpis">
          {!type ? (
            kinds.map((k) => (
              <div className="va-kpi" key={k.kind}>
                {jump("assets:" + k.kind, k.label + "概览")}
                <b>
                  {rows.filter((a) => a.kind === k.kind).length}
                  <small>{k.unit}</small>
                </b>
                <span>
                  有效{verb[k.kind]}{" "}
                  {data.runtime.usage.some((u) => u.kind === k.kind)
                    ? rows.filter((a) => a.kind === k.kind).reduce((n, a) => n + (totals(a.id) || 0), 0)
                    : "—"}{" "}
                  次
                </span>
              </div>
            ))
          ) : (
            <>
              {[
                [type.label + "数量", rows.length, type.unit],
                ["有效" + verb[type.kind], usage ?? "—", "次"],
                ...(type.kind === "employee"
                  ? [
                      ["作业工时", fmt(metrics.hours), "小时"],
                      ["好评率", pct(metrics.rating), ""],
                    ]
                  : [
                      [
                        "日均有效" + verb[type.kind],
                        usage === null ? "—" : (usage / Number(data.cutoff.slice(8))).toFixed(1),
                        "次 / 日",
                      ],
                      ...(type.kind === "skill"
                        ? []
                        : [[verb[type.kind] + "成功率", pct(attempts ? successes / attempts : null), ""]]),
                    ]),
              ].map(([title, value, unit]) => (
                <div className="va-kpi" key={title}>
                  <span>{title}</span>
                  <b>
                    {value}
                    <small>{unit}</small>
                  </b>
                </div>
              ))}
            </>
          )}
        </div>
        {type && (
          <div className="va-columns">
            <article className="va-card">
              <div className="va-title">
                <h2>业务分布</h2>
                <span>按{type.kind === "knowledge" ? "业务分类" : "业务方向"} · 数量 / 有效{verb[type.kind]}次数</span>
              </div>
              <div className="va-body">
                {bars.map(([name, group]) => (
                  <div className="va-direction" key={name}>
                    <span>{name}</span>
                    <span className="va-track">
                      <i
                        style={{ width: (100 * (group.uses || 0)) / Math.max(1, bars[0][1].uses || 0) + "%" }}
                      />
                    </span>
                    <small>
                      {group.count} {type.unit}
                    </small>
                    <strong>{fmt(group.uses)} 次</strong>
                  </div>
                ))}
                {!bars.length && <div className="al-empty">暂无该类资产</div>}
              </div>
            </article>
            <article className="va-card">
              <div className="va-title">
                <h2>
                  {
                    {
                      employee: "高频数字员工",
                      knowledge: "知识库热度",
                      skill: "常用 Skill",
                      tool: "常用工具",
                    }[type.kind]
                  }
                </h2>
              </div>
              <div className="va-body">
                {topRows.map((a) => (
                  <div className="va-top-row" key={a.id}>
                    <span className="va-position">
                      {String(topRows.findIndex((x) => totals(x.id) === totals(a.id)) + 1).padStart(2, "0")}
                    </span>
                    {link("asset:" + a.id, a.name)}
                    <strong>{totals(a.id)} 次</strong>
                  </div>
                ))}
                {!topRows.length && <div className="al-empty">暂无已采集使用记录</div>}
              </div>
            </article>
          </div>
        )}
        <article className="va-card">
          <div className="va-title">
            <h2>{type ? type.label + "明细" : "已发布资产"}</h2>
            <span>
              {rows.length} {type?.unit || "项"}
            </span>
          </div>
          <div className="va-body">{table}</div>
        </article>
      </section>
    </>
  );
}
