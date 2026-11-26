import { Button, Input, Modal, Select } from "@bisheng/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import { getBoardLedger, saveLedger, type BoardOverview, type GoalIndicator, type LedgerInput, type LedgerKind, type LedgerRow } from "@/controllers/API/companyBoards";
import { userContext } from "@/contexts/userContext";
import { showApiError } from "@/controllers/request";
import { formatMeasure } from "./measures";

interface LedgerProps { overview: BoardOverview; editable: boolean; kind?: LedgerKind; onSaved?: () => void; detailLink?: (row:LedgerRow)=>string }
const ledgerKinds: LedgerKind[] = ["goal", "topic", "scene", "release", "collection"];
const indicators: GoalIndicator[] = ["employee", "scene"];

export function BoardLedger({ overview: snapshot, editable, kind, onSaved, detailLink }: LedgerProps) {
  const { t } = useTranslation("companyBoards");
  const [editing, setEditing] = useState<LedgerRow | "new" | null>(null);
  const [selectedKind, setSelectedKind] = useState("all");
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const labels = useSelectLabels();
  const { user } = useContext(userContext);
  const latest = useQuery({queryKey:["company-boards","ledger",user?.tenant_id,user?.user_id,snapshot.year],
    queryFn:() => getBoardLedger(snapshot.year), enabled:editable});
  const overview = editable && latest.data ? {...snapshot, ledger:latest.data} : snapshot;
  const departments = new Map(overview.departments.map(item => [item.id, item.name]));
  const filter = kind || selectedKind;
  const entries = overview.ledger.filter(row => filter === "all" || row.kind === filter);
  const topic = (row: LedgerRow) => overview.ledger.find(r => r.id === row.parent_id)?.name;
  if (editable && !latest.data) return <section className="cb-panel">{latest.isError
    ? <Button onClick={() => void latest.refetch()}>{t("retry")}</Button> : t("loading")}</section>;
  return <section className="cb-panel"><div className="cb-panel-heading">
    <h2>{t(kind ? "registers.names." + kind : "ledger")}</h2><div className="cb-inline">
      {!kind && <Select {...labels} aria-label={t("ledgerKind")} value={selectedKind} onChange={v => setSelectedKind(String(v))}
        options={[{value:"all",label:t("allTypes")}, ...ledgerKinds.map(value => ({value, label:t("entry." + value)}))]} />}
      {editable && <Button color="primary" variant="solid" onClick={() => setEditing("new")}>{t("add")}</Button>}</div></div>
    <div className="cb-table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t("ledgerKind")}</th><th>{t("department")}</th>
      <th>{t("targetDate")}</th>{editable && <th>{t("actions")}</th>}</tr></thead>
      <tbody>{entries.map(row => <tr key={row.id}><td><Button variant="link" onClick={() => setSelected(row)}>{row.name}</Button></td>
        <td>{t("entry." + row.kind)}</td><td>{departments.get(row.department_id ?? -1) || "—"}</td>
        <td>{row.kind === "goal" ? formatMeasure(row.target) + " " + (row.unit || "") : row.effective_date || "—"}</td>
        {editable && <td>{row.kind === "goal" && row.indicator === "knowledge"
          ? t("legacyGoal")
          : <Button variant="text" onClick={() => setEditing(row)}>{t("edit")}</Button>}{detailLink && <Link to={detailLink(row)}>{t("leadTitle")} ↗</Link>}</td>}</tr>)}</tbody></table></div>
    {!entries.length && <p className="cb-empty">{t("noEntries")}</p>}
    {editing && <LedgerEditor overview={overview} row={editing === "new" ? undefined : editing} initialKind={kind} onSaved={onSaved} onClose={() => setEditing(null)}/>}
    {selected && <Modal open title={selected.name} closeLabel={t("close")} onOpenChange={open => {if (!open) setSelected(null);}}>
      <dl className="cb-dl"><dt>{t("ledgerKind")}</dt><dd>{t("entry." + selected.kind)}</dd><dt>{t("year")}</dt><dd>{selected.year}</dd>
        <dt>{t("department")}</dt><dd>{departments.get(selected.department_id ?? -1) || "—"}</dd>
        {selected.parent_id && <><dt>{t(selected.kind === "release" ? "scene" : "topic")}</dt><dd>{topic(selected) || "—"}</dd></>}
        {selected.asset_key && <><dt>{t("asset")}</dt><dd>{overview.assets.find(a => a.id === selected.asset_key)?.name || selected.asset_key}</dd></>}
        {selected.kind === "goal" && <><dt>{t("indicator")}</dt><dd>{t("indicatorName." + selected.indicator)}</dd><dt>{t("target")}</dt><dd>{formatMeasure(selected.target)} {selected.unit}</dd></>}
        <dt>{t("dateField." + selected.kind)}</dt><dd>{selected.effective_date || "—"}</dd>
        <dt>{t("revision")}</dt><dd>{selected.revision}</dd></dl></Modal>}
  </section>;
}

interface EditorProps { overview: BoardOverview; row?: LedgerRow; initialKind?: LedgerKind; onClose: () => void; onSaved?: () => void }
function LedgerEditor({ overview, row, initialKind, onClose, onSaved }: EditorProps) {
  const { t } = useTranslation("companyBoards");
  const labels = useSelectLabels();
  const cache = useQueryClient();
  const [kind, setKind] = useState<LedgerKind>(row?.kind || initialKind || "goal");
  const [indicator, setIndicator] = useState<GoalIndicator>(row?.indicator || "employee");
  const [name, setName] = useState(row?.name || "");
  const [target, setTarget] = useState(row?.target?.toString() || "");
  const [unit, setUnit] = useState(row?.unit || "");
  const [date, setDate] = useState(row?.effective_date || "");
  const [department, setDepartment] = useState(row?.department_id?.toString() || "");
  const [parent, setParent] = useState(row?.parent_id || "");
  const [asset, setAsset] = useState(row?.asset_key || "");
  const needsParent = kind === "scene" || kind === "collection" || kind === "release";
  const mutation = useMutation({
    mutationFn: (input: LedgerInput) => saveLedger(input, row),
    onSuccess: async () => { await cache.invalidateQueries({queryKey:["company-boards"]}); onSaved?.(); onClose(); },
    onError: showApiError,
  });
  const canSave = name.trim().length > 0
    && (kind !== "goal" || (unit.trim() && target.trim() && Number.isInteger(Number(target)) && Number(target) >= 0 && Number(target) <= 100000000))
    && (!needsParent || Boolean(parent)) && (kind !== "release" || Boolean(asset))
    && (kind !== "collection" || !date || Boolean(asset)) && !mutation.isLoading;
  const parents = overview.ledger.filter(r => r.kind === (kind === "release" ? "scene" : "topic"));
  return <Modal open submitting={mutation.isLoading} title={t(row ? "editEntry" : "newEntry")} closeLabel={t("close")}
    onOpenChange={open => {if (!open) onClose();}}
    footer={<><Button variant="outlined" disabled={mutation.isLoading} onClick={onClose}>{t("cancel")}</Button>
      <Button color="primary" variant="solid" type="submit" form="company-ledger-form" disabled={!canSave}>{t("save")}</Button></>}>
    <form id="company-ledger-form" className="cb-form" onSubmit={event => {
      event.preventDefault();
      if (!canSave) return;
      mutation.mutate({kind, year:overview.year, name:name.trim(), indicator:kind === "goal" ? indicator : null,
        target:kind === "goal" ? Number(target) : null, unit:kind === "goal" ? unit.trim() : null,
        asset_key:kind === "release" || kind === "collection" ? asset || null : null,
        effective_date:date || null, department_id:department ? Number(department) : null, parent_id:needsParent ? parent : null});
    }}>
      <div><label htmlFor="cb-entry-kind">{t("ledgerKind")}</label><Select {...labels} id="cb-entry-kind" value={kind} disabled={Boolean(row || initialKind)}
        onChange={v => {setKind(v as LedgerKind); setParent(""); setAsset("");}} options={ledgerKinds.map(value => ({value, label:t("entry." + value)}))}/></div>
      <div><label htmlFor="cb-name">{t("name")}</label><Input id="cb-name" required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></div>
      {kind === "goal" && <><div><label htmlFor="cb-indicator">{t("indicator")}</label><Select {...labels} id="cb-indicator" value={indicator}
        options={indicators.map(value => ({value, label:t("indicatorName." + value)}))} onChange={v => setIndicator(v as GoalIndicator)} /></div>
        <div className="cb-pair"><div><label htmlFor="cb-target">{t("target")}</label><Input id="cb-target" type="number" min="0" max="100000000" step="1" value={target} required onChange={e => setTarget(e.target.value)} /></div>
          <div><label htmlFor="cb-unit">{t("unit")}</label><Input id="cb-unit" required maxLength={16} value={unit} onChange={e => setUnit(e.target.value)}/></div></div></>}
      {needsParent && <div><label htmlFor="cb-parent">{t(kind === "release" ? "scene" : "topic")}</label><Select {...labels} id="cb-parent" value={parent || null}
        placeholder={t("chooseParent")} options={parents.map(r => ({value:r.id, label:r.name}))} onChange={v => setParent(String(v ?? ""))}/>
        {!parents.length && <p className="cb-note">{t(kind === "release" ? "createSceneFirst" : "createTopicFirst")}</p>}</div>}
      {(kind === "release" || kind === "collection") && <div><label htmlFor="cb-asset">{t("asset")}</label><Select {...labels} id="cb-asset" value={asset || null}
        placeholder={t("chooseAsset")} options={overview.assets.filter(a => kind !== "collection" || a.kind === "knowledge").map(a => ({value:a.id, label:a.name}))}
        onChange={v => setAsset(String(v ?? ""))}/></div>}
      <div><label htmlFor="cb-dept">{t("department")}</label><Select {...labels} id="cb-dept" value={department || null} allowClear
        placeholder={t("unassigned")} options={overview.departments.map(d => ({value:String(d.id),label:d.name}))}
        onChange={v => setDepartment(String(v ?? ""))}/></div>
      <div><label htmlFor="cb-date">{t("dateField." + kind)}</label><Input id="cb-date" type="date" value={date} onChange={e => setDate(e.target.value)}/></div>
      {mutation.isError && <p role="alert" className="cb-note">{t("saveFailed")}</p>}
    </form></Modal>;
}
