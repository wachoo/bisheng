import { createUuid } from "@/util/uuid";
import { Button, Checkbox, Input, Select } from "@bisheng/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import {
  metricGroups,
  saveResearchReport,
  useResearchReport,
  type ReportMetric,
  type ResearchReport,
  type ResearchSubject,
} from "@/controllers/API/companyResearchReport";
import { showApiError } from "@/controllers/request";
import { currentBoardMonth } from "./boardPeriod";

const integerMetrics = new Set<ReportMetric>([
  "projects",
  "ai_projects",
  "active_ai_projects",
  "valued_scenes",
]);
const countValue = (raw: string | number | null) => (raw == null || raw === "" ? null : Number(raw));

function ReportEditor({ report, onSaved }: { report: ResearchReport; onSaved: () => void }) {
  const { t } = useTranslation("researchReport");
  const cache = useQueryClient();
  const [metrics, setMetrics] = useState(report.metrics);
  const [subjects, setSubjects] = useState(report.subjects);
  const pageSize = 5;
  const [subjectPage, setSubjectPage] = useState(1);
  const pages = Math.max(1, Math.ceil(subjects.length / pageSize));
  const page = Math.min(subjectPage, pages);
  const visibleSubjects = subjects.slice((page - 1) * pageSize, page * pageSize);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const updateSubject = (id: string, fields: Partial<ResearchSubject>) => {
    setSubjects((current) => current.map((row) => (row.id === id ? { ...row, ...fields } : row)));
    setDirty(true);
  };
  const mutation = useMutation({
    mutationFn: saveResearchReport,
    onError: showApiError,
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["company-boards", "research-report"] });
      onSaved();
    },
  });
  const current = currentBoardMonth();
  const through = new Date(Date.UTC(report.year, report.month, 0)).toISOString().slice(0, 10);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const total = countValue(metrics.projects),
      ai = countValue(metrics.ai_projects),
      active = countValue(metrics.active_ai_projects);
    const counts = [total, ai, active].filter((value): value is number => value !== null);
    const errorKey =
      counts.some((value, index) => index > 0 && value > counts[index - 1])
        ? "invalidCounts"
        : subjects.some(
              (s) =>
                !s.name.trim() ||
                !s.project.trim() ||
                !s.start ||
                (s.end && s.end < s.start) ||
                s.start > through ||
                (s.end && s.end < report.year + "-01-01"),
            )
          ? "invalidSubject"
          : "";
    setError(errorKey);
    if (errorKey) return;
    mutation.mutate({ year: report.year, month: report.month, revision: report.revision, metrics, subjects });
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      {(["projects", "finance", "value"] as const).map((group) => (
        <fieldset key={group} className="rounded-xl border border-border-base p-4">
          <legend className="px-2 font-medium text-text-1">{t("groups." + group)}</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {metricGroups[group].map((key) => (
              <label
                key={key}
                className="flex flex-col gap-2 text-sm text-text-2"
                htmlFor={"research-" + key}
              >
                {t("metrics." + key)}
                <Input
                  id={"research-" + key}
                  type="number"
                  min={key === "spending" ? undefined : 0}
                  max={integerMetrics.has(key) ? 100000000 : undefined}
                  step={integerMetrics.has(key) ? 1 : 0.0001}
                  value={metrics[key] ?? ""}
                  placeholder={t("notEntered")}
                  onChange={(e) => {
                    setMetrics({ ...metrics, [key]: e.target.value === "" ? null : e.target.value });
                    setDirty(true);
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <fieldset className="rounded-xl border border-border-base p-4">
        <legend className="px-2 font-medium text-text-1">{t("subjects")}</legend>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text-2">
            {t("subjectCount", { all: subjects.length, ai: subjects.filter((s) => s.ai).length })}
          </p>
          <Button
            type="button"
            onClick={() => {
              setSubjects([
                ...subjects,
                { id: createUuid(), name: "", project: "", ai: false, start: "", end: null },
              ]);
              setSubjectPage(Math.ceil((subjects.length + 1) / pageSize));
              setDirty(true);
            }}
          >
            {t("addSubject")}
          </Button>
        </div>
        {visibleSubjects.map((row, i) => (
          <div
            key={row.id}
            className="mt-4 grid gap-3 border-t border-border-base pt-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {(["name", "project", "start", "end"] as const).map((k) => (
              <label
                key={k}
                htmlFor={"research-subject-" + row.id + k}
                className="flex flex-col gap-1 text-sm text-text-2"
              >
                {t("fields." + k)}
                {k !== "end" && " *"}
                <Input
                  id={"research-subject-" + row.id + k}
                  required={k !== "end"}
                  type={k === "start" || k === "end" ? "date" : "text"}
                  maxLength={160}
                  max={
                    k === "start"
                      ? current === through.slice(0, 7)
                        ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
                        : through
                      : undefined
                  }
                  min={k === "end" ? row.start || undefined : undefined}
                  value={row[k] ?? ""}
                  onChange={(e) =>
                    updateSubject(row.id, { [k]: k === "end" ? e.target.value || null : e.target.value })
                  }
                />
              </label>
            ))}
            <div className="flex items-center gap-4 sm:col-span-2">
              <Checkbox
                checked={row.ai}
                label={t("fields.ai")}
                onCheckedChange={(v) => updateSubject(row.id, { ai: v === true })}
              />
              <Button
                type="button"
                variant="text"
                aria-label={t("removeNamed", { name: row.name || i + 1 })}
                onClick={() => {
                  setSubjects(subjects.filter((s) => s.id !== row.id));
                  setDirty(true);
                }}
              >
                {t("remove")}
              </Button>
            </div>
          </div>
        ))}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-3 text-sm text-text-2">
            <Button type="button" disabled={page === 1} onClick={() => setSubjectPage(page - 1)}>
              {t("previous")}
            </Button>
            <span>
              {page} / {pages}
            </span>
            <Button type="button" disabled={page === pages} onClick={() => setSubjectPage(page + 1)}>
              {t("next")}
            </Button>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-error-foreground">
          {t(error)}
        </p>
      )}
      <Button
        type="submit"
        color="primary"
        variant="solid"
        loading={mutation.isLoading}
        disabled={mutation.isLoading || (!dirty && report.source_month === report.month)}
      >
        {t("save")}
      </Button>
    </form>
  );
}

export function ResearchOperationsForm({ year }: { year: number }) {
  const { t } = useTranslation("researchReport");
  const labels = useSelectLabels();
  const [thisYear, thisMonth] = currentBoardMonth().split("-").map(Number);
  const lastMonth = year === thisYear ? thisMonth : 12;
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get("month"));
  const month =
    Number.isInteger(requested) && requested >= 1 && requested <= lastMonth ? requested : lastMonth;
  const [saved, setSaved] = useState("");
  const report = useResearchReport("manage", year, month, year <= thisYear);
  if (year > thisYear) return <p className="text-sm text-text-2">{t("futureYear")}</p>;
  return (
    <section className="cb-panel space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="research-month">{t("month")}</label>
        <Select
          {...labels}
          id="research-month"
          className="w-28"
          value={String(month)}
          options={Array.from({ length: lastMonth }, (_, i) => ({
            value: String(i + 1),
            label: t("monthName", { month: i + 1 }),
          }))}
          onChange={(v) => {
            if (v === null) return;
            setSaved("");
            const next = new URLSearchParams(params);
            next.set("month", String(v));
            setParams(next);
          }}
        />
        {report.data && (
          <p className="text-sm text-text-2">
            {t(
              report.data.source === "direct" ? "asOf" : report.data.source === "legacy" ? "legacy" : "empty",
              { year, month: report.data.source_month },
            )}
          </p>
        )}
      </div>
      {report.isError ? (
        <Button onClick={() => void report.refetch()}>{t("retry")}</Button>
      ) : report.data ? (
        <ReportEditor
          key={[year, month, report.data.revision].join("-")}
          report={report.data}
          onSaved={() => setSaved(year + "-" + month)}
        />
      ) : (
        <p role="status">{t("loading")}</p>
      )}
      {saved === year + "-" + month && (
        <p role="status" className="text-sm text-text-2">
          {t("saved")}
        </p>
      )}
    </section>
  );
}
