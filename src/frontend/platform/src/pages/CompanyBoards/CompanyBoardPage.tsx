import { useQuery } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef } from "react";
import {
  Link,
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

const views = [
  { view: "strategy", anchor: "strategy", name: "战略进展", board: "lead" },
  { view: "impact", anchor: "business", name: "业务赋能", board: "lead" },
  { view: "activity", anchor: "adoption", name: "应用活力", board: "lead" },
  { view: "monitor", anchor: "operations", name: "运营监控", board: "monitor" },
] as const;
type Step = { target: string; title: string };
function getSteps(params: URLSearchParams): Step[] {
  const targets = params.getAll("detail");
  const labels = params.getAll("title");
  return targets
    .filter(Boolean)
    .map((target, i) => ({ target, title: labels[i] || "数据明细" }));
}
function Detail(props: PrototypeDetailProps) {
  const key = props.target.split(":")[0];
  if(props.board==="monitor" && !["asset","department","topic-operations","monitor","feedback-queue","operations-register","topic-scenes"].includes(key))
    return <p className="al-empty">请从领导看板打开该明细。</p>;
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
  return <p className="al-empty">未找到此明细，请返回上一级。</p>;
}
function monthNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
  }).formatToParts(new Date());
  return (
    parts.find((p) => p.type === "year")?.value +
    "-" +
    parts.find((p) => p.type === "month")?.value
  );
}
export function CompanyBoardPage({ board }: { board: CompanyBoard }) {
  const { user } = useContext(userContext);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate(),
    location = useLocation();
  const today = monthNow(),
    raw = params.get("period") || today;
  const period =
    /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && raw >= "2000-01" && raw <= today
      ? raw
      : today;
  const [year, month] = period.split("-").map(Number);
  const current =
    views.find((v) => v.view === params.get("view") && v.board === board) ||
    views.find((v) => v.board === board)!;
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
  const steps = getSteps(params),
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
      <span>统计月份</span>
      <input
        aria-label="统计月份"
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
          "&detail=monitor:feedback:pending&title=反馈待办"
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
  return (
    <div ref={viewport} className="company-board-screen" onScroll={saveScroll}>
      <div
        id="ai-leader"
        data-active-screen={current.anchor}
        data-overview={String(!active)}
      >
        <header className="al-header">
          <nav aria-label="看板主题">
            {views
              .filter((v) => access.data?.[v.board])
              .map((v) => (
                <button
                  type="button"
                  key={v.view}
                  className={v.board === "monitor" ? "al-ops-link" : ""}
                  aria-current={v.view === current.view ? "page" : undefined}
                  data-anchor={v.anchor}
                  onClick={() =>
                    navigate(
                      (v.board === "lead" ? "/leadboard" : "/monitorboard") +
                        "?view=" +
                        v.view +
                        "&period=" +
                        period,
                    )
                  }
                >
                  {v.name}
                </button>
              ))}
          </nav>
          <div className="al-utilities">
            {access.data?.manage && (
              <Link to={"/board-ledger?year=" + year}>填报台账</Link>
            )}
          </div>
        </header>
        <main className="al-main">
          {failed ? (
            <div role="alert" className="al-empty">
              看板数据读取失败。{" "}
              <button className="al-link" onClick={() => void failed.refetch()}>
                重试
              </button>
            </div>
          ) : !props ? (
            <p role="status" className="al-empty">
              {access.data && !allowed
                ? "当前账号无此看板权限。"
                : "正在读取看板…"}
            </p>
          ) : (
            <>
              <div
                id="al-home"
                hidden={!!active}
                key={[...identity, board, current.view, period].join("/")}
              >
                {(current.view === "impact" || current.view === "activity") && (
                  <div className="al-page-heading">
                    <div>
                      <h1>{current.name}</h1>
                    </div>
                    <div className="al-page-meta">{picker}</div>
                  </div>
                )}
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
                      ← 返回{i ? "上一级" : "看板"}
                    </button>
                    <div className="al-detail-title">
                      <div>
                        <div className="al-eyebrow">
                          INTELLIGENT HUB / 数据明细
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
