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
  const keepOriginalOwner = item?.kind === "scene" && item.department_id == null;
  const [planned, setPlanned] = useState(item?.planned_date || "");
  const [completed, setCompleted] = useState(item?.completed_date || "");
  const [target, setTarget] = useState(item?.target?.toString() ?? "");
  const [supports, setSupports] = useState<string[]>(() =>
    Array.from(new Set(item?.support_department_ids ?? (item?.supports ?? []).map(s => s.department)), String),
  );
  const [assetKeys, setAssetKeys] = useState<string[]>(item?.asset_keys ?? []);
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (input: PlanEdit) => saveCompanyPlan(year, input),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["company-boards"] });
      if (kind === "scene") {
        await Promise.all([
          cache.invalidateQueries({ queryKey: ["company-board-monitoring"] }),
          cache.invalidateQueries({ queryKey: ["monitor-issues"] }),
        ]);
      }
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
  const catalogOptions = (data.assets ?? []).map(asset => ({
    value: asset.id,
    label: asset.name + " · " + t("assetType." + asset.id.split(":")[0]),
  }));
  const optionCounts = new Map<string, number>();
  for (const { label } of catalogOptions) optionCounts.set(label, (optionCounts.get(label) ?? 0) + 1);
  const assetOptions = catalogOptions.map(option => optionCounts.get(option.label)! > 1
    ? { ...option, label: option.label + " · " + option.value }
    : option);
  for (const key of assetKeys) {
    if (!assetOptions.some(option => option.value === key)) {
      assetOptions.push({ value: key, label: t("unlistedAsset", { id: key }) });
    }
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
    if (!topic || (!owner && !keepOriginalOwner) || (!item && !planned)) {
      setError(t("scopeRequired"));
      return;
    }
    const common = {
      ...base,
      topic_id: topic,
      department_id: owner || null,
      planned_date: planned || null,
      completed_date: completed || null,
    };
    mutation.mutate({
      ...common,
      kind,
      support_department_ids: supports.map(Number),
      asset_keys: assetKeys,
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
                    <label htmlFor="plan-owner">{t("owner")}{keepOriginalOwner ? "" : " *"}</label>
                    <Select
                      {...labels}
                      id="plan-owner"
                      showSearch
                      placeholder={keepOriginalOwner ? t("keepOriginalOwner") : undefined}
                      value={owner ? String(owner) : null}
                      options={departments}
                      onChange={(v) => {
                        setOwner(Number(v));
                        setSupports(ids => ids.filter(id => id !== String(v)));
                      }}
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
                <div>
                  <label htmlFor="plan-supports">{t("supports")}</label>
                  <Select
                    {...labels} id="plan-supports" multiple showSearch allowClear
                    aria-label={t("supports")} value={supports}
                    options={departments.filter(d => d.value !== String(owner))}
                    onChange={values => setSupports(values.map(String))}
                  />
                </div>
                <div>
                  <label htmlFor="plan-assets">{t("linkedAssets")}</label>
                  <Select
                    {...labels} id="plan-assets" multiple showSearch allowClear
                    aria-label={t("linkedAssets")} value={assetKeys} options={assetOptions}
                    placeholder={t("chooseAssets")}
                    onChange={values => setAssetKeys(values.map(String))}
                  />
                </div>
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
