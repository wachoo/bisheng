const assert = require("node:assert/strict");
const { request } = require("playwright");

const fixture = require("./live-business-sample.cjs");
const year = 2026;
const month = 11;
const day = "2026-11-26";
const root = "/api/v1/company-boards";
const planning = root + "/planning/" + year;
const {topics, scenes, employees, named} = fixture;
const categories = [["市场",4],["人资",3],["法务",4],["党建",2],["财务",5],["数字化",2]];

async function main() {
  const mode = process.argv[2];
  assert.ok(["seed", "link"].includes(mode), "Use seed, or link followed by two comma-separated asset lists");
  const ctx = await request.newContext({ baseURL: "http://127.0.0.1:3001", storageState: process.env.BOARD_SESSION });
  try {
    async function api(path, data) {
      const response = data ? await ctx.put(path, { data }) : await ctx.get(path);
      const body = await response.json();
      assert.equal(body.status_code, 200, path + " " + JSON.stringify(body.message ?? body.detail ?? ""));
      return body.data;
    }
    const plan = () => api(planning);
    const overview = () => api(root + "/overview?board=lead&year=" + year + "&month=" + month);
    const find = (p, names, kind) => named(p.items.filter(r => r.kind === kind), names);
    if (mode === "link") {
      const known = new Map();
      const manifests = await fixture.assetManifests((await plan()).assets,
        async id=>(await api("/api/v1/knowledge/info?knowledge_id="+id))[0]);
      for (const ids of manifests) {
        for (const [n,id] of ids.employees.entries()) if (id) known.set("assistant:"+id,employees[n]);
        if (ids.knowledge) known.set("knowledge:"+ids.knowledge,fixture.knowledge);
        if (ids.skill) known.set("skill:"+ids.skill,fixture.skill);
        if (ids.tool) known.set("tool:"+ids.tool,fixture.childTool);
      }
      for (const [i, names] of scenes.entries()) {
        const keys = [...new Set((process.argv[i + 3] || "").split(",").filter(Boolean))].sort();
        assert.ok(keys.length, "Both scenes need an explicit asset list");
        const p = await plan();
        for (const key of keys) assert.ok(p.assets.some(a => a.id === key && known.get(key)?.includes(a.name)), "Asset does not match the local manifest: " + key);
        const s = find(p, names, "scene");
        assert.ok(s);
        assert.equal(s.topic_id,find(p,topics[i],"topic")?.id);
        assert.equal(s.department_id,p.departments.find(d=>d.name===fixture.members[i].department)?.id);
        assert.equal(s.planned_date,day);
        const name = s.name;
        const before = await overview();
        const linkedKeys = [...new Set([...(s.asset_keys || []), ...keys])].sort();
        if (linkedKeys.length !== (s.asset_keys || []).length) {
          await api(planning, {kind:"scene", id:s.id, version:s.version, name, topic_id:s.topic_id,
            department_id:s.department_id, support_department_ids:s.support_department_ids,
            planned_date:s.planned_date, completed_date:s.completed_date, asset_keys:linkedKeys});
        }
        const after = await overview();
        assert.deepEqual([...after.scene_asset_links[s.id]].sort(), linkedKeys);
        console.log(JSON.stringify({step:"关联资产", name, keys, serviceBefore:before.scene_service, serviceAfter:after.scene_service}));
        const repPath = planning + "/representatives";
        const reps = await api(repPath);
        const eligible = reps.employees.filter(a => a.topic === s.topic_id &&
          employees[i].includes(a.name) && linkedKeys.includes(a.id));
        assert.equal(eligible.length, 1);
        const saved = reps.selections[s.topic_id];
        if (!saved?.asset) {
          await api(repPath + "/" + s.topic_id, {asset:eligible[0].id, revision:saved?.revision ?? 0});
        }
        assert.equal((await api(repPath)).selections[s.topic_id].asset, saved?.asset || eligible[0].id);
      }
      return;
    }
    let p = await plan();
    if (p.targets.scene == null) {
      await api(planning, {kind:"targets", employee:p.targets.employee, scene:2, version:p.targets.version});
      const strategy = (await overview()).strategy;
      assert.equal(strategy.scene_target, 2);
      assert.equal(strategy.employee_target, p.targets.employee);
      console.log("年度场景目标", strategy.scene_target);
    }
    for (const names of topics) {
      if (!find(p, names, "topic")) await api(planning, {kind:"topic", name:names[0], is_featured:true});
      p = await plan();
      const topic = find(p, names, "topic");
      assert.ok(topic && (await overview()).ledger.some(r => r.kind === "topic" && r.id === topic.id));
      console.log("专题可从看板回查", topic.name, topic.id);
    }
    const units = ["集中采购中心", "财务共享中心", "运营管理中心"].map(name => {
      const row = p.departments.find(d => d.name === name);
      assert.ok(row, name);
      return row.id;
    });
    for (const [name, target] of categories) {
      if (find(p, name === fixture.category[0] ? fixture.category : [name], "collection")) continue;
      const before = await overview();
      await api(planning, {kind:"collection", name, target, planned_date:year + "-12-31"});
      const after = await overview();
      assert.equal(after.strategy.knowledge_planned - before.strategy.knowledge_planned, target);
    }
    for (const [i, names] of scenes.entries()) {
      p = await plan();
      if (!find(p, names, "scene")) {
        const before = await overview();
        await api(planning, {kind:"scene", name:names[0], topic_id:find(p,topics[i],"topic").id, department_id:units[i],
          support_department_ids:[units[2]], planned_date:day, completed_date:i === 0 ? day : null});
        const after = await overview();
        assert.equal(after.strategy.scene_launched - before.strategy.scene_launched, i === 0 ? 1 : 0);
      }
      const saved = find(await plan(),names,"scene");
      assert.equal(saved.department_id,units[i]);
      assert.deepEqual(saved.support_department_ids,[units[2]]);
      console.log("场景", saved.name, saved.id, saved.department_id, saved.support_department_ids, saved.completed_date);
    }
    const path = root + "/research-report";
    const read = board => api(path + "?board=" + board + "&year=" + year + "&month=" + month);
    const report = await read("manage");
    const subject = "物资采购合同条款结构化识别";
    const subjectId = "7ec78b17-26e8-45bd-a2ea-2b04ff961126";
    if (report.source === "empty" && !report.subjects.length) {
      const metrics = {projects:3, ai_projects:2, active_ai_projects:1, budget:24, spending:2, outstanding:3,
        valued_scenes:1, labor_value:2, direct_savings:1, equivalent_days:3, equivalent_value:0.24};
      await api(path, {year,month,revision:report.revision,metrics,subjects:[{
        id:subjectId,name:subject,project:topics[0][0],ai:true,start:day}]});
    }
    const published = await read("lead");
    if (published.subjects.some(s => s.id === subjectId)) {
      assert.equal(Number(published.metrics.projects),3);
      assert.equal(Number(published.metrics.ai_projects),2);
      console.log("科研经营看板",published.metrics,published.subjects.length);
    } else {
      console.log("月份已有其他报表，保留现有数据。");
    }
  } finally { await ctx.dispose(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
