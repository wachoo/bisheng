import { Outlined } from "bisheng-icons";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fmt } from "./ActivityData";
import "./ActivityMobile.css";

export function useText() {
  const { t } = useTranslation("activityCharts");
  return (s: string): string => String(t(s, { defaultValue: s, keySeparator: false }));
}
export function TrendNotice({ retry }: { retry: () => unknown }) {
  const t = useText();
  return (
    <div role="alert" className="al-info">
      {t("运行趋势读取失败。")}{" "}
      <button className="al-link" onClick={() => void retry()}>
        {t("重试")}
      </button>
    </div>
  );
}
export type OpenTarget = (key: string, title: string) => void;

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"al-panel " + className}>
      <div className="al-panel-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="al-panel-body">{children}</div>
    </section>
  );
}
export function Link({
  to,
  title,
  open,
  children,
}: {
  to: string;
  title: string;
  open: OpenTarget;
  children?: ReactNode;
}) {
  return (
    <button type="button" className="al-link" data-detail={to} onClick={() => open(to, title)}>
      {children || title} <Outlined.ArrowRightUp className="al-drill-icon" aria-hidden />
    </button>
  );
}
const metricIcons = {
  "applications:year": Outlined.ListSuccess,
  "labor:year": Outlined.Time,
  "deliveries:year": Outlined.FileExport,
  ratings: Outlined.ThumbsUp,
  "activity-catalog": Outlined.Layer,
  "activity-new": Outlined.FileAddition,
  "asset-usage": Outlined.Dashboard,
  tokens: Outlined.Exchange,
};

export function Metric({
  name,
  value,
  unit,
  note,
  to,
  open,
  detailTitle,
}: {
  name: string;
  value: string;
  unit?: string;
  note: string;
  to?: string;
  open?: OpenTarget;
  detailTitle?: string;
}) {
  const Icon = metricIcons[to as keyof typeof metricIcons];
  const inner = (
    <>
      <div className="al-stat-label">
        {Icon && <span className="al-metric-icon"><Icon aria-hidden /></span>}
        <span>{name}</span>
        {to && <Outlined.ArrowRightUp className="al-arrow" aria-hidden />}
      </div>
      <div className="al-stat-value" data-unavailable={value === "—" || undefined}>
        {value}
        <small>{unit}</small>
      </div>
      <div className="al-stat-note">{note}</div>
    </>
  );
  return to && open ? (
    <button type="button" data-detail={to} className="al-stat" onClick={() => open(to, detailTitle || name)}>
      {inner}
    </button>
  ) : (
    <div className="al-stat">{inner}</div>
  );
}
export function Table({
  heads,
  rows,
  pageSize = 12,
}: {
  heads: string[];
  rows: ReactNode[][];
  pageSize?: number;
}) {
  const t = useText();
  const [page, setPage] = useState(1);
  const last = Math.max(1, Math.ceil(rows.length / pageSize));
  const here = Math.min(page, last);
  return (
    <>
      <div className="al-table-wrap">
        <table>
          <thead>
            <tr>
              {heads.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.slice((here - 1) * pageSize, here * pageSize).map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={heads.length} className="al-empty">
                  {t("没有匹配的记录")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {last > 1 && (
        <div className="al-paging">
          <span>
            {t("共")} {rows.length} {t("条")}
          </span>
          <div>
            <button className="al-button" disabled={here === 1} onClick={() => setPage(here - 1)}>
              {t("上一页")}
            </button>
            <span>
              {here} / {last}
            </span>
            <button className="al-button" disabled={here === last} onClick={() => setPage(here + 1)}>
              {t("下一页")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
type ChartProps = {
  values: (number | null)[];
  unit: string;
  name: string;
  selected: number;
  period: string;
  cutoff: string;
  line?: { values: (number | null)[]; name: string; unit: string; percent?: boolean };
};
export function Chart({ values, unit, name, selected, period, cutoff, line }: ChartProps) {
  const t = useText();
  const width = 540,
    bottom = 139,
    height = 132,
    step = width / Math.max(values.length, 1);
  const maximum = (v: (number | null)[]) => {
    const peak = Math.max(1, ...v.map((n) => n ?? 0));
    const scale = 10 ** Math.floor(Math.log10(peak));
    return Math.ceil(peak / scale) * scale;
  };
  const max = maximum(values),
    rightMax = line?.percent ? 100 : maximum(line?.values || []),
    rightMin = line?.percent && (line?.values || []).every((n) => n === null || n >= 80) ? 80 : 0;
  const y = (n: number) => bottom - ((n - rightMin) / Math.max(1, rightMax - rightMin)) * height;
  const x = (i: number) => (i + 0.5) * step;
  const short = (n: number) => (n >= 10000 ? fmt(n / 10000) + t("万") : fmt(n));
  const prop = line?.values
    .map((n, i) => (n === null ? "" : (i === 0 || line.values[i - 1] === null ? "M" : "L") + x(i) + " " + y(n)))
    .join(" ");
  const hasBars = values.some((n) => n !== null);
  const hasLine = line?.values.some((n) => n !== null);
  const empty = !hasBars && !hasLine;
  return (
    <>
      {line ? (
        <div className="al-chart-topline al-combo-legend">
          <span>
            <i className="al-combo-bar-key" />
            {name}（{unit}）
          </span>
          <span>
            <i className="al-combo-line-key" />
            {line.name}（{line.unit}）
          </span>
        </div>
      ) : (
        <div className="al-chart-topline">
          <span>
            {t("单位")}：{unit}
          </span>
          <span>
            {period.slice(0, 4)}.01 — {cutoff.slice(5).replace("-", ".")}
          </span>
        </div>
      )}
      {empty ? (
        <div className="al-chart al-chart-empty" role="img" aria-label={name + " · " + t("暂无可核对数据")}>
          <Outlined.Dashboard aria-hidden />
          <span>{t("暂无可核对数据")}</span>
        </div>
      ) : (
        <div className={line ? "al-chart al-combo-chart" : "al-chart"}>
          <div className="al-y-axis">
            {hasBars && [max, max / 2, 0].map((n) => (
              <span key={n}>{short(n)}</span>
            ))}
          </div>
          <div className="al-plot">
            <svg
              viewBox={line ? "0 0 540 148" : "0 0 540 154"}
              preserveAspectRatio="none"
              role="img"
              aria-label={line ? name + " / " + line.name : name}
            >
              <path d="M0 7H540 M0 73H540 M0 139H540" stroke="var(--al-line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" fill="none" />
              {values.map((v, i) =>
                v == null ? null : (
                  <rect
                    key={i}
                    x={x(i) - Math.min(23, step * 0.52) / 2}
                    y={v === 0 ? bottom - 1 : bottom - (v / max) * height}
                    width={Math.min(23, step * 0.52)}
                    height={v === 0 ? 2 : (v / max) * height}
                    rx="2"
                    fill="var(--al-blue)"
                    opacity={selected === 0 || i + 1 === selected ? 1 : 0.42}
                  >
                    <title>
                      {i + 1}
                      {t("月")} · {name} {fmt(v)} {unit}
                    </title>
                  </rect>
                ),
              )}
              {line && (
                <>
                  <path
                    className="al-trend-line"
                    d={prop}
                    fill="none"
                    stroke="var(--al-teal)"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {line.values.map((n, i) =>
                    n === null ? null : (
                      <circle
                        key={i}
                        cx={x(i)}
                        cy={y(n)}
                        r="3"
                        fill="var(--al-paper)"
                        stroke="var(--al-teal)"
                        strokeWidth="1.5"
                      >
                        <title>
                          {i + 1}
                          {t("月")} · {line.name} {fmt(n)} {line.unit}
                        </title>
                      </circle>
                    ),
                  )}
                </>
              )}
            </svg>
            <div className="al-x-axis">
              {values.map((_, i) => (
                <span key={i}>
                  {i + 1}
                  {t("月")}
                </span>
              ))}
            </div>
          </div>
          {line && (
            <div className="al-y-axis al-rate-axis">
              {hasLine && [rightMax, (rightMin + rightMax) / 2, rightMin].map((n) => (
                <span key={n}>
                  {short(n)}
                  {line.percent ? "%" : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!line && (
        <div className="al-chart-note">
          {t("数据截至")} {cutoff}
        </div>
      )}
    </>
  );
}
