// Use a signed-in local administrator's Playwright storage state (BOARD_SESSION).
// QA libraries use the synthetic embedding service solely for test data.
// This program only creates resources with its dedicated names.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {randomUUID} = require("node:crypto");
const {request} = require(require.resolve("playwright", {paths: [process.cwd()]}));

const baseURL = "http://127.0.0.1:3001";
const prefix = "采集验收1126·";
const provider = "http://board1126-assets:8126";
const apiBase = "/api/v1/";
const year = Number(process.env.BOARD_YEAR || new Date().getFullYear());
const month = Number(process.env.BOARD_MONTH || new Date().getMonth() + 1);
const questions = ["验收采购报价的复核规则是什么？"];
const answer = "验收规则 K-1126：比较含税总价、交期，并留存复核记录。";
const employeeNames = ["采购报价助手", "履约核查助手"].map(n => prefix + n);
const topicNames = ["采购协同", "工程履约"].map(n => prefix + n);

async function main() {
  assert(process.env.BOARD_SESSION, "Set BOARD_SESSION to a local sign-in storage state.");
  const http = await request.newContext({baseURL, storageState: process.env.BOARD_SESSION, timeout: 120000});
  let managementTenant;
  async function call(method, path, options) {
    const headers = managementTenant ? {"X-Management-Tenant":String(managementTenant)} : {};
    const reply = await http[method](apiBase + path, {...options, headers});
    const body = await reply.json();
    if (body.status_code !== 200) {
      throw new Error([method, path, reply.status(), body.status_code, JSON.stringify(body.status_message)].join(" "));
    }
    return body.data;
  }
  const get = path => call("get", path);
  const post = (path, data) => call("post", path, {data});
  const put = (path, data) => call("put", path, {data});
  const board = () => get("company-boards/overview?board=lead&year=" + year + "&month=" + month);
  async function mark(key, topic, category) {
    const route = "company-boards/asset-context/" + encodeURIComponent(key);
    const current = await get(route);
    if (current.topic === topic && (!category || current.knowledge_category_id === category)) return;
    await put(route, {year, topic, revision: current.revision ?? 0, ...(category && {knowledge_category_id: category})});
  }
  function counts(b) {
    const counts = Object.fromEntries(["employee","knowledge","tool","skill"].map(k => [k,b.assets.filter(a=>a.kind===k).length]));
    return {...counts, built: b.strategy.employee_built,
      classified: b.strategy.knowledge_categories.find(c=>c.name===prefix+"供应链规则")?.completed ?? 0};
  }
  async function step(label, differences, operation) {
    const before = counts(await board());
    console.log(label, "expected", JSON.stringify(differences));
    const result = await operation();
    const after = counts(await board());
    for (const [key, delta] of Object.entries(differences)) {
      assert.equal(after[key] - before[key], delta, label + ": " + key + " " + JSON.stringify({before,after}));
    }
    const item = {step:label,expected:differences,before,after};
    if (process.env.BOARD_ASSET_LOG) fs.appendFileSync(process.env.BOARD_ASSET_LOG, JSON.stringify(item)+"\n");
    console.log(label, JSON.stringify({before,after}));
    return result;
  }
  try {
    const me = await get("user/info");
    managementTenant = me.tenant_id || me.leaf_tenant_id;
    if (me.is_global_super) {
      const scope = await get("admin/tenant-scope");
      if (scope.scope_tenant_id && scope.scope_tenant_id !== managementTenant) throw new Error("Different tenant already selected.");
      if (!scope.scope_tenant_id) await post("admin/tenant-scope",{tenant_id:managementTenant});
    }
    const options = await get("company-boards/asset-context/options?year="+year);
    const topics = topicNames.map(name => options.topics.find(t=>t.name===name)?.id);
    const category = options.categories.find(c=>c.name===prefix+"供应链规则")?.id;
    assert(topics.every(Boolean) && category, "Run the annual plan tasks first.");
    const models = await get("llm");
    let embedding = models.find(s=>s.name===prefix+"本地向量服务");
    if (!embedding) {
      await post("llm",{name:prefix+"本地向量服务",type:"openai",share_to_children:false,
        config:{openai_api_base:provider+"/v1",openai_api_key:"local-fixture"},
        models:[{name:prefix+"向量模型",model_name:"board1126-embedding",model_type:"embedding",online:true}]});
      embedding = (await get("llm")).find(s=>s.name===prefix+"本地向量服务");
    }
    const catalog = (await board()).assets;
    const kbName = prefix+"采购规则问答库";
    let kbId = catalog.find(a=>a.name===kbName)?.id.split(":")[1];
    if (!kbId) {
      const kb = await step("创建公开问答知识库",{knowledge:1,classified:0},()=>post("knowledge/create",
        {type:1,name:kbName,model:String(embedding.models[0].id),auth_type:"public",description:"采集验收专用采购规则。"}));
      kbId = kb.id;
    }
    const kbContext = await get("company-boards/asset-context/knowledge:"+kbId);
    if (kbContext.knowledge_category_id !== category) {
      await step("知识库关联年度业务分类",{knowledge:0,classified:1},()=>mark("knowledge:"+kbId,topics[0],category));
    }
    const qa = await get("knowledge/qa/list/"+kbId+"?page=1&limit=20");
    if (!(qa.data || []).some(row=>row.questions?.includes(questions[0]))) {
      await step("添加一条采购验收问答",{knowledge:0,classified:0},()=>post("knowledge/qa/add",
        {knowledge_id:Number(kbId),questions,answers:[answer],source:1}));
    }
    const toolName = prefix+"报价服务";
    let tool = (await get("tool?is_preset=2&action=visible")).find(t=>t.name===toolName);
    if (!tool) {
      const conf = {mcpServers:{quote:{name:toolName,url:provider+"/mcp",type:"streamable",description:"验收供应商报价"}}};
      const schema = await post("tool/mcp/schema",{file_content:JSON.stringify(conf)});
      assert.deepEqual(schema.children.map(x=>x.name),["board1126_quote"]);
      tool = await step("通过 MCP 发现并创建报价工具",{tool:1},()=>post("tool",schema));
    }
    await mark("toolset:"+tool.id,topics[0]);
    const child = tool.children.find(c=>c.name==="board1126_quote");
    const slug = "board1126-quote-check";
    let skill = (await get("linsight/skill?keyword="+slug)).data.find(s=>s.name===slug);
    if (!skill) {
      skill = await step("创建管理员公共 Skill",{skill:1},()=>call("post","linsight/skill",{multipart:{
        display_name:prefix+"报价复核规范",name:slug,description:"验收采购报价复核步骤",
        content:"请调用报价工具，并核对知识库返回的采购规则；用含税总价、交期及复核记录三项作答。"}}));
    }
    await mark("skill:"+skill.id,topics[0]);
    const employees = [];
    for (const [i,name] of employeeNames.entries()) {
      let employee = (await get("assistant?name="+encodeURIComponent(name)+"&limit=20")).data.find(a=>a.name===name);
      if (!employee) {
        employee = await step("创建草稿"+name,{employee:0,built:0},()=>post("assistant",{name,prompt:"",logo:""}));
      }
      if (employee.status !== 2) {
        const model = (i===0 ? process.env.BOARD_CHAT_MODEL_ID : process.env.BOARD_SECOND_MODEL_ID) || (await get("llm/assistant/llm_list"))[0]?.id;
        assert(model,"An enabled assistant chat model is required.");
        await put("assistant",{id:employee.id,name,model_name:String(model),temperature:0.1,max_token:4096,desc:"本地采集验收测试资产",
          prompt:i===0?"你是验收采购助手。按用户指示实际加载 Skill、检索知识库、调用报价工具，将返回的原文摘要提供给用户。":"你是合同履约验收助手，给出简明中文答复。",
          tool_list:i===0?[child.id]:[],knowledge_list:i===0?[Number(kbId)]:[],skill_ids:i===0?[skill.id]:[]});
        await mark("assistant:"+employee.id,topics[i]);
        await step("正式上线"+name,{employee:1,built:1},()=>post("assistant/status",{id:employee.id,status:2}));
      }
      employees.push(employee.id);
    }
    const manifest={knowledge:Number(kbId),skill:skill.id,toolset:tool.id,tool:child.id,employees};
    const published = await board();
    const expectedTopics = [
      ["assistant:"+employees[0],topics[0]], ["assistant:"+employees[1],topics[1]],
      ["knowledge:"+kbId,topics[0]], ["tool:"+child.id,topics[0]], ["skill:"+skill.id,topics[0]],
    ];
    for (const [key, topic] of expectedTopics) {
      assert.deepEqual(published.assets.filter(a=>a.id===key).map(a=>a.topic_id),[topic],"Published asset: "+key);
    }
    const detail = await get("assistant/info/"+employees[0]);
    assert.deepEqual(detail.skill_ids,[skill.id]);
    assert.deepEqual(detail.tool_list.map(t=>t.id),[child.id]);
    assert.deepEqual(detail.knowledge_list.map(k=>k.id),[Number(kbId)]);
    const entries = await get("knowledge/qa/list/"+kbId+"?page=1&limit=20");
    const entry = entries.data.find(row=>row.questions?.includes(questions[0]));
    assert.equal(entry?.status,1,"The QA pair must be active.");
    assert.ok(entry.answers.includes("K-1126"));
    // Published assistants are visible on the board before ordinary users can use them.
    // Grant the minimum standard model to the three acceptance accounts only.
    for (const [type,id] of [...employees.map(id=>["assistant",id]),["tool",tool.id],["knowledge_library",Number(kbId)]]) {
      const route = "permissions/resources/"+type+"/"+id;
      const {data: users} = await get(route+"/grant-subjects/users?keyword="+encodeURIComponent(prefix));
      const {data: grants} = await get(route+"/grants?subject_type=user&keyword="+encodeURIComponent(prefix));
      const subjects = ["集中采购中心","财务共享中心","运营管理中心"].map(dept=>{
        const matches = users.filter(u=>u.user_name===prefix+dept);
        assert.equal(matches.length,1,"Run live-members.cjs first for "+dept);
        return String(matches[0].user_id);
      });
      const changes = subjects.filter(id=>!grants.some(g=>g.subject.id===id)).map(id=>({
        op:"ADD", model_key:"viewer", subject:{type:"user",id},
      }));
      if (changes.length) {
        const context = await get(route+"/context");
        await post(route+"/grants:mutate",{idempotency_key:randomUUID(),
          expected_resource_version:context.resource_version,expected_catalog_release_id:context.catalog_release_id,changes});
      }
    }
    if (process.env.BOARD_ASSET_MANIFEST) fs.writeFileSync(process.env.BOARD_ASSET_MANIFEST,JSON.stringify(manifest,null,2)+"\n");
    console.log("Assets", JSON.stringify(manifest));
  } finally {
    await http.dispose();
  }
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
