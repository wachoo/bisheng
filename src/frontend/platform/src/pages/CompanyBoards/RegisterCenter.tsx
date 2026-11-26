import { Button } from "@bisheng/ui";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { userContext } from "@/contexts/userContext";
import { getBoardAccess } from "@/controllers/API/companyBoards";
import { currentBoardMonth } from "./boardPeriod";
import { PlanForm } from "./planning/PlanForm";
import { ResearchOperationsForm } from "./ResearchOperationsForm";
import "./boards.css";
import "./registers.css";

const sections = ["annual", "knowledge", "research"] as const;
type Section = (typeof sections)[number];
const legacySection: Record<string, Section> = {
  goal: "annual", topic: "annual", scene: "annual", release: "annual",
  "scene-team": "annual", recognition: "annual",
  collection: "knowledge", "collection-meta": "knowledge",
  project: "research", subject: "research", expense: "research", receivable: "research",
  receipt: "research", estimate: "research", "value-rate": "research",
};
const assetKinds = ["case", "scene-asset", "asset-profile"];

export default function RegisterCenter() {
  const { t } = useTranslation("companyBoards");
  const { kind } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useContext(userContext);
  const access = useQuery({
    queryKey: ["company-boards", "access", user?.user_id, user?.tenant_id],
    queryFn: getBoardAccess,
  });
  const current = Number(currentBoardMonth().slice(0, 4));
  const requested = Number(params.get("year"));
  const year = Number.isInteger(requested) && requested >= 2000 && requested <= 2100 ? requested : current;
  const section = sections.find((item) => item === (kind ?? "annual"));
  const href = (item: Section) => "/board-ledger/" + item + "?year=" + year;
  if (kind && Object.hasOwn(legacySection, kind)) return <Navigate replace to={href(legacySection[kind])} />;
  return (
    <main className="company-board br-center">
      <div className="cb-frame">
        <header className="cb-heading">
          <h1>{t("registers.title")}</h1>
          <label className="cb-period">
            {t("year")}
            <select value={year} onChange={(event) => setParams({ year: event.target.value })}>
              {Array.from({ length: 101 }, (_, i) => 2100 - i).map((y) => <option key={y}>{y}</option>)}
            </select>
          </label>
        </header>
        {access.isError ? (
          <div role="alert" className="cb-panel">{t("loadFailed")} <Button onClick={() => void access.refetch()}>{t("retry")}</Button></div>
        ) : !access.data ? (
          <p role="status">{t("loading")}</p>
        ) : !access.data.manage ? (
          <p role="alert">{t("registers.denied")}</p>
        ) : (
          <>
            <nav className="br-sections" aria-label={t("registers.title")}>
              {sections.map((item) => <Link key={item} aria-current={section === item ? "page" : undefined} to={href(item)}>{t("forms." + item)}</Link>)}
            </nav>
            {section === "research" ? <ResearchOperationsForm key={year} year={year} /> :
              section ? <PlanForm key={section + year} year={year} kind={section} /> :
                <p role="status" className="cb-panel">{t(assetKinds.includes(kind ?? "") ? "forms.assetMoved" : "registers.unknown")}</p>}
          </>
        )}
      </div>
    </main>
  );
}
