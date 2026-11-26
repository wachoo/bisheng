import type { MonitorSnapshot } from "@/controllers/API/companyMonitoring";
import { fmt } from "./MonitorParts";

export function MonitorTrend({
  snapshot,
  period,
  cutoff,
}: {
  snapshot: MonitorSnapshot;
  period: string;
  cutoff: string;
}) {
  const n = Number(cutoff.slice(-2));
  const map = new Map(snapshot.days.map((row) => [row.day, row]));
  const dates = Array.from({ length: n }, (_, i) => ({
    date: period + "-" + String(i + 1).padStart(2, "0"),
    success: map.get(i + 1)?.success || 0,
    failed: map.get(i + 1)?.failed || 0,
  }));
  const success = dates.reduce((n, d) => n + d.success, 0),
    fail = dates.reduce((n, d) => n + d.failed, 0);
  const observed = snapshot.assets.filter((row) => row.monitored).length;
  const missing = snapshot.assets.length - observed;
  const total = (v: number) => (observed ? fmt(v) + " 次" : "—");
  const plot = (key: "success" | "failed", label: string) => {
    const name = key === "failed" ? "fail" : "success";
    const peak = Math.max(1, ...dates.map((d) => d[key]));
    const magnitude = 10 ** Math.floor(Math.log10(peak)),
      ceiling = Math.ceil(peak / magnitude) * magnitude;
    const width = dates.length * 20,
      x = (i: number) => i * 20 + 10,
      y = (v: number) => 97 - (94 * v) / ceiling;
    return (
      <div className={"omt-track omt-" + name}>
        <span className="omt-series-name">
          {label}
          <small>次</small>
        </span>
        <div className="omt-axis">
          <span>{observed ? fmt(ceiling) : "—"}</span>
          <span>0</span>
        </div>
        <svg
          viewBox={"0 0 " + width + " 100"}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            observed ? "逐日" + label + "次数，纵轴从 0 到 " + ceiling + " 次" : "逐日" + label + "次数未采集"
          }
        >
          <path className="omt-guide" d={`M0 3H${width}M0 50H${width}M0 97H${width}`} />
          {observed > 0 && (
            <g className="omt-marks">
              {key === "success" ? (
                dates.map((d, i) => (
                  <rect key={d.date} x={x(i) - 6} y={y(d.success)} width="12" height={97 - y(d.success)} />
                ))
              ) : (
                <polyline points={dates.map((d, i) => x(i) + "," + y(d.failed)).join(" ")} />
              )}
            </g>
          )}
          {observed > 0 &&
            dates.map((d, i) => (
              <rect key={d.date} x={i * 20} y={0} width="20" height="100" fill="transparent">
                <title>
                  {d.date} · 成功 {fmt(d.success)} 次 · 失败 {fmt(d.failed)} 次
                </title>
              </rect>
            ))}
        </svg>
      </div>
    );
  };
  return (
    <section className="om-panel om-trend">
      <header className="omt-header">
        <div>
          <h2>每日运行趋势</h2>
          <p>
            {period}-01 至 {cutoff}
            {missing > 0 && " · " + fmt(missing) + " 项未监测"}
          </p>
        </div>
        <div className="omt-legend" aria-label="期间合计">
          <span>
            <i className="omt-success-key" />
            成功 <b>{total(success)}</b>
          </span>
          <span>
            <i className="omt-fail-key" />
            失败 <b>{total(fail)}</b>
          </span>
        </div>
      </header>
      <div className="omt-chart">
        {plot("success", "成功")}
        {plot("failed", "失败")}
        <div className="omt-dates" style={{ gridTemplateColumns: `repeat(${n},minmax(0,1fr))` }}>
          {Array.from(new Set(Array.from({ length: 5 }, (_, i) => Math.round((i * (n - 1)) / 4)))).map((i) => (
            <span key={i} style={{ gridColumn: i + 1 }}>
              {i + 1}日
            </span>
          ))}
        </div>
      </div>
      <details className="omt-data">
        <summary>查看逐日次数</summary>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>成功（次）</th>
              <th>失败（次）</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                <td>{observed ? fmt(d.success) : "—"}</td>
                <td>{observed ? fmt(d.failed) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {success + fail === 0 && (
        <p className="al-caption" role="status">
          {!snapshot.assets.length
            ? "当前筛选范围内没有资产"
            : !observed
              ? "当前范围的资产均无监测接入记录"
              : "已监测资产在此期间没有执行或调用记录"}
        </p>
      )}
    </section>
  );
}
