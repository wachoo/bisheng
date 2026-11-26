// Use a signed-in local administrator's Playwright storage state (BOARD_SESSION).
// QA libraries use the synthetic embedding service solely for test data.
// This program only creates resources with its dedicated names.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {randomUUID} = require("node:crypto");
const {request} = require(require.resolve("playwright", {paths: [process.cwd()]}));

const baseURL = "http://127.0.0.1:3001";
const fixture = require("./live-business-sample.cjs");
const provider = "http://board1126-assets:8126";
const apiBase = "/api/v1/";
const year = Number(process.env.BOARD_YEAR || new Date().getFullYear());
const month = Number(process.env.BOARD_MONTH || new Date().getMonth() + 1);
const questions = [fixture.question];
const answer = fixture.answer;
const legacyQuestion = "验收采购报价的复核规则是什么？";
const matchesQA = row => [fixture.question, legacyQuestion].some(q => row.questions?.includes(q));

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
  let manifest;
  function checkpoint(fields) {
    Object.assign(manifest,fields);
    const tmp = fixture.manifestPath+"."+randomUUID()+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(manifest,null,2)+"\n");
    fs.renameSync(tmp,fixture.manifestPath);
  }
  async function mark(key, topic, category) {
    const route = "company-boards/asset-context/" + encodeURIComponent(key);
    const current = await get(route);
    if (current.topic === topic && (!category || current.knowledge_category_id === category)) return;
    await put(route, {year, topic, revision: current.revision ?? 0, ...(category && {knowledge_category_id: category})});
  }
  function counts(b) {
    const counts = Object.fromEntries(["employee","knowledge","tool","skill"].map(k => [k,b.assets.filter(a=>a.kind===k).length]));
    return {...counts, built: b.strategy.employee_built,
      classified: fixture.named(b.strategy.knowledge_categories, fixture.category)?.completed ?? 0};
  }
  async function step(label, differences, operation, onCreated) {
    const before = counts(await board());
    console.log(label, "expected", JSON.stringify(differences));
    const result = await operation();
    if (onCreated) onCreated(result);
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
    const topics = fixture.topics.map(names => fixture.named(options.topics,names)?.id);
    const category = fixture.named(options.categories,fixture.category)?.id;
    assert(topics.every(Boolean) && category, "Run the annual plan tasks first.");
    const models = await get("llm");
    let embedding = fixture.named(models,fixture.modelServices.embedding);
    if (!embedding) {
      await post("llm",{name:fixture.modelServices.embedding[0],type:"openai",share_to_children:false,
        config:{openai_api_base:provider+"/v1",openai_api_key:"local-fixture"},
        models:[{name:"采购知识向量",model_name:"board1126-embedding",model_type:"embedding",online:true}]});
      embedding = fixture.named(await get("llm"),fixture.modelServices.embedding);
    }
    const vectorModel = embedding.models.find(m=>m.model_name==="board1126-embedding");
    assert.ok(vectorModel, "The existing embedding service uses a different model ID.");
    const catalog = (await board()).assets;
    const manifests = await fixture.assetManifests(catalog, async id=>(await get("knowledge/info?knowledge_id="+id))[0]);
    const saved = manifests.at(-1);
    manifest = {...saved, employees:[...(saved?.employees || [])]};
    const kbName = fixture.knowledge[0];
    let kbId = fixture.named(catalog.filter(a=>a.kind==="knowledge"),fixture.knowledge)?.id.split(":")[1];
    if (kbId) assert.ok(manifests.some(m=>String(m.knowledge)===kbId), "The existing library has a different ID. Supply its verified BOARD_ASSET_MANIFEST.");
    if (!kbId) {
      const kb = await step("创建公开问答知识库",{knowledge:1,classified:0},()=>post("knowledge/create",
        {type:1,name:kbName,model:String(vectorModel.id),auth_type:"public",description:"汇集物资采购定价、供应商询价和报价复核规则。"}),
        created=>checkpoint({knowledge:Number(created.id),knowledge_collection:created.collection_name}));
      kbId = kb.id;
    }
    const kbContext = await get("company-boards/asset-context/knowledge:"+kbId);
    if (kbContext.knowledge_category_id !== category) {
      await step("知识库关联年度业务分类",{knowledge:0,classified:1},()=>mark("knowledge:"+kbId,topics[0],category));
    }
    const qa = await get("knowledge/qa/list/"+kbId+"?page=1&limit=20");
    if (!(qa.data || []).some(matchesQA)) {
      await step("添加采购比价口径问答",{knowledge:0,classified:0},()=>post("knowledge/qa/add",
        {knowledge_id:Number(kbId),questions,answers:[answer],source:1}));
    }
    const toolName = fixture.tool[0];
    let tool = fixture.named(await get("tool?is_preset=2&action=visible"),fixture.tool);
    if (tool) assert.ok(manifests.some(m=>String(m.toolset)===String(tool.id)) &&
      tool.children.some(c=>c.name==="board1126_quote"), "The existing toolset is not in the verified manifest.");
    if (!tool) {
      const conf = {mcpServers:{quote:{name:toolName,url:provider+"/mcp",type:"streamable",description:"按供应商查询物资含税报价。"}}};
      const schema = await post("tool/mcp/schema",{file_content:JSON.stringify(conf)});
      assert.deepEqual(schema.children.map(x=>x.name),["board1126_quote"]);
      tool = await step("通过 MCP 发现并创建报价工具",{tool:1},()=>post("tool",schema),
        created=>checkpoint({toolset:created.id,tool:created.children.find(c=>c.name==="board1126_quote").id}));
    }
    await mark("toolset:"+tool.id,topics[0]);
    const child = tool.children.find(c=>c.name==="board1126_quote");
    const slug = "board1126-quote-check";
    let skill = (await get("linsight/skill?keyword="+slug)).data.find(s=>s.name===slug);
    if (!skill) {
      skill = await step("创建管理员公共 Skill",{skill:1},()=>call("post","linsight/skill",{multipart:{
        display_name:fixture.skill[0],name:slug,description:"规范供应商询价结果的比对与复核。",
        content:"请调用报价工具，并核对知识库返回的采购规则；用含税总价、交期及复核记录三项作答。"}}),
        created=>checkpoint({skill:created.id}));
    }
    await mark("skill:"+skill.id,topics[0]);
    const employees = [];
    for (const [i,names] of fixture.employees.entries()) {
      let employee;
      for (const alias of names) {
        employee = (await get("assistant?name="+encodeURIComponent(alias)+"&limit=20")).data.find(a=>a.name===alias);
        if (employee) break;
      }
      if (employee) assert.ok(manifests.some(m=>m.employees[i]===employee.id),
        "The existing assistant has a different ID. Supply its verified BOARD_ASSET_MANIFEST.");
      const name = employee?.name ?? names[0];
      if (!employee) {
        employee = await step("创建草稿"+name,{employee:0,built:0},()=>post("assistant",{name,prompt:"",logo:""}),
          created=>{manifest.employees[i]=created.id; checkpoint({});});
      }
      if (employee.status !== 2) {
        const model = (i===0 ? process.env.BOARD_CHAT_MODEL_ID : process.env.BOARD_SECOND_MODEL_ID) || (await get("llm/assistant/llm_list"))[0]?.id;
        assert(model,"An enabled assistant chat model is required.");
        await put("assistant",{id:employee.id,name,model_name:String(model),temperature:0.1,max_token:4096,
          desc:i===0?"核对供应商报价与采购定价口径。":"核查工程合同的履约条款与交付要求。",
          prompt:i===0?"你是物资采购比价助手。按用户指示调用报价复核技能、检索定价指引、查询供应商报价，并概括差异。":"你是项目合同履约助手，核对合同条款并给出简明中文答复。",
          tool_list:i===0?[child.id]:[],knowledge_list:i===0?[Number(kbId)]:[],skill_ids:i===0?[skill.id]:[]});
        await mark("assistant:"+employee.id,topics[i]);
        await step("正式上线"+name,{employee:1,built:1},()=>post("assistant/status",{id:employee.id,status:2}));
      }
      employees.push(employee.id);
    }
    const collected={knowledge:Number(kbId),skill:skill.id,toolset:tool.id,tool:child.id,employees};
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
    const entry = entries.data.find(matchesQA);
    assert.equal(entry?.status,1,"The QA pair must be active.");
    assert.ok(entry.answers.includes(answer) || entry.answers.includes("K-1126"));
    // Published assistants are visible on the board before ordinary users can use them.
    // Grant the minimum standard model to the three acceptance accounts only.
    for (const [type,id] of [...employees.map(id=>["assistant",id]),["tool",tool.id],["knowledge_library",Number(kbId)]]) {
      const route = "permissions/resources/"+type+"/"+id;
      const changes = [];
      for (const member of fixture.members) {
        let user;
        for (const name of member.names) {
          const {data:users} = await get(route+"/grant-subjects/users?keyword="+encodeURIComponent(name));
          user = users.find(u=>u.external_id===member.account);
          if (user) break;
        }
        assert.ok(user, "Run live-members.cjs first for "+member.department);
        const id = String(user.user_id);
        const {data:grants} = await get(route+"/grants?subject_type=user&keyword="+encodeURIComponent(user.user_name));
        if (!grants.some(g=>String(g.subject.id)===id)) changes.push({op:"ADD",model_key:"viewer",subject:{type:"user",id}});
      }
      if (changes.length) {
        const context = await get(route+"/context");
        await post(route+"/grants:mutate",{idempotency_key:randomUUID(),
          expected_resource_version:context.resource_version,expected_catalog_release_id:context.catalog_release_id,changes});
      }
    }
    checkpoint(collected);
    console.log("Assets", JSON.stringify(collected));
  } finally {
    await http.dispose();
  }
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
