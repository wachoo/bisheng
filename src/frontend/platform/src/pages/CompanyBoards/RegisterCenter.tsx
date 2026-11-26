import { Button, Input } from "@bisheng/ui";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getBoardAccess,
  getBoardLedger,
  getBoardOverview,
  type BoardOverview,
  type LedgerRow,
} from "@/controllers/API/companyBoards";
import {
  getBoardRegisters,
  type SupplementalRow,
  type SupplementKind,
} from "@/controllers/API/companyRegisters";
import { userContext } from "@/contexts/userContext";
import { BoardLedger } from "./BoardLedger";
import { registerTarget, isSupplement, registerGroups, supplementForms } from "./RegisterDefinitions";
import { RegisterEditor } from "./RegisterEditor";
import { savedCaseTable, caseTableClipboard } from "./caseTable";
import "./boards.css";
import "./registers.css";

function RegisterList({
  kind,
  overview,
  records,
  onSaved,
  detailLink,
}: {
  kind: SupplementKind;
  overview: BoardOverview;
  records: SupplementalRow[];
  onSaved: () => void;
  detailLink?: (row: SupplementalRow) => string;
}) {
  const { t } = useTranslation("companyBoards");
  const [editing, setEditing] = useState<"new" | SupplementalRow | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const spec = supplementForms[kind];
  const names = new Map([...records, ...overview.ledger, ...overview.assets].map((r) => [r.id, r.name]));
  const printable = (key: string, value: string | undefined) => {
    if (!value) return "—";
    if (key === "sampleTable") return caseTableClipboard(savedCaseTable(value)) || "—";
    if (key === "assets")
      return value
        .split(",")
        .map((v) => names.get(v.trim()) || v)
        .join("、");
    if (key === "asset" || key === "scene") return names.get(value) || value;
    if (key === "department") return overview.departments.find((d) => String(d.id) === value)?.name || value;
    if (key === "ai" || (kind === "value-rate" && (key === "category" || key === "unit")))
      return t("registers.options." + value);
    return value;
  };
  const rows = records
    .filter(
      (r) =>
        r.kind === kind &&
        r.year === overview.year &&
        [
          r.name,
          names.get(r.parent_id || ""),
          r.date,
          ...Object.entries(r.fields).map(([k, v]) => printable(k, v)),
        ].some((s) => s?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(rows.length / 20)),
    selected = Math.min(page, pages);
  return (
    <section className="cb-panel">
      <div className="cb-panel-heading">
        <h2>{t("registers.names." + kind)}</h2>
        <div className="cb-inline">
          <Input
            allowClear
            aria-label={t("registers.search")}
            placeholder={t("registers.search")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <Button color="primary" variant="solid" onClick={() => setEditing("new")}>
            {t("add")}
          </Button>
        </div>
      </div>
      <div className="cb-table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th>{t("registers.dates." + kind)}</th>
              {spec.parent && <th>{t("registers.parents." + spec.parent)}</th>}
              {spec.fields.map((k) => (
                <th key={k}>
                  {t("registers.fields." + (kind === "expense" && k === "amount" ? "signed" : k))}
                </th>
              ))}
              <th>{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((selected - 1) * 20, selected * 20).map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.date}</td>
                {spec.parent && <td>{names.get(r.parent_id || "") || r.parent_id}</td>}
                {spec.fields.map((k) => (
                  <td key={k} className="br-value">
                    {printable(k, r.fields[k])}
                  </td>
                ))}
                <td>
                  <Button variant="text" onClick={() => setEditing(r)}>
                    {t("edit")}
                  </Button>
                  {detailLink && <Link to={detailLink(r)}>{t("leadTitle")} ↗</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="cb-empty">{t("noEntries")}</p>}
      {pages > 1 && (
        <div className="br-pager">
          <Button disabled={selected === 1} onClick={() => setPage(selected - 1)}>
            {t("registers.prev")}
          </Button>
          {selected} / {pages}
          <Button disabled={selected === pages} onClick={() => setPage(selected + 1)}>
            {t("registers.next")}
          </Button>
        </div>
      )}
      {editing && (
        <RegisterEditor
          kind={kind}
          overview={overview}
          records={records}
          existing={editing === "new" ? undefined : editing}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

export default function RegisterCenter() {
  const { t } = useTranslation("companyBoards");
  const { kind: raw } = useParams();
  const [params, setParams] = useSearchParams();
  const thisYear = Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date()),
  );
  const requested = Number(params.get("year"));
  const year = Number.isInteger(requested) && requested >= 2000 && requested <= 2100 ? requested : thisYear;
  const kinds = registerGroups.flatMap((g) => g.kinds);
  const kind = kinds.find((k) => k === raw);
  const { user } = useContext(userContext);
  const scope = [user?.tenant_id, user?.user_id];
  const access = useQuery({
    queryKey: ["company-boards", "register-access", ...scope],
    queryFn: getBoardAccess,
  });
  const enabled = Boolean(access.data?.manage);
  const catalog = useQuery({
    queryKey: ["company-boards", "register-catalog", ...scope, year],
    queryFn: () => getBoardOverview("monitor", year, 12),
    enabled,
  });
  const base = useQuery({
    queryKey: ["company-boards", "ledger", ...scope, year],
    queryFn: () => getBoardLedger(year),
    enabled,
  });
  const extra = useQuery({
    queryKey: ["company-boards", "registers", ...scope, "manage", year, 12],
    queryFn: () => getBoardRegisters("manage", year, 12),
    enabled,
  });
  const [saved, setSaved] = useState("");
  const feedbackKey = kind + "-" + year;
  const success = () => setSaved(feedbackKey);
  const href = (k?: string) => "/board-ledger" + (k ? "/" + k : "") + "?year=" + year;
  const verify = new URLSearchParams({
    period:
      year +
      "-" +
      (year === thisYear
        ? new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", month: "2-digit" }).format(new Date())
        : "12"),
    view: kind === "value-rate" ? "impact" : "strategy",
  });
  const readback = (row?: SupplementalRow | LedgerRow) => {
    const query = new URLSearchParams(verify);
    if (kind) {
      const target = registerTarget(kind, row);
      query.set("detail", target);
      let title = t("registers.names." + kind);
      if (target === "labor:year") {
        title = t("registers.labor");
        query.set("laborMode", "equiv");
      } else if (row && target.startsWith("asset:"))
        title = catalog.data?.assets.find((a) => a.id === target.slice(6))?.name || row.name;
      else if (row && /^strategy:(scene|topic):/.test(target))
        title = base.data?.find((r) => r.id === target.split(":")[2])?.name || row.name;
      query.set("title", title);
    }
    return "/leadboard?" + query;
  };
  const failure = [access, catalog, base, extra].find((q) => q.isError);
  const loaded = catalog.data && base.data && extra.data && enabled;
  const board = loaded ? { ...catalog.data!, ledger: base.data! } : null;
  return (
    <main className="company-board br-center">
      <div className="cb-frame">
        <header className="cb-heading">
          <div>
            <h1>{t("registers.title")}</h1>
            <div className="br-links">
              {access.data?.lead && <Link to="/leadboard">{t("leadTitle")}</Link>}
              {access.data?.monitor && <Link to="/monitorboard">{t("monitorTitle")}</Link>}
            </div>
          </div>
          <label className="cb-period">
            {t("year")}
            <select
              value={year}
              onChange={(e) => {
                setSaved("");
                setParams({ year: e.target.value });
              }}
            >
              {Array.from({ length: 101 }, (_, i) => 2000 + i).map((y) => (
                <option value={y} key={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </header>
        {failure ? (
          <section className="cb-panel">
            <Button onClick={() => void failure.refetch()}>{t("retry")}</Button>
          </section>
        ) : access.data && !enabled ? (
          <section className="cb-panel" role="alert">
            {t("registers.denied")}
          </section>
        ) : !board || !extra.data ? (
          <p className="cb-panel" role="status">
            {t("loading")}
          </p>
        ) : (
          <div className="br-layout">
            <aside className="cb-panel br-nav">
              <Link className={!raw ? "br-current" : ""} to={href()}>
                {t("registers.all")}
              </Link>
              {registerGroups.map((group) => (
                <nav key={group.name} aria-label={t("registers.groups." + group.name)}>
                  <h2>{t("registers.groups." + group.name)}</h2>
                  {group.kinds.map((k) => (
                    <Link
                      key={k}
                      aria-current={kind === k ? "page" : undefined}
                      className={kind === k ? "br-current" : ""}
                      to={href(k)}
                      onClick={() => setSaved("")}
                    >
                      {t("registers.names." + k)}
                    </Link>
                  ))}
                </nav>
              ))}
            </aside>
            <div className="br-work">
              {kind ? (
                <>
                  <div className="cb-panel br-usage">
                    <b>{t("registers.feeds")}</b>
                    <p>{t("registers.uses." + kind)}</p>
                    {access.data?.lead && <Link to={readback()}>{t("leadTitle")} ↗</Link>}
                    {access.data?.lead && kind === "project" && (
                      <Link
                        className="ml-4"
                        to={
                          "/leadboard?" +
                          new URLSearchParams({
                            view: "strategy",
                            period: verify.get("period")!,
                            detail: "strategy:budget",
                            title: t("registers.budgetlink"),
                          })
                        }
                      >
                        {t("registers.budgetlink")} ↗
                      </Link>
                    )}
                  </div>
                  {saved === feedbackKey && (
                    <p className="br-success" role="status">
                      {t("registers.saved")}
                    </p>
                  )}
                  {isSupplement(kind) ? (
                    <RegisterList
                      key={feedbackKey}
                      kind={kind}
                      overview={board}
                      records={extra.data}
                      detailLink={access.data?.lead ? readback : undefined}
                      onSaved={success}
                    />
                  ) : (
                    <BoardLedger
                      key={feedbackKey}
                      kind={kind}
                      overview={board}
                      editable
                      onSaved={success}
                      detailLink={access.data?.lead ? readback : undefined}
                    />
                  )}
                </>
              ) : raw ? (
                <div className="cb-panel">
                  {t("registers.unknown")} <Link to={href()}>{t("registers.all")}</Link>
                </div>
              ) : (
                registerGroups.map((group) => (
                  <section className="cb-panel" key={group.name}>
                    <div className="cb-panel-heading">
                      <h2>{t("registers.groups." + group.name)}</h2>
                    </div>
                    <div className="br-cards">
                      {group.kinds.map((k) => (
                        <Link key={k} to={href(k)} className="br-card">
                          <strong>{t("registers.names." + k)}</strong>
                          <span>
                            {t("count", {
                              count: isSupplement(k)
                                ? extra.data!.filter((r) => r.year === year && r.kind === k).length
                                : board.ledger.filter((r) => r.kind === k).length,
                            })}
                          </span>
                          <p>{t("registers.uses." + k)}</p>
                        </Link>
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
