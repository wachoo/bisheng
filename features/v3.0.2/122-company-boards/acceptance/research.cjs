// Writes only to register_fixture's in-memory database on loopback.
const assert = require("node:assert/strict");
const path = require("node:path");
const {chromium} = require(require.resolve("playwright", {paths: [process.cwd()]}));
const origin = "http://127.0.0.1:3001";
const fixture = "http://127.0.0.1:17862";
const year = 2025;
const may = {projects:24,ai_projects:6,active_ai_projects:3,budget:123.75,spending:6.125,
  outstanding:18.5,valued_scenes:4,labor_value:20.64,direct_savings:4.35,equivalent_days:10.5,equivalent_value:3.125};
const subjectName = "科研经营填报验收课题";
const subjectProject = "经营快报验证项目";

async function main() {
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const context = await browser.newContext({
      storageState:process.env.BOARD_SESSION, viewport:{width:1440,height:1000}, serviceWorkers:"block",
    });
    const get = async url => {
      const response = await context.request.get(fixture + "/api/v1/company-boards/" + url);
      const body = await response.json();
      assert.equal(body.status_code,200);
      return body.data;
    };
    const identity = await get("overview?board=lead&year=2026&month=5");
    assert.deepEqual(identity.assets.map(a => a.name).sort(),
      ["验证员工","验证工具","验证知识库","验证技能"].sort(), "expected disposable fixture");
    await context.route("**/api/v1/company-boards/**", async route => {
      const req = route.request(), url = new URL(req.url());
      const reply = await context.request.fetch(fixture + url.pathname + url.search,{
        method:req.method(), ...(req.postData() ? {data:req.postData(),headers:{"Content-Type":"application/json"}} : {}),
      });
      await route.fulfill({response:reply});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(9000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const inspect = month => get("research-report?board=lead&year=" + year + "&month=" + month);
    const readForm = async month => {
      await page.goto(origin + "/board-ledger/research?year=" + year + "&month=" + month);
      await page.locator("#research-projects").waitFor();
    };
    const save = async () => {
      await page.getByRole("button",{name:"保存本月数据"}).click();
      await page.getByRole("status").filter({hasText:"本月数据已保存"}).waitFor();
    };
    await readForm(5);
    await page.locator("#research-spending").fill("0");
    for (const [key,value] of Object.entries(may)) await page.locator("#research-" + key).fill(String(value));
    if (!(await inspect(5)).subjects.some(s => s.name === subjectName)) {
      await page.getByRole("button", {name:"添加课题"}).click();
      const row = page.locator('input[id^="research-subject-"][id$="name"]').last();
      await row.fill(subjectName);
      await page.getByLabel(/^所属项目/).last().fill(subjectProject);
      await page.getByLabel(/^开始日期/).last().fill("2025-02-01");
      await page.getByRole("checkbox",{name:"AI 课题"}).last().check();
    }
    await save();
    await page.reload();
    assert.equal(await page.locator("#research-outstanding").inputValue(),"18.5");
    assert(await page.getByLabel(/^课题名称/).evaluateAll(nodes => nodes.some(n => n.value === "科研经营填报验收课题")));
    const first = await inspect(5);
    for (const [key,value] of Object.entries(may)) assert.equal(Number(first.metrics[key]),value,key);
    assert(first.subjects.some(s => s.name === subjectName && s.project === subjectProject && s.ai));
    await page.setViewportSize({width:1440, height:1240});
    await page.screenshot({path:path.join(__dirname,"../screenshots/parity/research-monthly.png")});
    await page.setViewportSize({width:1440, height:1000});
    await page.locator("#research-month").click();
    await page.getByRole("option",{name:"6 月",exact:true}).click();
    await page.waitForURL(url => url.searchParams.get("month") === "6");
    await page.locator("#research-outstanding").fill("0");
    await page.locator("#research-outstanding").fill("12");
    await page.locator("#research-equivalent_days").fill("11");
    await save();
    assert.equal(Number((await inspect(5)).metrics.outstanding),18.5);
    const june = await inspect(6);
    assert.equal(Number(june.metrics.outstanding),12);
    assert.equal(june.source_month,6);
    assert.deepEqual(june.history.filter(r=>r.month ===5 || r.month ===6).map(r=>Number(r.equivalent_days)),[10.5,11]);
    async function verifyView(month, target, metrics) {
      const query = new URLSearchParams({period:year+"-"+String(month).padStart(2,"0"),detail:"strategy:"+target,title:"经营明细"});
      await page.goto(origin+"/leadboard?"+query);
      const data = page.locator("#al-detail:visible");
      for (const [key,value] of metrics) {
        const cell = data.locator(".al-stat").filter({has:page.getByText(key,{exact:true})});
        await cell.first().waitFor();
        assert.equal(await cell.locator("strong").innerText(),value);
      }
      return data;
    }
    await verifyView(5,"spending",[["年度 AI 经费净支出（万元）","6.125"]]);
    await verifyView(6,"budget",[["在研 AI 项目全周期预算（万元）","123.75"]]);
    await verifyView(5,"receivables",[["合同本年度待收款（万元）","18.5"]]);
    await verifyView(6,"receivables",[["合同本年度待收款（万元）","12"]]);
    await verifyView(6,"forecast",[["预估年度产值合计（万元）","24.99"]]);
    const data = await verifyView(6,"research",[["AI 项目占比","25%"]]);
    await data.getByRole("button",{name:"课题",exact:true}).click();
    await data.getByRole("row").filter({hasText:subjectName}).getByText(subjectProject,{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    console.log("Research report: 11 direct metrics, subject, refresh, two periods, history and all five drilldowns verified.");
  } finally {await browser.close();}
}
main().catch(error => {console.error(error);process.exitCode=1;});
