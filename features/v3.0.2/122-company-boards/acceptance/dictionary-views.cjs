const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const base = "http://127.0.0.1:3001";
const period = process.env.BOARD_PERIOD || "2026-11";
const [year, month] = period.split("-").map(Number);
const previous = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
const percent = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "—";

async function report(page, endpoint, board, selected = period) {
  const [year, month] = selected.split("-").map(Number);
  const response = await page.request.get(base + "/api/v1/company-boards/" + endpoint, {
    params: { year, month, board },
  });
  assert.equal(response.status(), 200, endpoint);
  const body = await response.json();
  assert.equal(body.status_code, 200, endpoint);
  return body.data;
}

async function verifyCloud(page) {
  const overview = await report(page, "overview", "lead");
  const trends = await report(page, "trends", "lead");
  const counts = new Map();
  for (const row of trends.months[month - 1].rows.filter(r => r.kind === "employee"))
    counts.set(row.asset_id, (counts.get(row.asset_id) || 0) + row.successful);
  await page.goto(base + "/leadboard?view=impact&period=" + period);
  const buttons = page.locator("[data-bubble-topic]");
  const dots = page.locator(".al-bubble");
  await dots.first().waitFor();
  const measure = () => dots.evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.app, uses: Number(node.dataset.uses), width: node.getBoundingClientRect().width,
  })));
  const all = await measure();
  const expectedIds = overview.assets.filter(a => a.kind === "employee" && counts.get(a.id) > 0).map(a => a.id);
  assert.deepEqual(all.map(d => d.id).sort(), expectedIds.sort());
  const peaks = new Set(), reference = Math.max(...all.map(d => d.width));
  const topics = overview.ledger.filter(r => r.kind === "topic");
  assert.deepEqual(await buttons.evaluateAll(nodes => nodes.map(b => b.dataset.bubbleTopic).sort()),
    ["all", ...topics.map(t => t.id)].sort());
  for (const topic of topics) {
    await page.locator('[data-bubble-topic="' + topic.id + '"]').click();
    const members = new Set(overview.assets.filter(a => a.topic_id === topic.id).map(a => a.id));
    for (const scene of overview.ledger.filter(r => r.kind === "scene" && r.parent_id === topic.id)) {
      for (const assetId of overview.scene_asset_links[scene.id] || []) members.add(assetId);
    }
    const current = await measure();
    assert.deepEqual(current.map(d => d.id).sort(), expectedIds.filter(id => members.has(id)).sort());
    if (!current.length) continue;
    const peak = Math.max(...current.map(d => counts.get(d.id)));
    peaks.add(peak);
    for (const dot of current) {
      assert.equal(dot.uses, counts.get(dot.id));
      const expected = Math.max(10, reference * Math.sqrt(dot.uses / peak));
      assert.ok(Math.abs(dot.width - expected) < 1, "bubble diameter for " + dot.id);
    }
  }
  assert.ok(peaks.size >= 2, "Use a sample with different maxima in two topics");
  console.log("B013", JSON.stringify({uses: all.map(r => r.uses), peaks: [...peaks], diameter: reference}));
}

async function verifyMonitoring(page) {
  await page.goto(base + "/monitorboard?period=" + period);
  const snapshot = await report(page, "monitoring", "monitor");
  const known = snapshot.assets.filter(a => a.monitored);
  const ok = known.reduce((n, a) => n + a.success, 0);
  const fail = known.reduce((n, a) => n + a.failed, 0);
  assert.ok(known.length > 0, "Sample needs monitored assets");
  const groups = {"未监测": 0, "暂无执行": 0, "正常": 0, "关注": 0, "异常": 0};
  for (const a of snapshot.assets) {
    let state = "未监测";
    if (a.monitored) {
      const attempts = a.success + a.failed;
      if (!attempts) state = "暂无执行";
      else if (a.kind === "employee") state = a.success / attempts >= 0.98 ? "正常" : a.success / attempts >= 0.95 ? "关注" : "异常";
      else state = a.failed / attempts > 0.05 ? "异常" : "正常";
    }
    groups[state]++;
  }
  await page.locator(".om-legend-row").first().waitFor();
  const metrics = await page.locator(".om-metric > strong").allTextContents();
  assert.deepEqual(metrics, [snapshot.assets.length + "项", percent(ok, ok + fail), fail + "次", groups["异常"] + "项"]);
  assert.equal(await page.locator(".om-ring strong").textContent(), percent(known.length, snapshot.assets.length));
  for (const [state, size] of Object.entries(groups)) {
    const row = page.locator('.om-legend-row[data-op-drill="' + state + '"]');
    assert.equal(await row.locator("strong").textContent(), String(size));
    assert.equal(await row.locator("small").textContent(), percent(size, snapshot.assets.length));
  }
  assert.equal(snapshot.days.reduce((sum, r) => sum + r.success, 0), ok);
  assert.equal(snapshot.days.reduce((sum, r) => sum + r.failed, 0), fail);
  assert.deepEqual(await page.locator(".omt-legend b").allTextContents(), [ok + " 次", fail + " 次"]);
  console.log("M006–M020", JSON.stringify({assets: snapshot.assets.length, known: known.length, ok, fail, groups}));
}

async function verifyHistory(page) {
  const o = await report(page, "overview", "lead", previous);
  const tr = await report(page, "trends", "lead", previous);
  const pm = Number(previous.slice(5));
  assert.notEqual(o.catalog_as_of.slice(0, 7), previous);
  assert.ok(tr.months[pm - 1].rows.every(r => r.tokens === null), "Choose a previous month without token receipts");
  await page.goto(base + "/leadboard?view=activity&period=" + previous);
  const catalog = page.locator('.al-stat[data-detail="activity-catalog"]');
  await catalog.locator("[data-unavailable]").waitFor();
  await page.locator('.al-stat[data-detail="tokens"] [data-unavailable]').waitFor();
  await catalog.click();
  const detail = page.locator("#al-detail:visible");
  await detail.getByText("历史目录仅展示已登记首发日期且当前仍在目录内的资产。").waitFor();
  const eligible = o.assets.filter(a => a.published_at && a.published_at <= o.cutoff);
  for (const kind of ["employee", "knowledge", "skill", "tool"]) {
    const count = await detail.locator('.va-kpi').filter({has: page.locator('[data-detail="activity-catalog:' + kind + '"]')}).locator("b").textContent();
    assert.equal(parseInt(count, 10), eligible.filter(a => a.kind === kind).length);
  }
  console.log("A001/A004/history", JSON.stringify({previous, surviving: eligible.length, tokens: null}));
}

async function verifyAssetDetails(page) {
  const overview = await report(page, "overview", "lead");
  const trend = await report(page, "trends", "lead");
  const periodRows = trend.months[month - 1].rows;
  const kbUses = new Map();
  for (const row of periodRows.filter(r => r.kind === "knowledge"))
    kbUses.set(row.asset_id, (kbUses.get(row.asset_id) || 0) + row.successful);
  const days = Number(overview.cutoff.slice(-2));
  function display(n, digits = 2) {
    if (n === null) return "—";
    const precision = n > 0 && n < 10 ** -digits ? Math.min(8, 1 - Math.floor(Math.log10(n))) : digits;
    return n.toLocaleString("zh-CN", {maximumFractionDigits: precision});
  }
  const rate = (n, d) => d ? display(100 * n / d, 1) + "%" : "—";
  const failures = [];
  let observed = 0;
  for (const asset of overview.assets) {
    try {
      const query = new URLSearchParams({period, detail: "asset:" + asset.id});
      const fetched = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith("/company-boards/asset-activity") && url.searchParams.get("asset") === asset.id;
      });
      await page.goto(base + "/leadboard?" + query);
      const result = await (await fetched).json();
      assert.equal(result.status_code, 200);
      const {known, series, last} = result.data;
      const skill = asset.kind === "skill";
      const employee = asset.kind === "employee";
      const key = skill ? "entered" : "success";
      const success = series.reduce((n, r) => n + r[key], 0);
      const failed = series.reduce((n, r) => n + r.failed, 0);
      const rows = periodRows.filter(r => r.asset_id === asset.id && r.kind === asset.kind);
      assert.equal(success, rows.reduce((n, r) => n + r[skill ? "entered" : "successful"], 0));
      assert.equal(failed, rows.reduce((n, r) => n + r.failed, 0));
      if (known) observed++;
      const attempts = success + failed;
      const expected = [];
      if (employee) {
        const sum = field => rows.reduce((n, r) => n + r[field], 0);
        const rating = sum("linked") === success ? rate(success - sum("negative"), success) : "—";
        expected.push(display(known ? attempts : null), display(sum("timed") ? sum("active_seconds") / 3600 : null),
          rating, rate(success, attempts));
      } else {
        expected.push(display(known ? success : null), display(known ? success / days : null));
        if (skill) {
          const stamp = last && (/[Z+]/.test(last) ? last : last + "Z");
          expected.push(stamp ? new Date(stamp).toLocaleDateString("sv-SE", {timeZone: "Asia/Shanghai"}) : "—");
        } else {
          const higher = overview.assets.filter(a => a.kind === "knowledge" && kbUses.get(a.id) > success).length;
          expected.push(asset.kind === "knowledge" ? display(known && success ? 1 + higher : null) : display(known ? failed : null),
            rate(success, attempts));
        }
      }
      const selector = employee ? "#al-detail .wm-kpi strong" : "#al-detail .va-kpi b";
      // The asset history and period totals resolve independently.
      await page.waitForFunction(({selector, expected}) => {
        const values = Array.from(document.querySelectorAll(selector), el => el.firstChild.textContent);
        return JSON.stringify(values) === JSON.stringify(expected);
      }, {selector, expected});
    } catch (error) {
      failures.push(asset.kind + " · " + asset.name + ": " + error.message);
    }
  }
  assert.deepEqual(failures, []);
  console.log("Single-asset KPI cards", JSON.stringify({checked: overview.assets.length, observed}));
}

(async () => {
  assert.ok(process.env.BOARD_SESSION, "Set BOARD_SESSION to local authenticated Playwright storageState.");
  const browser = await chromium.launch({channel: process.env.BOARD_BROWSER || "chrome"});
  try {
    const page = await browser.newPage({storageState: process.env.BOARD_SESSION, viewport: {width: 1600, height: 1000}});
    page.setDefaultTimeout(12000);
    await verifyCloud(page);
    await verifyMonitoring(page);
    await verifyHistory(page);
    await verifyAssetDetails(page);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
