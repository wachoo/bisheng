// The UI is the local product. Asset creation and mutation requests are intercepted before they reach the development DB.
const assert = require("node:assert/strict");
const {chromium} = require(require.resolve("playwright", {paths:[process.cwd()]}));
const base = "http://127.0.0.1:3001";
const year = new Date().getFullYear();
const defaultTopic = "00000000-0000-4000-a000-000000000001";
const topic = "00000000-0000-4000-a000-000000000002";
const category = "00000000-0000-4000-a000-000000000003";
const opts = {year, default_topic:defaultTopic, topics:[{id:defaultTopic,name:"AI先锋行动"},{id:topic,name:"验收采购专题"}],
  categories:[{id:category,name:"采购标准"}]};
async function verifyHostedApp(page) {
  const appId = "00000000-0000-4000-a000-000000000084";
  const appPath = "/api/v1/apps/" + appId;
  const expected = "/api/v1/company-boards/asset-context/app:" + appId;
  const calls = [];
  const unexpected = [];
  let stored = {revision:3, topic:defaultTopic, scenes:[], profile:{direction:"生产"}, case_name:"", case_fields:{}};
  const reply = (route, data) => route.fulfill({json:{status_code:200,status_message:"success",data}});
  await page.route("**" + appPath + "**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") { unexpected.push(path); return route.abort(); }
    if (path === appPath) return reply(route,{
      app_id:appId, slug:"board-hosted-fixture", name:"托管应用归属验收", description:"生产排程",
      state:"draft", owner_user_id:1, tenant_id:1, current_version_id:null, pending_version_id:null,
      logo:null, create_time:null, update_time:null, entry_url:"", allowed_actions:["edit"]
    });
    if (path.endsWith("/instance")) return reply(route,{observation_state:"no_execution",phase:"stopped"});
    if (path.endsWith("/versions")) return reply(route,{data:[],total:0});
    if (path.endsWith("/secrets")) return reply(route,{revision:0,items:[],updated_at:null,runtime:{
      comparison:"not_running",saved_revision:0,changed_names:[],rebuild_operation:null}});
    if (path.endsWith("/publish-status")) return reply(route,null);
    unexpected.push(path);return route.abort();
  });
  await page.route("**/asset-context/**", async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const verb = route.request().method();
    calls.push([verb,path]);
    if (path !== expected) {unexpected.push(path);return route.abort();}
    if (verb === "GET") return reply(route,{...opts,...stored,categories:opts.categories});
    if (verb === "PUT") {
      const body = route.request().postDataJSON();
      stored = {...body,revision:body.revision+1};
      return reply(route,{revision:stored.revision});
    }
    unexpected.push(verb+" "+path);return route.abort();
  });
  await page.goto(base+"/build/apps/"+appId+"?tab=versions");
  await page.getByRole("tab",{name:"发布",exact:true}).click();
  const expand = page.getByRole("button",{name:/看板归属（选填）/});
  await expand.click();
  const picker = page.getByRole("combobox",{name:/所属专题/});
  await picker.selectOption(topic);
  await page.getByRole("button",{name:"保存",exact:true}).click();
  await page.getByRole("button",{name:"保存",exact:true}).waitFor({state:"hidden"});
  assert.deepEqual(stored,{year,revision:4,topic});
  await page.reload();
  await expand.click();
  await picker.waitFor();
  assert.equal(await picker.inputValue(),topic);
  assert.deepEqual(calls,[["GET",expected],["PUT",expected],["GET",expected]]);
  assert.deepEqual(unexpected,[]);
}

async function main() {
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const page = await browser.newPage({storageState:process.env.BOARD_SESSION, viewport:{width:1440,height:1000}, serviceWorkers:"block"});
    page.setDefaultTimeout(8000);
    let creates = 0, writes = 0, data, isolatedOptions = true;
    const unsafe = [];
    const savedLibraries = [];
    const reply = (route, payload) => route.fulfill({json:{status_code:200,data:payload,status_message:"success"}});
    await page.route("**/api/**", async route => {
      const {pathname} = new URL(route.request().url());
      const verb = route.request().method();
      if (isolatedOptions && pathname.endsWith("/asset-context/options")) return reply(route,opts);
      if (pathname === "/api/v1/llm/knowledge" && verb === "GET") return reply(route,{embedding_model_id:99});
      if (pathname === "/api/v1/knowledge/create" && verb === "POST")
        return reply(route,{id:900000000 + route.request().postDataJSON().type});
      if (decodeURIComponent(pathname).match(/\/asset-context\/knowledge:90000000[01]$/) && verb === "PUT") {
        savedLibraries.push(route.request().postDataJSON());
        return reply(route,{revision:1});
      }
      if (pathname.endsWith("/api/v1/assistant") && verb === "POST") { creates++;return reply(route,{id:"asset-entry-test"}); }
      if (pathname.endsWith("/asset-context/assistant:asset-entry-test") || pathname.endsWith("/asset-context/assistant%3Aasset-entry-test")) {
        if (verb === "PUT") {
          writes++;
          if (writes === 1) return route.fulfill({status:503,json:{detail:"Temporary isolated fixture failure"}});
          data = route.request().postDataJSON();
          return reply(route,{revision:1});
        }
        return reply(route,{...opts,...data,categories:opts.categories,revision:1});
      }
      // Allow the product's read-only POST lookup endpoints while explicitly blocking resource mutations.
      if (["DELETE","PUT","PATCH"].includes(verb) || verb === "POST" && /\/(?:create|save|update|import|copy|action|publish|upload)(?:\/|$)/.test(pathname)) {
        unsafe.push(verb+" "+pathname);return route.abort();
      }
      if (verb === "GET" && /\/assistant\/asset-entry-test$/.test(pathname))
        return reply(route,{id:"asset-entry-test", name:"资产归属验收助手", status:1, prompt:"", desc:"", assistant_name:"资产归属验收助手", tool_list:[], knowledge_list:[]});
      return route.continue();
    });
    await page.goto(base+"/build/apps");
    await page.getByText("新建应用",{exact:true}).first().click();
    const templates=page.getByRole("dialog");
    await templates.getByText("助手",{exact:true}).first().click();
    await templates.getByText("自定义助手",{exact:true}).click();
    const form=page.getByRole("dialog").filter({has:page.locator("#name")});
    await form.locator("#name").fill("资产归属验收助手");
    await form.getByRole("button",{name:/看板归属（选填）/}).click();
    const picker=form.getByRole("combobox",{name:/所属专题/});
    assert.equal(await picker.inputValue(),defaultTopic);
    await picker.selectOption(topic);
    for (const label of ["业务方向","代表案例名称","关联计划场景"])
      assert.equal(await form.getByText(label,{exact:true}).count(),0);
    await form.getByRole("button",{name:"创建",exact:true}).click();
    await form.getByRole("alert").filter({hasText:"业务资料未保存"}).waitFor();
    assert.equal(creates,1);
    await form.getByRole("button",{name:"创建",exact:true}).click();
    await page.waitForURL("**/assistant/asset-entry-test");
    assert.equal(creates,1);assert.equal(writes,2);
    assert.deepEqual(data,{year,revision:0,topic});
    await page.goto(base+"/build/apps");
    await page.getByText("新建应用",{exact:true}).first().click();
    await page.getByRole("dialog").getByText("自定义工作流",{exact:true}).click();
    await page.getByRole("button",{name:/看板归属（选填）/}).click();
    assert.equal(await page.getByRole("combobox",{name:/所属专题/}).inputValue(),defaultTopic);
    async function verifyLiveFields() {
      await page.getByRole("button",{name:"看板归属（选填）"}).click();
      const select = page.getByRole("combobox",{name:/所属专题/});
      await select.waitFor();
      assert((await select.locator("option").allTextContents()).includes("AI先锋行动"));
    }
    for (const kb of ["文档知识库","QA知识库"]) {
      await page.goto(base+"/filelib");
      await page.getByRole("tab",{name:kb}).first().click();
      await page.getByRole("button",{name:"创建",exact:true}).click();
      await verifyLiveFields();
      const choice = page.getByLabel("业务分类",{exact:true});
      await choice.click();
      await page.getByRole("option",{name:"采购标准"}).click();
      for (const label of ["业务方向","看板业务说明","代表案例名称"]) assert.equal(await page.getByLabel(label,{exact:true}).count(),0);
      await page.getByRole("dialog").locator('input[name="name"]').fill("隔离业务分类验收");
      const saved = page.waitForResponse(r=>r.request().method()==="PUT" && decodeURIComponent(r.url()).includes("/asset-context/knowledge:"));
      await Promise.all([saved, page.getByRole("dialog").getByRole("button",{name:"完成创建",exact:true}).click()]);
      assert.deepEqual(savedLibraries.at(-1),{year,revision:0,topic:defaultTopic,knowledge_category_id:category});
    }
    isolatedOptions = false;
    for (const [tab,action] of [["API工具","创建API工具"],["MCP工具","添加MCP服务器"],["技能","新建技能"],["技能","导入技能"]]) {
      await page.goto(base+"/build/tools");
      await page.getByText(tab,{exact:true}).first().click();
      await page.getByText(action,{exact:true}).first().click();
      await verifyLiveFields();
    }
    await page.goto(base+"/build/tools");
    await page.getByText("技能",{exact:true}).first().click();
    const firstSkill = page.locator("tbody tr").filter({has:page.getByRole("switch")}).first();
    await firstSkill.locator("td").first().click();
    await page.getByRole("button",{name:/编辑/}).first().click();
    await verifyLiveFields();
    assert.equal(await page.getByLabel("Skill 规则摘要",{exact:true}).count(),0);
    await verifyHostedApp(page);
    assert.deepEqual(unsafe,[]);
    console.log("Verified topic-only asset forms, knowledge category selection and idempotent retries.");
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
