import { Button, Input, Modal, Select } from "@bisheng/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelectLabels } from "@/components/bs-comp/formFields/useSelectLabels";
import type { AssetKind, BoardAsset, BoardOverview, BoardRun } from "@/controllers/API/companyBoards";
import { formatMeasure } from "./measures";

export const assetKinds: AssetKind[] = ["employee", "knowledge", "skill", "tool"];

interface AssetProps {
  overview: BoardOverview;
  period: string;
}
export function AssetDirectory({ overview, period }: AssetProps) {
  const { t } = useTranslation("companyBoards");
  const labels = useSelectLabels();
  const [kind, setKind] = useState("all");
  const [department, setDepartment] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(15);
  const [selected, setSelected] = useState<BoardAsset | null>(null);
  const { assets, departments, runtime } = overview;
  const names = new Map(departments.map(item => [item.id, item.name]));
  const countFor = (asset: BoardAsset) => runtime.usage.find(row => row.asset_id === asset.id && row.kind === asset.kind)?.count;
  const rows = assets.filter(asset => (kind === "all" || kind === asset.kind)
    && (department === "all" || (asset.department_id == null ? "unknown" : String(asset.department_id)) === department)
    && asset.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const departmentName = (asset: BoardAsset) => asset.department_id == null ? t("unassigned") : names.get(asset.department_id) || t("unassigned");
  const reset = (fn: (v: string) => void, value: string) => { fn(value); setLimit(15); };
  return <section className="cb-panel">
    <div className="cb-panel-heading"><h2>{t("assetDirectory")}</h2><span>{t("count", { count: rows.length })}</span></div>
    <div className="cb-filters">
      <Select {...labels} aria-label={t("assetType")} value={kind} onChange={v => reset(setKind, String(v))}
        options={["all", ...assetKinds].map(value => ({ value, label: t(value === "all" ? "allTypes" : "kind." + value) }))} />
      <Select {...labels} aria-label={t("department")} value={department} onChange={v => reset(setDepartment, String(v))}
        options={[{ value: "all", label: t("allDepartments") }, { value: "unknown", label: t("unassigned") }, ...departments.map(d => ({value: String(d.id), label: d.name}))]} />
      <Input aria-label={t("searchAssets")} placeholder={t("searchAssets")} value={search} onChange={e => reset(setSearch, e.target.value)} />
    </div>
    <div className="cb-table-wrap"><table><thead><tr><th>{t("asset")}</th><th>{t("assetType")}</th><th>{t("department")}</th><th>{t("observedUses")}</th></tr></thead>
      <tbody>{rows.slice(0, limit).map(asset => <tr key={asset.id}><td><Button variant="link" onClick={() => setSelected(asset)}>{asset.name}</Button></td>
        <td><span className={"cb-dot " + asset.kind}/>{t("kind." + asset.kind)}</td><td>{departmentName(asset)}</td><td>{formatMeasure(countFor(asset))}</td></tr>)}</tbody></table></div>
    {!rows.length && <p className="cb-empty">{t("noAssets")}</p>}
    {rows.length > limit && <Button variant="text" onClick={() => setLimit(limit + 30)}>{t("more")}</Button>}
    {selected && <Modal open title={selected.name} closeLabel={t("close")} onOpenChange={open => { if (!open) setSelected(null); }}>
      <dl className="cb-dl"><dt>{t("assetType")}</dt><dd>{t("kind." + selected.kind)}</dd><dt>{t("assetId")}</dt><dd>{selected.id}</dd>
        <dt>{t("department")}</dt><dd>{departmentName(selected)}</dd><dt>{t("period")}</dt><dd>{period}</dd>
        <dt>{t("observedUses")}</dt><dd>{formatMeasure(countFor(selected))}</dd></dl>
      <p className="cb-note">{t("knownUse")}</p>
    </Modal>}
  </section>;
}

export function AssetMix({ overview }: { overview: BoardOverview }) {
  const { t } = useTranslation("companyBoards");
  const total = overview.assets.length;
  return <section className="cb-panel"><div className="cb-panel-heading"><h2>{t("assetMix")}</h2><span>{t("current")} · {overview.catalog_as_of}</span></div>
    <div className="cb-big">{formatMeasure(total)} <small>{t("assetUnit")}</small></div>
    <div className="cb-bars" aria-label={t("assetMix")}>{assetKinds.map(kind => {
      const count = overview.assets.filter(a => a.kind === kind).length;
      return <div className="cb-bar-line" key={kind}><span>{t("kind." + kind)}</span><div><i className={kind} style={{width:total ? count / total * 100 + "%" : "0%"}} /></div><strong>{formatMeasure(count)}</strong></div>;
    })}</div></section>;
}

export function RunList({ overview }: { overview: BoardOverview }) {
  const { t } = useTranslation("companyBoards");
  const [selected, setSelected] = useState<BoardRun | null>(null);
  const [filter, setFilter] = useState("all");
  const labels = useSelectLabels();
  const status = (value: string) => t("status." + value, {defaultValue: value});
  const assets = new Map(overview.assets.map(a => [a.id, a.name]));
  const runs = overview.runtime.recent_runs;
  const filters = [...new Set(runs.map(r => r.status))];
  const rows = runs.filter(r => filter === "all" || r.status === filter);
  return <section className="cb-panel"><div className="cb-panel-heading"><h2>{t("recentRuns")}</h2>
    <Select {...labels} value={filter} aria-label={t("statusLabel")} onChange={v => setFilter(String(v))}
      options={[{value:"all", label:t("allStates")}, ...filters.map(value => ({value, label:status(value)}))]} /></div>
    <div className="cb-table-wrap"><table><thead><tr><th>{t("run")}</th><th>{t("asset")}</th><th>{t("statusLabel")}</th><th>{t("ended")}</th></tr></thead>
      <tbody>{rows.map(run => <tr key={run.id}><td><Button variant="link" onClick={() => setSelected(run)}>{run.id}</Button></td>
        <td>{assets.get(run.asset_id) || run.asset_id}</td><td>{status(run.status)}</td><td>{run.ended_at?.replace("T", " ")}</td></tr>)}</tbody></table></div>
    {!rows.length && <p className="cb-empty">{t(overview.runtime.detail_access ? "noRuns" : "restrictedRuns")}</p>}
    {selected && <Modal open title={t("runDetail")} closeLabel={t("close")} onOpenChange={open => {if (!open) setSelected(null);}}>
      <dl className="cb-dl"><dt>{t("run")}</dt><dd>{selected.id}</dd><dt>{t("asset")}</dt><dd>{assets.get(selected.asset_id) || selected.asset_id}</dd>
      <dt>{t("statusLabel")}</dt><dd>{status(selected.status)}</dd><dt>{t("ended")}</dt><dd>{selected.ended_at?.replace("T", " ")}</dd>
      <dt>{t("activeSeconds")}</dt><dd>{formatMeasure(selected.active_seconds)}</dd></dl></Modal>}
  </section>;
}
