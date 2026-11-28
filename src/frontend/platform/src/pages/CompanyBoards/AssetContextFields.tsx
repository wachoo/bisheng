import { Button, Select } from "@bisheng/ui";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import request, { showApiError } from "@/controllers/request";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";

type Kind = "assistant" | "flow" | "app" | "knowledge" | "skill" | "toolset";
interface Context {
  year: number;
  default_topic: string;
  topics: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  revision: number;
  topic: string;
  knowledge_category_id?: string | null;
  knowledge_category_name?: string | null;
}
interface Props { assetKey?: string; knowledge?: boolean; saveButton?: React.ReactNode }
export interface AssetContextHandle {
  persist: (kind: Kind, saveAsset: () => Promise<string | number>) => Promise<string | number>;
}
const base = "/api/v1/company-boards/asset-context";
export const AssetContextFields = forwardRef<AssetContextHandle, Props>(function AssetContextFields(props, ref) {
  return <AssetFields key={props.assetKey || "new"} {...props} ref={ref}/>;
});

const AssetFields = forwardRef<AssetContextHandle, Props>(function AssetFields({ assetKey, knowledge, saveButton }, ref) {
  const { t } = useTranslation("companyBoards");
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const selectLabels = useSelectLabels();
  const [dirty, setDirty] = useState(false);
  const [categoryChanged, setCategoryChanged] = useState(false);
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
        setContext({ ...data, topic: data.topic || data.default_topic, revision: data.revision || 0 });
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
      const ident = savedAsset.current ?? await saveAsset();
      savedAsset.current = ident;
      try {
        const result = await request.put<unknown, {revision:number}>(base + "/" + encodeURIComponent(kind + ":" + ident), {
          year: context.year, topic: context.topic, revision: context.revision,
          ...(categoryChanged && {knowledge_category_id: context.knowledge_category_id || null}),
        });
        setContext(old => old && { ...old, revision: result.revision });
        savedAsset.current = null;
        setDirty(false);
        setCategoryChanged(false);
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
      {t("assetContext.associationsTitle")}<span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
    {expanded && <div id={id} className="grid gap-3 px-3 pb-3">
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      {!context && (message ? <Button type="button" variant="outlined" size="small" onClick={() => setRetry(n => n + 1)}>{t("retry")}</Button>
        : <span role="status">{t("assetContext.loading")}</span>)}
      {context && <>
        <label className="grid gap-1 text-sm">{t("assetContext.topic")}
          <select className="h-9 rounded-md border border-border bg-background px-2" value={context.topic}
            onChange={e => change({ topic: e.target.value })}>
            {context.topics.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        {knowledge && <div className="grid gap-1 text-sm">
          <label htmlFor={id + "-category"}>{t("assetContext.category")}</label>
          <Select id={id + "-category"} {...selectLabels} allowClear showSearch
            aria-label={t("assetContext.category")}
            placeholder={t(context.categories.length ? "assetContext.chooseCategory" : "assetContext.noCategories")}
            value={context.knowledge_category_id || null}
            options={[
              ...context.categories.map(c => ({ value: c.id, label: c.name })),
              ...(context.knowledge_category_id && !context.categories.some(c => c.id === context.knowledge_category_id)
                ? [{value: context.knowledge_category_id, label: context.knowledge_category_name || context.knowledge_category_id, disabled: true}] : []),
            ]}
            onChange={v => {
              setCategoryChanged(true);
              change({ knowledge_category_id: v ? String(v) : null });
            }}
          />
        </div>}
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
