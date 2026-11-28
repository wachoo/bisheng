import { useQuery } from "@tanstack/react-query";
import { Segmented } from "@bisheng/ui";
import { Outlined } from "bisheng-icons";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { userContext } from "@/contexts/userContext";
import {
  getBoardAccess,
  getBoardOverview,
  type CompanyBoard,
} from "@/controllers/API/companyBoards";
import { getBoardRegisters } from "@/controllers/API/companyRegisters";
import { currentBoardMonth, resolveBoardMonth } from "./boardPeriod";
import Activity, { ActivityDetail } from "./prototype/Activity";
import Impact, { ImpactDetail } from "./prototype/Impact";
import Monitor from "./prototype/Monitor";
import { MonitorDetail } from "./prototype/MonitorDetail";
import Strategy, { StrategyDetail } from "./prototype/Strategy";
import { SubjectDetail } from "./prototype/SubjectDetail";
import type {
  PrototypeDetailProps,
  PrototypeViewProps,
} from "./prototype/types";
import "./prototype/prototype.css";
import "./prototype/shell.css";
import "./prototype/analytics.css";

const leadViews = [
  { view: "strategy", anchor: "strategy", icon: Outlined.Dashboard },
  { view: "impact", anchor: "business", icon: Outlined.BlocksAndArrows },
  { view: "activity", anchor: "adoption", icon: Outlined.Application },
] as const;

interface LeadViewMenuProps {
  view: string;
  onChange: (view: string) => void;
  periodPicker?: ReactNode;
}

function LeadViewMenu({ view, onChange, periodPicker }: LeadViewMenuProps) {
  const { t } = useTranslation("companyBoards");
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [periodSlot, setPeriodSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeader(document.getElementById("leadboard-header-menu"));
    setPeriodSlot(document.getElementById("leadboard-period-slot"));
  }, []);
  return (
    <>
      {header && createPortal(
        <Segmented
          size="large"
          className="rounded-full [&>span[aria-hidden]]:rounded-full"
          aria-label={t("leadTitle")}
          value={view}
          onChange={onChange}
          options={leadViews.map(({ view, icon: Icon }) => ({
            value: view, label: t(view), icon: <Icon aria-hidden="true" />,
          }))}
        />,
        header,
      )}
      {periodSlot && periodPicker && createPortal(periodPicker, periodSlot)}
    </>
  );
}

type Step = { target: string; title: string };
function getSteps(params: URLSearchParams, defaultTitle: string): Step[] {
  const targets = params.getAll("detail");
  const labels = params.getAll("title");
  return targets
    .filter(Boolean)
    .map((target, i) => ({ target, title: labels[i] || defaultTitle }));
}
function Detail(props: PrototypeDetailProps) {
  const { t } = useTranslation("companyBoards");
  const key = props.target.split(":")[0];
  if(props.board==="monitor" && !["asset","department","topic-operations","monitor","feedback-queue","operations-register","topic-scenes"].includes(key))
    return <p className="al-empty">{t("navigation.leadDetail")}</p>;
  if (key === "asset" || key === "department")
    return <SubjectDetail {...props} />;
  if (key === "strategy") return <StrategyDetail {...props} />;
  if (
    [
      "monitor",
      "topic-operations",
      "operations-register",
      "feedback-queue",
    ].includes(key)
  )
    return <MonitorDetail {...props} />;
  if (
    [
      "applications",
      "labor",
      "deliveries",
      "ratings",
      "topic-register",
      "topic-scenes",
    ].includes(key)
  )
    return <ImpactDetail {...props} />;
  if (
    [
      "asset-usage",
      "usage-data",
      "tokens",
      "departments",
      "usage-ledger",
      "app-ranking",
      "worker-ranking",
      "activity-catalog",
      "activity-new",
    ].includes(key)
  )
    return <ActivityDetail {...props} />;
  return <p className="al-empty">{t("navigation.unknownDetail")}</p>;
}
export function CompanyBoardPage({ board }: { board: CompanyBoard }) {
  const { t } = useTranslation(["companyBoards","boardPlans"]);
  const { user } = useContext(userContext);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate(),
    location = useLocation();
  const today = currentBoardMonth();
  const period = resolveBoardMonth(params.get("period"), today);
  const [year, month] = period.split("-").map(Number);
  const current =
    board === "monitor"
      ? { view: "monitor", anchor: "operations" } as const
      : leadViews.find((v) => v.view === params.get("view")) ?? leadViews[0];
  const identity = [user?.user_id, user?.tenant_id];
  const access = useQuery({
    queryKey: ["company-boards", "access", ...identity],
    queryFn: getBoardAccess,
  });
  const allowed = !!access.data?.[board];
  const overview = useQuery({
    queryKey: ["company-boards", "overview", ...identity, board, year, month],
    queryFn: () => getBoardOverview(board, year, month),
    enabled: allowed,
  });
  const rows = useQuery({
    queryKey: ["company-boards", "registers", ...identity, board, year, month],
    queryFn: () => getBoardRegisters(board, year, month),
    enabled: allowed,
  });
  const steps = getSteps(params, t("navigation.detail")),
    active = steps[steps.length - 1];
  const viewport = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const parents = useRef(
    new Map<string, { idx: number; search: string; focus: Element | null }>(),
  );
  const key = [board, current.view, period, ...steps.map((s) => s.target)].join(
    "|",
  );
  const focus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    el.scrollTop = positions.current.get(key) ?? 0;
    if (focus.current instanceof HTMLElement && focus.current.isConnected)
      focus.current.focus({ preventScroll: true });
    focus.current = null;
  }, [key, overview.data, rows.data]);
  const saveScroll = () =>
    positions.current.set(key, viewport.current?.scrollTop ?? 0);
  function open(target: string, title: string) {
    saveScroll();
    const next = new URLSearchParams(params);
    next.append("detail", target);
    next.append("title", title);
    parents.current.set(key + "|" + target, {
      idx: window.history.state?.idx ?? 0,
      search: location.search,
      focus: document.activeElement,
    });
    setParams(next);
  }
  function back() {
    const parent = parents.current.get(key);
    if (parent) {
      focus.current = parent.focus;
      const distance = (window.history.state?.idx ?? 0) - parent.idx;
      if (distance > 0) {
        navigate(-distance);
        return;
      }
      navigate(
        { pathname: location.pathname, search: parent.search },
        { replace: true },
      );
      return;
    }
    const next = new URLSearchParams(params);
    next.delete("detail");
    next.delete("title");
    steps.slice(0, -1).forEach((s) => {
      next.append("detail", s.target);
      next.append("title", s.title);
    });
    setParams(next, { replace: true });
  }
  function changePeriod(value: string) {
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) ||
      value > today ||
      value < "2000-01"
    )
      return;
    const next = new URLSearchParams(params);
    next.set("period", value);
    setParams(next, { replace: true });
  }
  const picker = (
    <label className="al-month-picker">
      <span>{t("period")}</span>
      <input
        aria-label={t("period")}
        className="al-select"
        type="month"
        min="2000-01"
        max={today}
        value={period}
        onChange={(event) => changePeriod(event.target.value)}
      />
    </label>
  );
  const props: PrototypeViewProps | null =
    overview.data && rows.data && access.data && allowed
      ? {
          board,
          data: overview.data,
          access: access.data,
          registers: rows.data,
          period,
          changePeriod,
          open,
        }
      : null;
  if (params.get("view") === "register" && access.data?.manage)
    return <Navigate replace to={"/board-ledger?year=" + year} />;
  if (params.get("view") === "feedback" && !active && access.data?.resolve)
    return (
      <Navigate
        replace
        to={
          "/monitorboard?view=monitor&period=" +
          period +
          "&detail=monitor:feedback:pending&title=" + encodeURIComponent(t("navigation.pendingFeedback"))
        }
      />
    );
  const Home = {
    strategy: Strategy,
    activity: Activity,
    impact: Impact,
    monitor: Monitor,
  }[current.view];
  const failed = [access, overview, rows].find((q) => q.isError);
  const monitorDepartment = params.get("om-department");
  return (
    <div ref={viewport} className="company-board-screen" onScroll={saveScroll}>
      <div
        id="ai-leader"
        data-active-screen={current.anchor}
        data-overview={String(!active)}
      >
        {board === "lead" && allowed && (
          <LeadViewMenu
            view={current.view}
            periodPicker={!active && current.view !== "strategy" ? picker : null}
            onChange={(view) => setParams({ view, period })}
          />
        )}
        <main className="al-main">
          {failed ? (
            <div role="alert" className="al-empty">
              {t("loadFailed")}{" "}
              <button className="al-link" onClick={() => void failed.refetch()}>
                {t("retry")}
              </button>
            </div>
          ) : !props ? (
            <p role="status" className="al-empty">
              {access.data && !allowed
                ? t("denied")
                : t("loading")}
            </p>
          ) : board === "monitor" && monitorDepartment &&
            !props.data.departments.some(d => String(d.id) === monitorDepartment) ? (
            <p role="status" className="al-empty">
              {t("boardPlans:departmentUnavailable")}{" "}
              <button className="al-link" onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("om-department");
                next.delete("om-page");
                setParams(next, {replace: true});
              }}>{t("allDepartments")}</button>
            </p>
          ) : (
            <>
              <div
                id="al-home"
                hidden={!!active}
                key={[...identity, board, current.view, period].join("/")}
              >
                <Home {...props} />
              </div>
              <section id="al-detail" hidden={!active} aria-live="polite">
                {steps.map((s, i) => (
                  <div
                    key={
                      steps
                        .slice(0, i + 1)
                        .map((row) => row.target)
                        .join("|") + period
                    }
                    hidden={i !== steps.length - 1}
                  >
                    <button
                      type="button"
                      className="al-link al-detail-back"
                      data-back
                      onClick={back}
                    >
                      ← {t(i ? "navigation.backOne" : "navigation.backHome")}
                    </button>
                    <div className="al-detail-title">
                      <div>
                        <div className="al-eyebrow">
                          INTELLIGENT HUB / {t("navigation.detail")}
                        </div>
                        <h1>{s.title}</h1>
                      </div>
                      {picker}
                    </div>
                    <Detail {...props} {...s} />
                  </div>
                ))}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
