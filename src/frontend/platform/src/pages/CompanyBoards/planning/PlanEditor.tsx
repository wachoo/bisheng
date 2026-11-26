import { createUuid } from "@/util/uuid";
import { Button, Input, Modal, Select } from "@bisheng/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import {
  saveCompanyPlan,
  type PlanData,
  type PlanEdit,
  type PlanItem,
  type PlanPeriod,
  type SupportPeriod,
} from "@/controllers/API/companyPlans";
import { showApiError } from "@/controllers/request";

export interface Selection {
  kind: PlanItem["kind"] | "targets";
  item?: PlanItem;
  topic?: string;
}

interface Props {
  year: number;
  data: PlanData;
  selection: Selection;
  onClose: () => void;
}

export function PlanEditor({ year, data, selection, onClose }: Props) {
  const { t } = useTranslation("boardPlans");
  const labels = useSelectLabels();
  const cache = useQueryClient();
  const { kind, item } = selection;
  const [name, setName] = useState(item?.name || "");
  const [employee, setEmployee] = useState(data.targets.employee?.toString() ?? "");
  const [scene, setScene] = useState(data.targets.scene?.toString() ?? "");
  const [topic, setTopic] = useState(item?.topic_id || selection.topic || "");
  const [owner, setOwner] = useState(item?.department_id || 0);
  const [planned, setPlanned] = useState(item?.planned_date || "");
  const [completed, setCompleted] = useState(item?.completed_date || "");
  const [target, setTarget] = useState(item?.target?.toString() ?? "");
  const [supports, setSupports] = useState<(SupportPeriod & { key: string })[]>(() =>
    (item?.supports || []).map((s) => ({ ...s, key: s.id! })),
  );
  const [recognition, setRecognition] = useState<(PlanPeriod & { key: string })[]>(() =>
    (item?.recognition || []).map((s) => ({ ...s, key: s.id! })),
  );
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (input: PlanEdit) => saveCompanyPlan(year, input),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["company-boards"] });
      onClose();
    },
    onError: (err: unknown) => {
      setError(t("saveFailed"));
      showApiError(err);
    },
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const start = year + "-01-01",
    end = year + "-12-31";
  const departments = data.departments.map((d) => ({ value: String(d.id), label: d.name }));
  for (const id of [item?.department_id, ...(item?.supports || []).map((s) => s.department)]) {
    if (id && !departments.some((d) => d.value === String(id)))
      departments.push({ value: String(id), label: t("archivedUnit", { id }) });
  }
  function save(e: FormEvent) {
    e.preventDefault();
    if (mutation.isLoading) return;
    setError("");
    if (kind === "targets") {
      if (
        (!employee && !scene) ||
        (data.targets.employee != null && !employee) ||
        (data.targets.scene != null && !scene)
      ) {
        setError(t("targetRequired"));
        return;
      }
      mutation.mutate({
        kind,
        version: data.targets.version,
        employee: employee ? Number(employee) : null,
        scene: scene ? Number(scene) : null,
      });
      return;
    }
    if (!name.trim()) {
      setError(t("nameRequired"));
      return;
    }
    const base = { id: item?.id || null, version: item?.version || null, name: name.trim() };
    if (kind === "topic") {
      mutation.mutate({ ...base, kind });
      return;
    }
    if (kind === "collection") {
      if (!planned || !target || !Number.isInteger(Number(target)) || Number(target) < 0) {
        setError(t("knowledgeRequired"));
        return;
      }
      mutation.mutate({ ...base, kind, target: Number(target), planned_date: planned });
      return;
    }
    if (!topic || !owner || (!item && !planned)) {
      setError(t("scopeRequired"));
      return;
    }
    const common = {
      ...base,
      topic_id: topic,
      department_id: owner,
      planned_date: planned || null,
      completed_date: completed || null,
    };
    if (supports.some((s) => !s.department || s.department === owner || !s.start)) {
      setError(t("supportRequired"));
      return;
    }
    if (
      supports.some((s, i) =>
        supports
          .slice(0, i)
          .some(
            (p) =>
              p.department === s.department && (!s.end || p.start <= s.end) && (!p.end || s.start <= p.end),
          ),
      )
    ) {
      setError(t("supportOverlap"));
      return;
    }
    const range = (v: PlanPeriod) => ({ id: v.id, start: v.start, end: v.end || null });
    mutation.mutate({
      ...common,
      kind,
      supports: supports.map((s) => ({ ...range(s), department: s.department })),
      recognition: recognition.map(range),
    });
  }
  return (
    <Modal
      size={kind === "scene" ? "large" : "medium"}
      open
      title={t(kind === "targets" ? "editTargets" : (item ? "edit_" : "new_") + kind)}
      closeLabel={t("cancel")}
      submitting={mutation.isLoading}
      onOpenChange={(open) => {
        if (!open && !mutation.isLoading) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isLoading}>
            {t("cancel")}
          </Button>
          <Button
            form="company-plan-edit"
            type="submit"
            color="primary"
            variant="solid"
            disabled={mutation.isLoading}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <form id="company-plan-edit" className="plan-editor" onSubmit={save}>
        {kind === "targets" ? (
          <div className="plan-field-pair">
            <label htmlFor="plan-employees">
              {t("employeeTarget")}
              <Input
                id="plan-employees"
                type="number"
                min="0"
                max="100000000"
                step="1"
                value={employee}
                onChange={(e) => setEmployee(e.target.value)}
              />
            </label>
            <label htmlFor="plan-scenes">
              {t("sceneTarget")}
              <Input
                id="plan-scenes"
                type="number"
                min="0"
                max="100000000"
                step="1"
                value={scene}
                onChange={(e) => setScene(e.target.value)}
              />
            </label>
          </div>
        ) : (
          <>
            <label htmlFor="plan-name">
              {t(kind === "collection" ? "category" : kind + "Name")} *
              <Input
                id="plan-name"
                autoFocus
                required
                maxLength={kind === "collection" ? 80 : 160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {kind === "collection" && (
              <div className="plan-field-pair">
                <label htmlFor="plan-quantity">{t("quantity")} *
                  <Input id="plan-quantity" type="number" min={0} max={100000000} step={1} required
                    value={target} onChange={e => setTarget(e.target.value)} />
                </label>
                <label htmlFor="plan-date">{t("planned")} *
                  <Input id="plan-date" type="date" min={start} max={end} required
                    value={planned} onChange={e => setPlanned(e.target.value)} />
                </label>
              </div>
            )}
            {kind === "scene" && (
              <>
                <div className="plan-field-pair">
                  <div>
                    <label htmlFor="plan-topic">{t("topic")} *</label>
                    <Select
                      {...labels}
                      id="plan-topic"
                      showSearch
                      value={topic || null}
                      options={data.items
                        .filter((r) => r.kind === "topic")
                        .map((r) => ({ value: r.id, label: r.name }))}
                      onChange={(v) => setTopic(String(v || ""))}
                    />
                  </div>
                  <div>
                    <label htmlFor="plan-owner">{t("owner")} *</label>
                    <Select
                      {...labels}
                      id="plan-owner"
                      showSearch
                      value={owner ? String(owner) : null}
                      options={departments}
                      onChange={(v) => setOwner(Number(v))}
                    />
                  </div>
                </div>
                <div className="plan-field-pair">
                  <label htmlFor="plan-date">
                    {t("planned")}
                    {item ? "" : " *"}
                    <Input
                      id="plan-date"
                      type="date"
                      min={start}
                      max={end}
                      required={!item}
                      value={planned}
                      onChange={(e) => setPlanned(e.target.value)}
                    />
                  </label>
                  <label htmlFor="plan-actual">
                    {t("launch")}
                    <Input
                      id="plan-actual"
                      type="date"
                      min={start}
                      max={today < end ? today : end}
                      value={completed}
                      onChange={(e) => setCompleted(e.target.value)}
                    />
                  </label>
                </div>
                <fieldset>
                  <legend>{t("supports")}</legend>
                  {supports.map((s, i) => (
                    <div className="plan-support" key={s.key}>
                      <div>
                        <label htmlFor={"support-" + s.key}>{t("supportOrg")}</label>
                        <Select
                          id={"support-" + s.key}
                          {...labels}
                          showSearch
                          options={departments.filter((d) => d.value !== String(owner))}
                          value={s.department ? String(s.department) : null}
                          onChange={(v) =>
                            setSupports(
                              supports.map((r, j) => (j === i ? { ...r, department: Number(v) } : r)),
                            )
                          }
                        />
                      </div>
                      <label>
                        {t("from")}
                        <Input
                          type="date"
                          min={start}
                          max={end}
                          required
                          value={s.start}
                          onChange={(e) =>
                            setSupports(
                              supports.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)),
                            )
                          }
                        />
                      </label>
                      <label>
                        {t("until")}
                        <Input
                          type="date"
                          min={s.start || start}
                          value={s.end || ""}
                          onChange={(e) =>
                            setSupports(
                              supports.map((r, j) =>
                                j === i ? { ...r, end: e.target.value || null } : r,
                              ),
                            )
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        variant="text"
                        onClick={() => setSupports(supports.filter((r) => r.key !== s.key))}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    onClick={() =>
                      setSupports([
                        ...supports,
                        { key: createUuid(), department: 0, start, end: null },
                      ])
                    }
                  >
                    {t("addSupport")}
                  </Button>
                </fieldset>
                <fieldset>
                  <legend>{t("recognition")}</legend>
                  {recognition.map((r, i) => (
                    <div className="plan-range" key={r.key}>
                      <label>
                        {t("from")}
                        <Input
                          type="date"
                          min={start}
                          max={end}
                          required
                          value={r.start}
                          onChange={(e) =>
                            setRecognition(
                              recognition.map((v, j) => (j === i ? { ...v, start: e.target.value } : v)),
                            )
                          }
                        />
                      </label>
                      <label>
                        {t("until")}
                        <Input
                          type="date"
                          min={r.start || start}
                          value={r.end || ""}
                          onChange={(e) =>
                            setRecognition(
                              recognition.map((v, j) =>
                                j === i ? { ...v, end: e.target.value || null } : v,
                              ),
                            )
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        variant="text"
                        onClick={() => setRecognition(recognition.filter((v) => v.key !== r.key))}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    onClick={() =>
                      setRecognition([
                        ...recognition,
                        {
                          key: createUuid(),
                          start: today >= start && today <= end ? today : start,
                          end: null,
                        },
                      ])
                    }
                  >
                    {t("addRecognition")}
                  </Button>
                </fieldset>
              </>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
