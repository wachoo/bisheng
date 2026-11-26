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
    await page.goto(base + "/leadboard?" + params);
    const board = page.locator("#strategy-cockpit");
    for (const [key,n] of [["uses",data.scene_service.uses],["users",data.scene_service.users],["construction",data.strategy.scene_launched]]) {
      assert.equal(Number(await board.locator('[data-capacity="'+key+'"] b').innerText()),n);
    }
    assert.equal(Number(await board.locator(".knowledge-total b").innerText()),data.strategy.knowledge_verified);
    await board.getByRole("button",{name:"采集验收1126·采购协同",exact:true}).click();
    await board.getByRole("heading",{name:"采集验收1126·采购报价助手"}).waitFor();
    async function screenshot(name) {
      if (!process.env.BOARD_EVIDENCE_DIR) return;
      fs.mkdirSync(process.env.BOARD_EVIDENCE_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.BOARD_EVIDENCE_DIR,name+".png"),animations:"disabled"});
    }
    await screenshot("live-strategy");
    await board.locator('[data-capacity="uses"]').click();
    await page.getByRole("button",{name:/采集验收1126·履约核查助手/}).first().waitFor();
    for (const [url,label] of [
      ["/leadboard?view=impact&", "作业工时"], ["/leadboard?view=activity&", "本月 Token 消耗"],
      ["/monitorboard?", "资产健康分布"]]) {
      await page.goto(base + url + params);
      await page.getByText(label,{exact:true}).first().waitFor();
    }
    await screenshot("live-monitor");
    console.log("Four pages rendered; strategy service totals, deployment count, knowledge total and employee drilldown reconciled.");
  } finally {await browser.close();}
}
main().catch(e => {console.error(e.message);process.exitCode=1;});
