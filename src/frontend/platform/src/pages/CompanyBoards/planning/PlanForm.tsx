import { Button } from "@bisheng/ui";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { userContext } from "@/contexts/userContext";
import { readCompanyPlan, type PlanItem } from "@/controllers/API/companyPlans";
import { PlanEditor, type Selection } from "./PlanEditor";
import "./plan.css";

interface Props {
  year: number;
  kind: "annual" | "knowledge";
}

export function PlanForm(props: Props) {
  return <PlanSheet key={props.kind + props.year} {...props} />;
}

function PlanSheet({ year, kind }: Props) {
  const { t } = useTranslation("boardPlans");
  const { user } = useContext(userContext);
  const plan = useQuery({
    queryKey: ["company-boards", "planning", user?.tenant_id, user?.user_id, year],
    queryFn: () => readCompanyPlan(year),
  });
  const [editing, setEditing] = useState<Selection | null>(null);
  if (plan.isError)
    return (
      <div className="plan-form" role="alert">
        {t("loadFailed")} <Button onClick={() => void plan.refetch()}>{t("retry")}</Button>
      </div>
    );
  if (!plan.data)
    return (
      <p className="plan-form" role="status">
        {t("loading")}
      </p>
    );
  const data = plan.data;
  const topics = data.items.filter((row) => row.kind === "topic");
  const scenes = data.items.filter((row) => row.kind === "scene");
  const collections = data.items.filter((row) => row.kind === "collection");
  const department = (id?: number | null) =>
    data.departments.find((d) => d.id === id)?.name ?? (id ? "#" + id : "—");
  const topicName = (id?: string) => topics.find((row) => row.id === id)?.name ?? "—";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const completed = (r: PlanItem) => !!r.completed_date && r.completed_date.startsWith(year + "-") && r.completed_date <= today;
  const annual = kind === "annual";
  const lines = annual ? scenes : collections;
  const addTopic = () => setEditing({ kind: "topic" });

  function table(rows: PlanItem[]) {
    if (!rows.length) return <p className="plan-empty">{t(annual ? "emptyScenes" : "emptyCollections")}</p>;
    return (
      <div className="plan-table-wrap">
        <table className="plan-table">
          <thead>
            <tr>
              <th>{t(annual ? "scene" : "collection")}</th>
              <th>{t("owner")}</th>
              <th>{t(annual ? "supports" : "topic")}</th>
              <th>{t("planned")}</th>
              <th>{t(annual ? "launch" : "verified")}</th>
              <th>{t(annual ? "status" : "knowledgeBase")}</th>
              <th>{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{department(row.department_id)}</td>
                <td>
                  {annual
                    ? [
                        ...new Set(
                          (row.supports || []).map((s) => department(s.department)),
                        ),
                      ].join(" / ") || "—"
                    : topicName(row.topic_id)}
                </td>
                <td>{row.planned_date || "—"}</td>
                <td>{row.completed_date || "—"}</td>
                <td>
                  {annual
                    ? t(
                        completed(row)
                          ? "launched"
                          : row.planned_date && row.planned_date < today
                            ? "overdue"
                            : "pending",
                      )
                    : data.knowledge.find((k) => k.id === row.asset_key)?.name || row.asset_key || "—"}
                </td>
                <td>
                  <Button
                    variant="text"
                    onClick={() => setEditing({ kind: row.kind, item: row })}
                    aria-label={t("editNamed", { name: row.name })}
                  >
                    {t("edit")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="plan-form">
      <section className="plan-panel">
        <div className="plan-panel-heading">
          <h2>{t(annual ? "yearTargets" : "accessProgress")}</h2>
          {annual && <Button onClick={() => setEditing({ kind: "targets" })}>{t("editTargets")}</Button>}
        </div>
        <dl className="plan-metrics">
          {annual ? (
            <>
              <div>
                <dt>{t("staffBuilt")}</dt>
                <dd>
                  {data.built} <small>/ {data.targets.employee ?? "—"}</small>
                </dd>
              </div>
              <div>
                <dt>{t("scenesLaunched")}</dt>
                <dd>
                  {scenes.filter(completed).length} <small>/ {data.targets.scene ?? "—"}</small>
                </dd>
              </div>
            </>
          ) : (
            <div>
              <dt>{t("accessVerified")}</dt>
              <dd>
                {collections.filter(completed).length} <small>/ {collections.length}</small>
              </dd>
            </div>
          )}
        </dl>
      </section>
      <section className="plan-panel">
        <div className="plan-panel-heading">
          <h2>{t(annual ? "topicPlans" : "categoryPlans")}</h2>
          {annual || !topics.length ? (
            <Button color="primary" variant="solid" onClick={addTopic}>
              {t("addTopic")}
            </Button>
          ) : (
            <Button color="primary" variant="solid" onClick={() => setEditing({ kind: "collection" })}>
              {t("addCollection")}
            </Button>
          )}
        </div>
        {annual ? (
          topics.length ? (
            topics.map((topic) => {
              const rows = scenes.filter((r) => r.topic_id === topic.id);
              return (
                <section className="plan-topic" key={topic.id}>
                  <div className="plan-topic-heading">
                    <div>
                      <h3>{topic.name}</h3>
                      <span>
                        {t("sceneCount", { count: rows.length, done: rows.filter(completed).length })}
                      </span>
                    </div>
                    <div className="plan-actions">
                      <Button variant="text" onClick={() => setEditing({ kind: "topic", item: topic })}>
                        {t("editTopic")}
                      </Button>
                      <Button onClick={() => setEditing({ kind: "scene", topic: topic.id })}>
                        {t("addScene")}
                      </Button>
                    </div>
                  </div>
                  {table(rows)}
                </section>
              );
            })
          ) : (
            <p className="plan-empty">{t("emptyTopics")}</p>
          )
        ) : (
          [...new Set(lines.map((r) => r.category || ""))].map((category) => (
            <section className="plan-topic" key={category}>
              <div className="plan-topic-heading">
                <h3>{category || t("uncategorized")}</h3>
              </div>
              {table(lines.filter((r) => (r.category || "") === category))}
            </section>
          ))
        )}
        {!annual && !lines.length && (
          <p className="plan-empty">{t(topics.length ? "emptyCollections" : "knowledgeNeedsTopic")}</p>
        )}
      </section>
      {editing && <PlanEditor year={year} data={data} selection={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
