// The browser uses the local product UI. All board writes go to register_fixture's disposable SQLite database.
const assert=require("node:assert/strict");
const path=require("node:path");
const screenshots=path.join(__dirname,"../screenshots/parity");
const {chromium}=require(require.resolve("playwright",{paths:[process.cwd()]}));
const origin="http://127.0.0.1:3001", fixture="http://127.0.0.1:17862";
const names={};
const day="2026-05-01";
(async()=>{
  const browser=await chromium.launch({channel:"chrome"});
  try{
    const context=await browser.newContext({viewport:{width:1707,height:898},storageState:process.env.BOARD_SESSION,serviceWorkers:"block"});
    const page=await context.newPage();page.setDefaultTimeout(7000);
    await context.route("**/api/v1/company-boards/**",async route=>{
      const req=route.request(),u=new URL(req.url());
      const response=await context.request.fetch(fixture+u.pathname+u.search,{method:req.method(),
        ...(req.postData()?{data:req.postData(),headers:{"Content-Type":"application/json"}}:{})});
      await route.fulfill({response});
    });
    const read=async path=>{
      const res=await context.request.get(fixture+"/api/v1/company-boards/"+path);
      const x=await res.json();assert.equal(x.status_code,200);return x.data;
    };
    assert.deepEqual((await read("overview?board=lead&year=2026&month=5")).assets.map(a=>a.name).sort(),
      ["验证员工","验证工具","验证知识库","验证技能"].sort(),"refuse to write outside disposable fixture");
    async function pick(id,name){
      await page.locator("#"+id).click();
      const choice=page.getByRole("option",{name,exact:true});
      await choice.first().click();
    }
    async function create(kind,{fields={},selects={},date=day,base=false,label}={}){
      names[kind]=label || "验收-"+kind;
      await page.goto(origin+"/board-ledger/"+kind+"?year=2026");
      await page.getByRole("button",{name:/新增|新建|添加/}).last().click();
      const dialog=page.getByRole("dialog",{name:/新增台账记录|新建台账记录/});
      assert(await dialog.isVisible(),kind+" dialog");
      const prefix=base?"cb-":"br-";
      await page.locator("#"+prefix+"name").fill(names[kind]);
      await page.locator("#"+prefix+"date").fill(date);
      for(const [key,name] of Object.entries(selects))await pick(prefix+key,name);
      for(const [key,value] of Object.entries(fields))await page.locator("#"+prefix+key).fill(value);
      const save=dialog.getByRole("button",{name:"保存",exact:true});
      assert(await save.isEnabled(),kind+" required fields");
      const saved=page.waitForResponse(r=>r.url().includes("/company-boards/")&&["PUT","POST"].includes(r.request().method()));
      await save.click();const response=await saved;
      const res=await response.json();assert.equal(res.status_code,200,kind+" "+JSON.stringify(res));
      await dialog.waitFor({state:"hidden"});await page.reload();await page.getByText(names[kind],{exact:true}).first().waitFor();
      console.log("persisted",kind);
      return res.data;
    }
    await create("goal",{base:true,fields:{target:"15",unit:"名"}});
    await create("topic",{base:true});
    await create("scene",{base:true,selects:{parent:names.topic,dept:"验证部门"}});
    await create("release",{base:true,selects:{parent:names.scene,asset:"验证员工",dept:"验证部门"}});
    await create("collection",{base:true,selects:{parent:names.topic,asset:"验证知识库"}});
    await create("scene-team",{selects:{parent:names.scene,department:"验证部门"}});
    await create("collection-meta",{selects:{parent:names.collection},fields:{category:"工程规范"}});
    await create("case",{selects:{parent:names.topic,scene:names.scene},fields:{summary:"比较两家供应商的总价及交期",action:"体验比价",input:"采购文件",sampleTitle:"供应商报价对照表",sampleTable:"供应商\t含税总价\t交货周期\n甲\t18万元\t15天\n乙\t17万元\t21天",output:"采购清单"}});
    await create("scene-asset",{selects:{parent:names.scene,asset:"验证工具"}});
    await create("asset-profile",{selects:{parent:"验证技能"},fields:{direction:"采购",description:"比价",rules:"核对数量"}});
    await create("recognition",{selects:{parent:names.scene}});
    await create("estimate",{selects:{parent:names.scene},fields:{hours:"100",hourly:"200",saving:"500"}});
    await create("value-rate",{selects:{category:"文档",unit:"文件"},fields:{hours:"2",hourly:"300"}});
    await create("project",{selects:{ai:"是"},fields:{budget:"990000"}});
    await create("subject",{selects:{parent:names.project,ai:"是"}});
    await create("expense",{selects:{parent:names.project},fields:{amount:"3000"}});
    await create("receivable",{selects:{parent:names.project},fields:{contract:"HT-01",amount:"50000"},date:"2026-08-01"});
    await create("receipt",{selects:{parent:names.receivable},fields:{amount:"12000"}});
    await create("receipt",{label:"验收-第二笔到账",selects:{parent:names.receivable},fields:{amount:"8000"},date:"2026-05-02"});
    const overview=await read("overview?board=lead&year=2026&month=5");
    assert.equal(overview.strategy.employee_target,15);assert.equal(overview.strategy.employee_built,1);
    assert.equal(overview.strategy.scene_launched,1);assert.equal(overview.strategy.knowledge_verified,1);
    await page.goto(origin+"/leadboard?period=2026-05&detail=strategy:receivables&title=合同收款");
    const amount=page.locator("#al-detail .al-receipt-summary strong");await amount.first().waitFor();
    assert.deepEqual((await amount.allTextContents()).map(x=>Number(x.replaceAll(",",""))),[5,2,3]);
    await page.goto(origin+"/board-ledger/receipt?year=2026");
    await page.getByRole("row").filter({hasText:"验收-第二笔到账"}).getByRole("button",{name:/编辑|修改/}).click();
    await page.locator("#br-amount").fill("9000");
    await page.getByRole("dialog").getByRole("button",{name:"保存"}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    await page.goto(origin+"/leadboard?period=2026-05&detail=strategy:receivables&title=合同收款");
    await amount.first().waitFor();assert.deepEqual((await amount.allTextContents()).map(Number),[5,2.1,2.9]);
    await page.screenshot({path:path.join(screenshots,"receivables-sample.png")});
    await page.goto(origin+"/leadboard?period=2026-05&detail=strategy:forecast&title=预估年度AI产值");
    await page.getByText(names.scene,{exact:false}).last().waitFor();
    await page.goto(origin+"/leadboard?period=2026-05");
    const sample = page.locator("#strategy-cockpit").getByRole("table").first();
    await sample.locator("thead th").first().waitFor();
    assert.deepEqual(await sample.locator("thead th").allTextContents(), ["供应商","含税总价","交货周期"]);
    assert.equal(await sample.locator("tbody tr").count(), 2);
    await page.screenshot({path:path.join(screenshots,"strategy-registered-sample.png")});
    await page.getByRole("button",{name:/体验比价/}).click();
    await page.getByText("采购文件",{exact:true}).last().waitFor();
    await page.goto(origin+"/leadboard?period=2026-05&detail=strategy:candidates&title=场景价值榜");
    await page.getByText(names.scene,{exact:false}).last().waitFor();
    const sceneStats=overview.scene_usage.find(s=>s.name===names.scene);
    assert.equal(sceneStats.month,1);assert.equal(sceneStats.year,1);assert.equal(sceneStats.positive_rate,1);
    console.log("18 forms saved and reloaded; 5/2/3 → 5/2.1/2.9 万元; targets and published assets reconciled.");
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
