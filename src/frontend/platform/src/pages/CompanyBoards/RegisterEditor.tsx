import { Button, Input, Modal, Select, Textarea } from "@bisheng/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import type { BoardOverview } from "@/controllers/API/companyBoards";
import {
  saveBoardRegister,
  type SupplementalRow,
  type SupplementKind,
} from "@/controllers/API/companyRegisters";
import { showApiError } from "@/controllers/request";
import { supplementForms } from "./RegisterDefinitions";
import { caseTableClipboard, caseTableError, parseCasePaste, savedCaseTable } from "./caseTable";
import { CaseGrid } from "./CaseOutput";

interface Props {
  kind: SupplementKind;
  overview: BoardOverview;
  records: SupplementalRow[];
  existing?: SupplementalRow;
  onClose: () => void;
  onSaved: () => void;
}
export function RegisterEditor({ kind, overview, records, existing, onClose, onSaved }: Props) {
  const { t } = useTranslation("companyBoards");
  const labels = useSelectLabels();
  const cache = useQueryClient();
  const spec = supplementForms[kind];
  const [id] = useState(() => existing?.id || crypto.randomUUID());
  const [name, setName] = useState(existing?.name || "");
  const [date, setDate] = useState(existing?.date || "");
  const [parent, setParent] = useState(existing?.parent_id || "");
  const [fields, setFields] = useState<Record<string, string>>(existing?.fields || {});
  const [paste, setPaste] = useState(() => caseTableClipboard(savedCaseTable(existing?.fields.sampleTable)));
  let grid: string[][] = [],
    gridError: string | null = null;
  try {
    grid = parseCasePaste(paste);
    gridError = caseTableError(grid);
  } catch {
    gridError = "quote";
  }
  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));
  const mutation = useMutation({
    mutationFn: saveBoardRegister,
    onError: showApiError,
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["company-boards"] });
      onSaved();
      onClose();
    },
  });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    mutation.mutate({
      id,
      kind,
      revision: existing?.revision || 0,
      year: overview.year,
      date,
      parent_id: parent || null,
      name: name.trim(),
      fields: Object.fromEntries(
        Object.entries(
          kind === "case" ? { ...fields, sampleTable: grid.length ? JSON.stringify(grid) : "" } : fields,
        )
          .filter(([, v]) => v.trim())
          .map(([k, v]) => [k, v.trim()]),
      ),
    });
  };
  const ready = Boolean(
    name.trim() &&
      date &&
      date.slice(0, 4) === String(overview.year) &&
      (!fields.end || fields.end >= date) &&
      (!spec.parent || parent) &&
      spec.required.every((key) => fields[key]?.trim()) &&
      (kind !== "asset-profile" || Object.values(fields).some((v) => v.trim())) &&
      !gridError &&
      !mutation.isLoading,
  );
  const opts = (rows: { id: string; name: string }[]) => rows.map((r) => ({ value: r.id, label: r.name }));
  const assets = opts(overview.assets);
  const parentOpts =
    spec.parent === "asset"
      ? assets
      : spec.parent === "project" || spec.parent === "receivable"
        ? opts(records.filter((r) => r.kind === spec.parent))
        : opts(overview.ledger.filter((r) => r.kind === spec.parent));
  const fieldTitle = (key: string) =>
    t("registers.fields." + (key === "amount" && kind === "expense" ? "signed" : key));
  const pick = (key: string) => {
    if (key === "ai") return ["yes", "no"];
    if (key === "category" && kind === "value-rate") return ["document", "image", "page", "other"];
    if (key === "unit") return ["file", "version"];
    return null;
  };
  return (
    <Modal
      open
      title={t(existing ? "editEntry" : "newEntry")}
      closeLabel={t("close")}
      submitting={mutation.isLoading}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isLoading}>
            {t("cancel")}
          </Button>
          <Button
            color="primary"
            variant="solid"
            form="board-register-editor"
            type="submit"
            disabled={!ready}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <form id="board-register-editor" className="cb-form" onSubmit={save}>
        <div>
          <label htmlFor="br-name">{t("name")} *</label>
          <Input
            id="br-name"
            autoFocus
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="br-date">{t("registers.dates." + kind)} *</label>
          <Input
            id="br-date"
            type="date"
            min={overview.year + "-01-01"}
            max={overview.year + "-12-31"}
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {spec.parent && (
          <div>
            <label htmlFor="br-parent">{t("registers.parents." + spec.parent)} *</label>
            <Select
              id="br-parent"
              {...labels}
              showSearch
              placeholder={t("chooseParent")}
              value={parent || null}
              disabled={Boolean(existing)}
              options={parentOpts}
              onChange={(value) => {
                setParent(String(value || ""));
                if (kind === "case") setField("scene", "");
              }}
            />
            {!parentOpts.length && (
              <p className="cb-note">
                {t("registers.missingParent", { name: t("registers.parents." + spec.parent) })}
              </p>
            )}
          </div>
        )}
        {spec.fields.map((key) => {
          const value = fields[key] || "",
            inputId = "br-" + key,
            required = spec.required.includes(key);
          const enumerated = pick(key);
          let field;
          if (key === "assets")
            field = (
              <Select
                {...labels}
                id={inputId}
                multiple
                showSearch
                value={value.split(",").filter(Boolean)}
                options={assets}
                onChange={(values) => setField(key, values.join(","))}
              />
            );
          else if (enumerated || key === "scene" || key === "asset" || key === "department")
            field = (
              <Select
                {...labels}
                id={inputId}
                value={value || null}
                options={
                  enumerated
                    ? enumerated.map((v) => ({ value: v, label: t("registers.options." + v) }))
                    : key === "department"
                      ? overview.departments.map((d) => ({ value: String(d.id), label: d.name }))
                      : key === "asset"
                        ? assets
                        : opts(overview.ledger.filter((r) => r.kind === "scene" && r.parent_id === parent))
                }
                onChange={(v) => setField(key, String(v ?? ""))}
              />
            );
          else if (key === "sampleTable")
            field = (
              <>
                <Textarea
                  id={inputId}
                  rows={5}
                  value={paste}
                  maxLength={30000}
                  aria-describedby="br-paste-help"
                  onChange={(e) => setPaste(e.target.value)}
                />
                <p id="br-paste-help" className="cb-note">
                  {t("registers.sample.help")}
                </p>
                {gridError ? (
                  <p role="alert" className="cb-note">
                    {t("registers.sample." + gridError)}
                  </p>
                ) : (
                  Boolean(grid.length) && (
                    <div className="cb-table-wrap">
                      <CaseGrid rows={grid} />
                    </div>
                  )
                )}
              </>
            );
          else if (["summary", "input", "output", "description", "rules"].includes(key))
            field = (
              <Textarea
                id={inputId}
                value={value}
                maxLength={key === "summary" ? 512 : 2048}
                rows={3}
                required={required}
                onChange={(e) => setField(key, e.target.value)}
              />
            );
          else if (key === "end")
            field = (
              <Input
                id={inputId}
                type="date"
                min={date || undefined}
                value={value}
                onChange={(e) => setField(key, e.target.value)}
              />
            );
          else if (["hours", "hourly", "saving", "amount", "budget"].includes(key))
            field = (
              <Input
                id={inputId}
                type="number"
                required={required}
                step="0.0001"
                min={kind === "expense" ? -1e14 : 0}
                max={1e14}
                value={value}
                onChange={(e) => setField(key, e.target.value)}
              />
            );
          else
            field = (
              <Input
                id={inputId}
                maxLength={key === "sampleTitle" ? 100 : key === "action" ? 40 : 2048}
                required={required}
                value={value}
                onChange={(e) => setField(key, e.target.value)}
              />
            );
          return (
            <div key={key}>
              <label htmlFor={inputId}>
                {fieldTitle(key)}
                {required ? " *" : ""}
              </label>
              {field}
            </div>
          );
        })}
        {mutation.isError && (
          <p className="cb-note" role="alert">
            {t("saveFailed")}
          </p>
        )}
      </form>
    </Modal>
  );
}
