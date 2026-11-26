import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { CaseOutput } from "../CaseOutput";
import { kinds, strategyRows, strategyTopicAssets } from "./StrategyModel";
import { aggregation, pct as percentage, useBoardTrends } from "./ActivityData";
import type { PrototypeViewProps } from "./types";
import frameCss from "./StrategyFrame.css?inline";

export { StrategyDetail } from "./StrategyDetail";

const missing = "—";
function Hit({
  children,
  go,
  label,
  cls = "",
}: {
  children: ReactNode;
  go: () => void;
  label: string;
  cls?: string;
}) {
  return (
    <div
      className={cls + " v4-drill-target"}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      {children}
    </div>
  );
}
function Card({
  cls,
  title,
  period,
  children,
}: {
  cls: string;
  title: string;
  period: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={"card " + cls}>
      <div className={"card-body" + (cls === "goals" ? " knowledge-body" : "")}>
        <div className="board-head">
          <h2 className="card-title">{title}</h2>
          {typeof period === "string" ? <span className="period">{period}</span> : period}
        </div>
        {children}
      </div>
    </section>
  );
}
export default function Strategy({ data, period, open, registers, board }: PrototypeViewProps) {
  const { t } = useTranslation("boardPlans");
  const frame = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const host = frame.current;
    if (host) setRoot(host.shadowRoot || host.attachShadow({ mode: "open" }));
  }, []);
  const [tab, selectTab] = useState("");
  const [rank, setRank] = useState(false);
  const { t: caseText } = useTranslation("topicExample");
  const { topics, workers, depRanks, workerRanks } = strategyRows(data);
  const trend = useBoardTrends(data, board).data?.months.find((m) => m.month === data.month);
  const stats = data.strategy;
  const pct = stats.employee_target ? Math.round((stats.employee_built * 100) / stats.employee_target) : null;
  const months = Array.from(
    { length: Number(period.slice(5, 7)) },
    (_, i) => workers.filter((w) => Number(w.effective_date?.slice(5, 7)) === i + 1).length,
  );
  const topic = topics.find((t) => t.id === tab) || topics[0];
  const tabs = topics.map((t) => ({ id: t.id, name: t.name }));
  const selected = topic?.id;
  const ranks = rank ? workerRanks : depRanks;
  const detail = (key: string, title: string) => open("strategy:" + key, title);
  const topicTitle = topic?.name || "尚未登记专题";
  const launchTopic = () => detail("topic:" + selected, topicTitle + " · 专题资产明细");
  const categories = stats.knowledge_categories ?? [];
  const caseRow = registers
    .filter((r) => r.kind === "case" && r.parent_id === topic?.id && r.date <= data.cutoff)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))[0];
  const representative = data.assets.find((asset) => asset.kind === "employee" && asset.id === caseRow?.fields.assets);
  const hasSample = !!(caseRow?.fields.output || caseRow?.fields.sampleTable);
  const allCaseIds = strategyTopicAssets(data, registers, topic?.id);
  const topicAssets = data.assets.filter((a) => allCaseIds.has(a.id));
  const caseDepts = new Set(topicAssets.flatMap((a) => (a.department_id == null ? [] : [a.department_id])));
  return (
    <div ref={frame} id="strategy-cockpit">
      {root &&
        createPortal(
          <>
            <style>{frameCss}</style>
            <div className="page">
              <main className="shell">
                <div className="dashboard">
                  <Card cls="hero" title="年度数字员工建设计划" period="年度累计">
                    <div className="hero-grid">
                      <Hit
                        label="查看年度数字员工建设台账"
                        go={() => detail("annual", "年度数字员工建设台账")}
                      >
                        <div className="goal-label">已建成数字员工</div>
                        <div>
                          <strong className="numbers total" id="built">
                            {stats.employee_built}
                          </strong>{" "}
                          <span className="target">/ {stats.employee_target ?? missing} 位</span>
                        </div>
                        <div className="completion">
                          <span>年度完成率</span>
                          <b>{pct == null ? missing : pct + "%"}</b>
                        </div>
                        <div className="progress">
                          <div className="progress-bar" style={{ width: Math.min(pct || 0, 100) + "%" }} />
                        </div>
                      </Hit>
                      <div className="trend">
                        <div className="trend-header">
                          <span>月度新增</span>
                          <span>单位 · 位</span>
                        </div>
                        <div className="bars" id="bars">
                          {months.map((n, i) => (
                            <Hit
                              key={i}
                              cls="bar-col"
                              label={"查看" + (i + 1) + "月新增的数字员工"}
                              go={() => detail("month:" + (i + 1), i + 1 + " 月新增数字员工")}
                            >
                              <span>{n}</span>
                              <i style={{ height: (n * 86) / Math.max(1, ...months) + "%" }} />
                              <small>{i + 1}月</small>
                            </Hit>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Card>
                  <Card cls="goals" title="公司 AI 能力建设" period={data.year + " 年累计"}>
                    <div className="capacity-grid">
                      <div>
                        <Hit
                          cls="knowledge-summary"
                          label="查看年度重点知识接入清单"
                          go={() => detail("knowledge", "年度重点知识接入清单")}
                        >
                          <strong className="knowledge-label" id="knowledge-summary">
                            业务知识集接入
                          </strong>
                          <small>已接入 / 年度计划</small>
                          <span className="knowledge-total">
                            <b>{stats.knowledge_verified}</b> / {stats.knowledge_planned} 个
                          </span>
                        </Hit>
                        {!categories.length && <p className="knowledge-empty">{t("emptyCollections")}</p>}
                        <dl className="knowledge-details">
                          {categories.map((group) => {
                            const segments = Math.min(36, Math.max(1, group.target));
                            const filled = Math.ceil(segments * group.completed / Math.max(1, group.target));
                            return (
                            <div className="knowledge-row" key={group.id}>
                              <dt>{group.name}</dt>
                              <dd>
                                <span className="knowledge-segments" aria-hidden="true">
                                  {Array.from({ length: segments }, (_, i) => (
                                    <i key={i} className={i < filled ? "connected" : ""} />
                                  ))}
                                </span>
                                <span className="knowledge-number">{group.completed} / {group.target} 个</span>
                              </dd>
                            </div>
                            );
                          })}
                        </dl>
                      </div>
                      <div className="capacity-scenes">
                        <h3>业务场景</h3>
                        {[
                          [
                            "construction",
                            "年度计划已投产",
                            stats.scene_launched,
                            " / " + (stats.scene_target ?? missing) + " 个",
                          ],
                          [
                            "active",
                            "本年实际使用",
                            data.scene_usage?.filter((r) => r.year > 0).length ?? missing,
                            " 个",
                          ],
                        ].map(([key, name, n, unit]) => (
                          <button
                            key={key}
                            type="button"
                            className="capacity-scene-link"
                            data-capacity={key === "active" ? "active-scenes" : key}
                            onClick={() =>
                              detail(String(key), key === "active" ? "年度场景应用" : "年度场景建设台账")
                            }
                          >
                            <span>{name} ↗</span>
                            <strong>
                              <b>{n}</b>
                              <small>{unit}</small>
                            </strong>
                          </button>
                        ))}
                      </div>
                    </div>
                  </Card>
                  <section className="card inventory">
                    <div className="card-body" id="inventory">
                      <Hit
                        cls="inv-title"
                        label="查看全部 AI 资产"
                        go={() => detail("assets:all", "公司 AI 资产目录")}
                      >
                        <h2 className="card-title">公司 AI 资产概况</h2>
                        <div className="subtle">
                          截至 {data.catalog_as_of} · 当前目录 <b>{data.assets.length}</b> 项
                        </div>
                      </Hit>
                      {kinds.map((k) => (
                        <Hit
                          cls="stock"
                          key={k.kind}
                          label={"查看" + k.label + "目录"}
                          go={() => detail("assets:" + k.kind, k.label + "目录")}
                        >
                          <div className="type">
                            <i style={{ background: k.color }} />
                            {k.label}
                          </div>
                          <div className="num">
                            {data.assets.filter((a) => a.kind === k.kind).length}
                            <small className="stock-unit">{k.unit}</small>
                          </div>
                        </Hit>
                      ))}
                    </div>
                  </section>
                  <Card cls="feature" title="重点建设专题" period={topics.length + " 个已登记专题"}>
                    <div className="topic-tablist" id="topic-tabs">
                      {!tabs.length && <span className="period">尚未登记专题</span>}
                      {tabs.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={selected === t.id}
                          className={"topic-tab" + (selected === t.id ? " active" : "")}
                          onClick={() => selectTab(t.id)}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                    <div className="topic-stats">
                      <button className="text-btn" disabled={!topic} onClick={launchTopic}>
                        贡献部门 <strong>{caseDepts.size}</strong> 个
                      </button>
                      <button className="text-btn" disabled={!topic} onClick={launchTopic}>
                        已发布资产 <strong>{topicAssets.length}</strong> 项
                      </button>
                      <button className="text-btn" disabled={!topic} onClick={launchTopic}>
                        专题资产明细 ↗
                      </button>
                    </div>
                    <div className="brief" style={hasSample ? undefined : { gridTemplateColumns: "1fr" }}>
                      <div className="brief-copy">
                        <h3>{representative?.name || caseText("case")}</h3>
                        {representative ? <>
                          <p>{caseRow?.fields.summary || representative.description}</p>
                          <button className="btn btn-primary case-link" type="button"
                            onClick={() => open("asset:" + representative.id, representative.name)}>
                            {caseText("viewEmployee")} ↗
                          </button>
                        </> : <p>{caseText("empty")}</p>}
                      </div>
                      {hasSample && <div className="sample">
                        <div className="sample-head"><h4>{caseRow?.fields.sampleTitle || "案例输出"}</h4></div>
                        <CaseOutput fields={caseRow?.fields} empty="" />
                      </div>}
                    </div>
                  </Card>
                  <Card
                    cls="rank"
                    title="贡献与使用"
                    period={
                      <button
                        className="text-btn"
                        onClick={() =>
                          detail(
                            rank ? "worker-ranking" : "department-ranking",
                            rank ? "数字员工使用详榜" : "部门资产沉淀榜",
                          )
                        }
                      >
                        完整排行 ↗
                      </button>
                    }
                  >
                    <div className="segmented ranking-modes">
                      {["部门资产沉淀", "数字员工使用"].map((n, i) => (
                        <button
                          key={n}
                          className={"rank-tab" + (rank === Boolean(i) ? " active" : "")}
                          aria-pressed={rank === Boolean(i)}
                          onClick={() => setRank(Boolean(i))}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <div className="rank-period">
                      {rank ? period + " · 成功执行次数" : "本年度 · 首次发布的 AI 资产数"}
                    </div>
                    <div id="top-rows">
                      {rank ? (
                        <table className="wr-table">
                          <thead>
                            <tr>
                              {["排名", "数字员工", "使用次数", "好评率", "健康程度"].map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {workerRanks.slice(0, 3).map((r, i) => (
                              <tr key={r.id}>
                                <td>{workerRanks.findIndex((w) => w.count === r.count) + 1}</td>
                                <td>
                                  <button className="text-btn" onClick={() => open("asset:" + r.id, r.name)}>
                                    {r.name}
                                  </button>
                                </td>
                                <td>{workerRanks[i].count}</td>
                                <td>{percentage(aggregation(trend, r.id).rating)}</td>
                                <td>{aggregation(trend, r.id).health}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        depRanks.slice(0, 3).map((r) => (
                          <button
                            key={r.id}
                            className="rankline"
                            onClick={() => open("department:" + r.id, r.name)}
                          >
                            <span className="pos">{depRanks.findIndex((d) => d.count === r.count) + 1}</span>
                            <span>{r.name}</span>
                            <span className="rankval">
                              {r.count}
                              <small>项</small>
                            </span>
                          </button>
                        ))
                      )}
                      {!ranks.length && <div className="rank-period">所选期间暂无可核对的排行记录</div>}
                    </div>
                  </Card>
                </div>
              </main>
            </div>
          </>,
          root,
        )}
    </div>
  );
}
