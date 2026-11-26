import { Button, Input, Textarea } from "@bisheng/ui";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import request, { showApiError } from "@/controllers/request";
import { caseTableClipboard, caseTableError, parseCasePaste, savedCaseTable } from "./caseTable";

type Kind = "assistant" | "flow" | "app" | "knowledge" | "skill" | "toolset";
type CaseFields = Partial<Record<"summary" | "input" | "output" | "action" | "sampleTitle" | "sampleTable", string>>;
interface Context {
  year: number;
  default_topic: string;
  topics: { id: string; name: string }[];
  scenes: { id: string; name: string; topic: string }[];
  revision: number;
  topic: string;
  scene_ids: string[];
  case_name: string;
  case_fields: CaseFields;
  profile: Partial<Record<"direction" | "description" | "rules", string>>;
}
interface Props { assetKey?: string; skill?: boolean; saveButton?: React.ReactNode }
export interface AssetContextHandle {
  persist: (kind: Kind, saveAsset: () => Promise<string | number>) => Promise<string | number>;
}
const base = "/api/v1/company-boards/asset-context";
const caseKeys = ["summary", "input", "output", "sampleTitle", "action"] as const;

export const AssetContextFields = forwardRef<AssetContextHandle, Props>(function AssetContextFields(props, ref) {
  return <AssetFields key={props.assetKey || "new"} {...props} ref={ref}/>;
});

const AssetFields = forwardRef<AssetContextHandle, Props>(function AssetFields({ assetKey, skill, saveButton }, ref) {
  const { t } = useTranslation("companyBoards");
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [table, setTable] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  // A metadata retry must never repeat a successful asset creation.
  const savedAsset = useRef<string | number | null>(null);
  useEffect(() => {
    if (!expanded || context) return;
    let current = true;
    setMessage("");
    request.get<unknown, Context>(assetKey ? base + "/" + encodeURIComponent(assetKey) : base + "/options")
      .then(data => {
        if (!current) return;
        setContext({ ...data, topic: data.topic || data.default_topic, revision: data.revision || 0,
          scene_ids: data.scene_ids || [], case_name: data.case_name || "", case_fields: data.case_fields || {}, profile: data.profile || {} });
        setTable(caseTableClipboard(savedCaseTable(data.case_fields?.sampleTable)));
      })
      .catch(() => { if (current) setMessage(t("assetContext.loadFailed")); });
    return () => { current = false; };
  }, [assetKey, expanded, context, retry, t]);
  function change(patch: Partial<Context>) {
    setContext(old => old && { ...old, ...patch });
    setDirty(true);
    setMessage("");
  }
  useImperativeHandle(ref, () => ({
    async persist(kind, saveAsset) {
      if (!dirty || !context) return saveAsset();
      const caseFields = context.case_name.trim() ? { ...context.case_fields } : {};
      if (context.case_name.trim() && table.trim()) {
        let grid: string[][];
        try { grid = parseCasePaste(table); } catch { grid = []; }
        const error = grid.length ? caseTableError(grid) : "quote";
        if (error) {
          const message = t("registers.sample." + error);
          setMessage(message);
          throw new Error(message);
        }
        caseFields.sampleTable = JSON.stringify(grid);
      } else delete caseFields.sampleTable;
      const ident = savedAsset.current ?? await saveAsset();
      savedAsset.current = ident;
      try {
        const result = await request.put<unknown, {revision:number}>(base + "/" + encodeURIComponent(kind + ":" + ident), {
          year: context.year, topic: context.topic, scenes: context.scene_ids, revision: context.revision,
          case_name: context.case_name.trim(), case_fields: caseFields, profile: context.profile,
        });
        setContext(old => old && { ...old, revision: result.revision });
        savedAsset.current = null;
        setDirty(false);
        return ident;
      } catch (error) {
        setMessage(t("assetContext.saveFailed"));
        throw error;
      }
    },
  }));
  return <div className="my-3 rounded-lg border border-border">
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
      {t("assetContext.title")}<span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
    {expanded && <div id={id} className="grid gap-3 px-3 pb-3">
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      {!context && (message ? <Button type="button" variant="outlined" size="small" onClick={() => setRetry(n => n + 1)}>{t("retry")}</Button>
        : <span role="status">{t("assetContext.loading")}</span>)}
      {context && <>
        <label className="grid gap-1 text-sm">{t("assetContext.topic")}
          <select className="h-9 rounded-md border border-border bg-background px-2" value={context.topic}
            onChange={e => change({ topic: e.target.value, scene_ids: [] })}>
            {context.topics.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        {context.scenes.some(s => s.topic === context.topic) && <fieldset>
          <legend className="text-sm">{t("assetContext.scenes")}</legend>
          <div className="flex max-h-28 flex-wrap gap-x-4 overflow-auto">
            {context.scenes.filter(s => s.topic === context.topic).map(s => <label key={s.id} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" checked={context.scene_ids.includes(s.id)} onChange={e => change({
                scene_ids: e.target.checked ? [...context.scene_ids, s.id] : context.scene_ids.filter(v => v !== s.id),
              })}/>{s.name}
            </label>)}
          </div>
        </fieldset>}
        <label className="grid gap-1 text-sm">{t("assetContext.direction")}
          <Input maxLength={2048} value={context.profile.direction || ""} onChange={e => change({ profile: { ...context.profile, direction: e.target.value } })} />
        </label>
        <label className="grid gap-1 text-sm">{t("assetContext.description")}
          <Textarea maxLength={2048} rows={2} placeholder={t("assetContext.useAssetDescription")}
            value={context.profile.description || ""} onChange={e => change({ profile: { ...context.profile, description: e.target.value } })} />
        </label>
        {skill && <label className="grid gap-1 text-sm">{t("assetContext.rules")}
          <Textarea maxLength={2048} rows={2} value={context.profile.rules || ""}
            onChange={e => change({ profile: { ...context.profile, rules: e.target.value } })} />
        </label>}
        <label htmlFor={id+"case"} className="text-sm">{t("assetContext.case")}</label>
        <Input id={id+"case"} maxLength={160} value={context.case_name} onChange={e => change({ case_name: e.target.value })} />
        {context.case_name && <>
          {caseKeys.map(k => <label key={k} className="grid gap-1 text-sm">{t("assetContext."+k)}
            <Input value={context.case_fields[k] || ""} maxLength={k === "action" ? 40 : k === "sampleTitle" ? 100 : k === "summary" ? 512 : 2048}
              onChange={e => change({ case_fields: { ...context.case_fields, [k]: e.target.value } })} />
          </label>)}
          <label className="grid gap-1 text-sm">{t("assetContext.table")}
            <Textarea value={table} rows={3} placeholder={t("registers.sample.help")} onChange={e => { setTable(e.target.value); setDirty(true); }}/>
          </label>
        </>}
      </>}
      {context && dirty && saveButton}
    </div>}
  </div>;
});

export function EditableAssetContext({ kind, id }: { kind: Kind; id: string }) {
  const form = useRef<AssetContextHandle>(null);
  const { t } = useTranslation("companyBoards");
  const [saving, setSaving] = useState(false);
  return <AssetContextFields ref={form} assetKey={kind + ":" + id} saveButton={
    <Button size="small" disabled={saving} onClick={async () => {
      setSaving(true);
      try { await form.current!.persist(kind, async () => id); }
      catch (error) { showApiError(error); }
      finally { setSaving(false); }
    }}>{t("save")}</Button>
  }/>;
}
