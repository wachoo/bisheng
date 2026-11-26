const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

// Read-only reconciliation of the locally installed UI with its own reporting API.
async function main() {
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const page = await browser.newPage({storageState:process.env.BOARD_SESSION,
      viewport:{width:1600,height:1000},reducedMotion:"reduce"});
    const base = "http://127.0.0.1:3001";
    const params = "period=2026-11";
    const response = await page.request.get(base + "/api/v1/company-boards/overview?board=lead&year=2026&month=11");
    const body = await response.json();
    assert.equal(body.status_code,200);
    const data = body.data;
    const annualResponse = await page.request.get(base + "/api/v1/company-boards/overview?board=lead&year=2026");
    const annual = (await annualResponse.json()).data;
    const trendResponse = await page.request.get(base + "/api/v1/company-boards/trends?board=lead&year=2026&month=11");
    const series = (await trendResponse.json()).data;
    const ytd = series.year;
    function count(kinds, field) {
      return ytd.rows.filter(row => kinds.includes(row.kind)).reduce((total,row) => {
        assert.equal(typeof row[field], "number");
        return total + row[field];
      }, 0);
    }
    const tasks = ytd.rows.length ? count(["employee"], "successful") : null;
    const deliveries = ytd.rows.length && ytd.files_known ? count(["file","version"], "successful") : null;
    const rated = tasks && tasks === count(["employee"], "linked")
      ? (tasks - count(["employee"], "negative")) / tasks : null;
    if (annual.cutoff === data.cutoff) {
      assert.equal(tasks, annual.runtime.successful_tasks);
      assert.equal(deliveries, annual.runtime.deliverables);
      if (rated === null) assert.equal(annual.satisfaction.positive_rate, null);
      else assert.ok(Math.abs(rated - annual.satisfaction.positive_rate) < 0.0001);
    }
    await page.goto(base + "/leadboard?" + params);
    const board = page.locator("#strategy-cockpit");
    for (const [key,n] of [["uses",data.scene_service.uses],["users",data.scene_service.users],["construction",data.strategy.scene_launched]]) {
      assert.equal(Number(await board.locator('[data-capacity="'+key+'"] b').innerText()),n);
    }
    assert.equal(Number(await board.locator(".knowledge-total b").innerText()),data.strategy.knowledge_verified);
    const featured = data.ledger.filter(row => row.kind === "topic" && row.is_featured);
    for (let i = 0; i < featured.length; i++) {
      if (i > 0) await board.getByRole("button", {name:"下一个重点专题"}).click();
      assert.equal(await board.locator(".focus-topic-name").innerText(), featured[i].name);
    }
    if (!featured.length) await board.locator(".focus-empty").waitFor();
    const highest = data.strategy.knowledge_categories.filter(row => row.target > 0)
      .sort((a,b) => b.completed/b.target - a.completed/a.target || b.completed-a.completed || a.name.localeCompare(b.name,"zh-CN"))
      .slice(0,4);
    assert.deepEqual(await board.locator(".knowledge-row dt").allTextContents(), highest.map(row=>row.name));
    await board.getByRole("button",{name:"数字员工使用",exact:true}).click();
    const employees = data.scene_service.employees;
    async function screenshot(name) {
      if (!process.env.BOARD_EVIDENCE_DIR) return;
      fs.mkdirSync(process.env.BOARD_EVIDENCE_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.BOARD_EVIDENCE_DIR,name+".png"),animations:"disabled"});
    }
    await screenshot("live-strategy");
    await board.locator('[data-capacity="uses"]').click();
    if (employees.length) await page.getByRole("button",{name:employees[0].name+" ↗",exact:true}).first().waitFor();
    for (const [url,label] of [
      ["/leadboard?view=impact&", "作业工时"], ["/leadboard?view=activity&", "本月 Token 消耗"],
      ["/monitorboard?", "资产健康分布"]]) {
      await page.goto(base + url + params);
      await page.getByText(label,{exact:true}).first().waitFor();
      async function metric(key, value) {
        const field = page.locator('.al-stat[data-detail="'+key+'"] .al-stat-value').first();
        if (value === null) {
          await page.locator('.al-stat[data-detail="'+key+'"] [data-unavailable]').first().waitFor();
        } else {
          await page.waitForFunction(({key,value}) =>
            document.querySelector('.al-stat[data-detail="'+key+'"] .al-stat-value')?.innerText.replaceAll(",","") === value,
            {key,value});
          assert.equal((await field.innerText()).replaceAll(",",""), value);
        }
      }
      if (url.includes("impact")) {
        await metric("applications:year", tasks === null ? null : tasks+"次");
        await metric("deliveries:year", deliveries === null ? null : deliveries+"件");
        await metric("ratings", rated === null ? null :
          new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1}).format(rated*100)+"%");
        await screenshot("live-impact");
      }
      if (url.includes("activity")) {
        const uses = data.runtime.department_usage.reduce((n,row)=>n+row.count,0);
        await metric("asset-usage",series.months[10].rows.length ? uses+"次" : null);
      }
    }
    await screenshot("live-monitor");
    console.log("Four pages rendered; strategy service totals, deployment count, knowledge total and employee drilldown reconciled.");
  } finally {await browser.close();}
}
main().catch(e => {console.error(e.message);process.exitCode=1;});
