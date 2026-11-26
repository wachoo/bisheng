// Run from the project workspace. All writes go exclusively to the disposable fixture.
const assert = require("node:assert/strict");
const path = require("node:path");
const evidence = name => path.join(__dirname, "../screenshots/parity", name);
const { chromium } = require(require.resolve("playwright", {paths:[process.cwd()]}));
const base = "http://127.0.0.1:3001";
const fixture = "http://127.0.0.1:17862";
const route = "/api/v1/company-boards/";
const year = 2026;

async function main() {
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const context = await browser.newContext({storageState:process.env.BOARD_SESSION, serviceWorkers:"block",
                                              viewport:{width:1440,height:960}});
    await context.route("**/api/v1/company-boards/**", async r => {
      const req = r.request(), u = new URL(req.url());
      const opts = {method:req.method(), ...(req.postData() ? {data:req.postData(), headers:{"Content-Type":"application/json"}} : {})};
      const response = await context.request.fetch(fixture + u.pathname + u.search,opts);
      await r.fulfill({response});
    });
    async function read(path) {
      const response=await context.request.get(fixture + route + path);
      const body=await response.json();
      assert.equal(body.status_code,200);
      return body.data;
    }
    const data=await read("planning/" + year);
    assert.equal(fixture, "http://127.0.0.1:17862");
    const [owner,...support]=data.departments;
    assert(support.length>=2,"Fixture needs one lead and two supporting departments");
    const page=await context.newPage();
    page.setDefaultTimeout(9000);
    const repeat=data.items.some(item => item.name === "智慧供应链");
    const suffix=repeat ? "（" + Date.now().toString(36) + "）" : "";
    const names={topic:"智慧供应链"+suffix, scene:"采购报价比对"+suffix, kb:"工程技术"+suffix};
    const dialog=page.getByRole("dialog",{name:/^(新增|编辑)/});
    const button=name=>page.getByRole("button",{name,exact:true});
    async function pick(id,name) {
      await page.locator(id).click();
      await page.locator(id+"-listbox").getByRole("option",{name,exact:true}).click();
    }
    async function save() {
      await dialog.getByRole("button",{name:"保存",exact:true}).click();
      await dialog.waitFor({state:"hidden"});
    }
    await page.goto(base+"/board-ledger/annual?year="+year);
    await button("编辑年度目标").click();
    await page.locator("#plan-employees").fill("15");
    await page.locator("#plan-scenes").fill("7");
    await save();
    await button("新增专题").click();
    await page.locator("#plan-name").fill(names.topic);
    await save();
    await page.locator(".plan-topic").filter({has:page.getByRole("heading",{name:names.topic,exact:true})})
      .getByRole("button",{name:"新增场景计划"}).click();
    await page.locator("#plan-name").fill(names.scene);
    await pick("#plan-owner",owner.name);
    await page.locator("#plan-date").fill("2026-05-31");
    await page.locator("#plan-actual").fill("2026-06-10");
    for (const unit of support.slice(0,2)) {
      await dialog.getByRole("button",{name:"添加支持单位"}).click();
      const row=dialog.locator(".plan-support").last();
      const control = row.locator('[id^="support-"]').first();
      await pick("#" + await control.getAttribute("id"), unit.name);
    }
    await dialog.getByRole("button",{name:"添加认定期间"}).click();
    await dialog.locator(".plan-range").getByLabel("生效日期").fill("2026-06-11");
    await save();
    await page.reload();
    const row=page.getByRole("row").filter({hasText:names.scene});
    await row.waitFor();
    for (const org of [owner,...support.slice(0,2)]) assert((await row.innerText()).includes(org.name));
    await page.screenshot({path:evidence("annual-plan-sample.png"), animations:"disabled"});
    const before=await read("overview?board=lead&year=2026&month=5");
    const later=await read("overview?board=lead&year=2026&month=6");
    assert.equal(later.strategy.scene_target,7);
    assert.equal(later.strategy.employee_target,15);
    assert(later.strategy.scene_launched > before.strategy.scene_launched);
    const savedScene=later.ledger.find(s=>s.kind==="scene" && s.name===names.scene);
    assert.equal(savedScene.department_id,owner.id);
    const regs=await read("registers?board=lead&year=2026&month=6");
    assert.equal(regs.filter(r=>r.kind==="scene-team" && r.parent_id===savedScene.id).length,2);
    assert.equal(regs.filter(r=>r.kind==="recognition" && r.parent_id===savedScene.id).length,1);

    await page.goto(base+"/board-ledger/knowledge?year="+year);
    await button("新增分类计划").click();
    await page.locator("#plan-name").fill(names.kb);
    await page.locator("#plan-quantity").fill("5");
    await page.locator("#plan-date").fill("2026-12-31");
    await save();
    const plans = await read("planning/" + year);
    const category = plans.items.find(item => item.kind === "collection" && item.name === names.kb);
    assert.equal(category.target, 5);
    const asset = await read("asset-context/knowledge:1");
    const result = await context.request.put(fixture + route + "asset-context/knowledge:1", {data:{
      year, topic: asset.topic, revision:asset.revision || 0, knowledge_category_id:category.id
    }});
    assert.equal((await result.json()).status_code, 200);
    await page.reload();
    await page.getByText(names.kb,{exact:true}).first().waitFor();
    await page.screenshot({path:evidence("knowledge-plan-sample.png"), animations:"disabled"});
    const report = await read("overview?board=lead&year=" + year);
    const group = report.strategy.knowledge_categories.find(row => row.id === category.id);
    assert.equal(group.completed, 1);
    assert.equal(group.target, 5);
    const monitor = await read("overview?board=monitor&year=" + year);
    assert.equal(monitor.strategy, null);
    for (const board of [report, monitor]) {
      assert.equal(board.assets.find(asset => asset.id === "knowledge:1").knowledge_category_name, names.kb);
    }
    assert.equal((await read("planning/" + year)).knowledge_progress.find(row=>row.id===category.id).completed,1);
    await page.goto(base+"/leadboard?detail=strategy:knowledge&title=知识接入清单");
    await page.getByText(names.kb,{exact:true}).first().waitFor();
    for (const employee of ["验证员工","验证备选员工",null]) {
      await page.goto(base+"/board-ledger/annual?year="+year);
      const topicPanel = page.locator(".plan-topic").filter({has:page.getByRole("heading",{name:"AI先锋行动",exact:true})});
      const selector = topicPanel.getByRole("combobox",{name:"代表案例数字员工"});
      if (employee) {
        await selector.click();
        await page.getByRole("option",{name:employee,exact:true}).click();
      } else {
        await selector.hover();
        await topicPanel.getByLabel("清除",{exact:true}).click();
      }
      const saved = page.waitForResponse(r => r.request().method()==="PUT" && r.url().includes("/representatives/"));
      await topicPanel.getByRole("button",{name:"保存",exact:true}).click();
      assert.equal((await (await saved).json()).status_code,200);
      await page.goto(base+"/leadboard");
      await page.locator("#strategy-cockpit").getByRole("button",{name:"AI先锋行动",exact:true}).click();
      const summary = page.locator("#strategy-cockpit .brief");
      if (employee) {
        await summary.getByRole("heading",{name:employee,exact:true}).waitFor();
        if (employee === "验证员工") {
          await page.screenshot({path:evidence("topic-representative-sample.png"), animations:"disabled"});
        }
        await summary.getByRole("button",{name:/查看数字员工/}).click();
        await page.locator("#al-detail:visible").getByText(employee,{exact:true}).first().waitFor();
      } else {
        await summary.getByText("此专题尚未选择代表案例数字员工。",{exact:true}).waitFor();
      }
    }
    console.log("Annual targets, scene dates and departments, category target 5, one categorized knowledge library, and both board projections reconciled. Representative selected, replaced, opened and cleared.");
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
