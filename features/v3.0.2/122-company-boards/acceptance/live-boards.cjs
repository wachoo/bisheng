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
    const plan = await (await page.request.get(base + "/api/v1/company-boards/planning/2026")).json();
    assert.equal(plan.status_code,200);
    assert.deepEqual(data.departments, plan.data.departments);
    const companyName = "葛洲坝供应链公司";
    const search = await (await page.request.get(base + "/api/v1/departments/search", {params:{keyword:companyName}})).json();
    function flatten(nodes) { return nodes.flatMap(row=>[row,...flatten(row.children || [])]); }
    const roots = flatten(search.data.roots).filter(row=>row.name===companyName && row.status==="active");
    assert.equal(roots.length,1);
    const children = await (await page.request.get(base + "/api/v1/departments/children", {params:{parent_id:roots[0].id}})).json();
    const directIds = children.data.filter(row=>row.status==="active").map(row=>row.id);
    const departmentIds = new Set(data.departments.map(row => row.id));
    assert.deepEqual([...departmentIds].sort((a,b)=>a-b),directIds.sort((a,b)=>a-b));
    const knownDepartment = row => row.department_id == null || departmentIds.has(row.department_id);
    assert.ok([...data.assets, ...data.ledger, ...data.scene_usage].every(knownDepartment));
    assert.ok(data.runtime.department_usage.every(row => departmentIds.has(row.department_id)));
    const annualResponse = await page.request.get(base + "/api/v1/company-boards/overview?board=lead&year=2026");
    const annual = (await annualResponse.json()).data;
    const trendResponse = await page.request.get(base + "/api/v1/company-boards/trends?board=lead&year=2026&month=11");
    const series = (await trendResponse.json()).data;
    assert.ok([series.year,series.last90,...series.months].every(period => period.rows.every(knownDepartment)));
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
        const uses = ["successful_tasks","knowledge_success","tool_success","skill_calls"]
          .reduce((total,field)=>total+(data.runtime[field] ?? 0),0);
        await metric("asset-usage",series.months[10].rows.length ? uses+"次" : null);
      }
    }
    await screenshot("live-monitor");
    const expectedNames = data.departments.map(d => d.name);
    const monitorDepartment = page.locator('[data-op-field="department"]');
    assert.deepEqual(await monitorDepartment.locator("option").allTextContents(),["全部部门", ...expectedNames]);
    await page.goto(base + "/monitorboard?" + params + "&om-department=unknown");
    await page.getByText("所选部门不在公司直属部门名单中。",{exact:false}).first().waitFor();
    await page.getByRole("button",{name:"全部部门",exact:true}).click();
    await monitorDepartment.waitFor();
    assert.equal(await monitorDepartment.inputValue(),"");
    await page.goto(base + "/leadboard?view=activity&" + params + "&detail=usage-ledger");
    const activityDepartment = page.locator("#al-detail:visible label").filter({hasText:"使用部门"}).locator("select");
    await activityDepartment.waitFor();
    assert.deepEqual(await activityDepartment.locator("option").allTextContents(),["全公司", ...expectedNames]);
    await page.goto(base + "/leadboard?view=activity&" + params + "&detail=activity-catalog");
    const directoryDepartment = page.locator("#al-detail:visible label").filter({hasText:"贡献部门"}).locator("select");
    await directoryDepartment.waitFor();
    assert.deepEqual(await directoryDepartment.locator("option").allTextContents(),["全部", ...expectedNames]);
    const month = data.cutoff.slice(0,7);
    const releases = new Set(data.ledger.filter(row => row.kind === "release" &&
      row.effective_date?.startsWith(month) && row.effective_date <= data.cutoff).map(row => row.asset_key));
    const fresh = data.assets.filter(a => a.published_at
      ? a.published_at.startsWith(month) && a.published_at <= data.cutoff : releases.has(a.id));
    const department = fresh.find(a => departmentIds.has(a.department_id))?.department_id ?? data.departments[0].id;
    const scoped = fresh.filter(a => a.department_id === department);
    await page.goto(base + "/leadboard?view=activity&" + params + "&detail=activity-new:" + department);
    const detail = page.locator("#al-detail:visible");
    for (const kind of ["employee","knowledge","skill","tool","all"]) {
      const expected = scoped.filter(a => kind === "all" || a.kind === kind);
      const filter = detail.locator('[data-filter="'+kind+'"]');
      await filter.click();
      assert.equal(Number((await filter.innerText()).split(" ").pop()),expected.length);
      const ids = await detail.locator('tbody [data-detail^="asset:"]').evaluateAll(buttons =>
        buttons.map(b => b.dataset.detail.slice(6)).sort());
      assert.deepEqual(ids,expected.map(a => a.id).sort());
    }
    await page.goto(base + "/leadboard?view=activity&" + params + "&detail=activity-new:null");
    await detail.getByText("所选部门不在公司直属部门名单中。",{exact:true}).waitFor();
    await page.goto(base + "/leadboard?" + params + "&detail=department:unassigned");
    await page.locator("#al-detail:visible").getByText("所选部门不在公司直属部门名单中。",{exact:true}).waitFor();
    const published = data.ledger.filter(r => r.kind === "release" && r.effective_date?.startsWith("2026-") &&
      r.effective_date <= data.cutoff && departmentIds.has(r.department_id));
    const byOwner = data.departments.map(d => ({...d, count:published.filter(r => r.department_id === d.id).length}))
      .sort((a,b)=> b.count-a.count || a.id-b.id);
    if (byOwner[0].count) {
      const first = byOwner[0];
      await page.goto(base + "/leadboard?" + params);
      await board.locator(".rankline").filter({hasText:first.name}).first().click();
      await detail.getByRole("heading",{name:"年度首次发布 · "+first.count+" 项",exact:true}).waitFor();
      assert.equal(await detail.locator("tbody tr").count(),first.count);
      await screenshot("department-year");
      await page.goto(base + "/leadboard?" + params + "&detail=strategy:department-ranking");
      await detail.getByRole("button",{name:first.name+" ↗",exact:true}).click();
      await detail.getByRole("heading",{name:"年度首次发布 · "+first.count+" 项",exact:true}).waitFor();
    }
    console.log("Four pages, department filters, invalid saved links, and strategy and runtime totals reconciled.");
  } finally {await browser.close();}
}
main().catch(e => {console.error(e.message);process.exitCode=1;});
