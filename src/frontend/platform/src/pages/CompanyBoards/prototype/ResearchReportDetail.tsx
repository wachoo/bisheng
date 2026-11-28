import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useResearchReport, type ReportMetric } from "@/controllers/API/companyResearchReport";

const routes = {
  research: ["projects", "ai_projects", "active_ai_projects"],
  spending: ["spending"],
  budget: ["active_ai_projects", "budget"],
  receivables: ["outstanding"],
  forecast: ["valued_scenes", "labor_value", "direct_savings"],
} as const;

type ReportView = keyof typeof routes;
export function isReportView(value: string): value is ReportView {
  return Object.prototype.hasOwnProperty.call(routes, value);
}
function display(value: number | string | null) {
  return value === null ? "—" : Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function ResearchReportDetail({
  year,
  month,
  view,
  subjectTab,
  cutoff,
}: {
  year: number;
  month: number;
  view: ReportView;
  subjectTab: boolean;
  cutoff: string;
}) {
  const { t } = useTranslation("researchReport");
  const query = useResearchReport("lead", year, month);
  const [tab, setTab] = useState<"projects" | "subjects">(subjectTab ? "subjects" : "projects");
  if (query.isError)
    return (
      <button className="al-button" onClick={() => void query.refetch()}>
        {t("retry")}
      </button>
    );
  if (!query.data) return <p role="status">{t("loading")}</p>;
  const report = query.data,
    m = report.metrics;
  const values: [string, string][] = routes[view].map((key: ReportMetric): [string, string] => [
    t("metrics." + key),
    display(m[key]),
  ]);
  if (view === "forecast") {
    const sum =
      m.labor_value != null && m.direct_savings != null
        ? Number(m.labor_value) + Number(m.direct_savings)
        : null;
    values.push([t("forecastTotal"), display(sum)]);
  }
  const subjects = report.subjects;
  const countAi = subjects.filter((r) => r.ai).length;
  const ratio = (n: number | string | null, d: number | string | null) =>
    n != null && d != null && Number(d) > 0
      ? ((100 * Number(n)) / Number(d)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%"
      : "—";
  if (view === "research") {
    if (tab === "projects") values.push([t("projectShare"), ratio(m.ai_projects, m.projects)]);
    else
      values.splice(
        0,
        values.length,
        [t("allSubjects"), display(subjects.length)],
        [t("aiSubjects"), display(countAi)],
        [t("subjectShare"), ratio(countAi, subjects.length)],
      );
  }
  return (
    <section className="al-panel">
      <div className="al-panel-head">
        <h3>{t("views." + view)}</h3>
        <span className="al-caption">
          {t(report.source === "direct" ? "asOf" : report.source === "legacy" ? "legacy" : "empty", {
            year,
            month: report.source_month,
          })}
        </span>
      </div>
      {view === "research" && (
        <div className="al-tabs">
          {(["projects", "subjects"] as const).map((k) => (
            <button type="button" key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
              {t("tabs." + k)}
            </button>
          ))}
        </div>
      )}
      <div className="al-stats">
        {values.map(([label, value]) => (
          <div className="al-stat" key={label}>
            <span className="al-stat-name">{label}</span>
            <strong className="al-stat-value">{value}</strong>
          </div>
        ))}
      </div>
      {view === "research" && tab === "subjects" && (
        <div className="al-table-wrap">
          <table>
            <thead>
              <tr>
                {["name", "project", "ai", "start", "end", "status"].map((k) => (
                  <th key={k}>{t("fields." + k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.project}</td>
                  <td>{t(s.ai ? "yes" : "no")}</td>
                  <td>{s.start}</td>
                  <td>{s.end || "—"}</td>
                  <td>{t(s.end && s.end <= cutoff ? "closed" : "active")}</td>
                </tr>
              ))}
              {!subjects.length && (
                <tr>
                  <td colSpan={6} className="al-empty">
                    {t("noSubjects")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
