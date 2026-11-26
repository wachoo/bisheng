// Run from the project root with BOARD_SESSION pointing at a local Playwright storage state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(require.resolve("playwright", {paths:[process.cwd()]}));
const root = process.env.BOARD_BASE || "http://127.0.0.1:3001";
const prototype = path.resolve(process.env.BOARD_PROTOTYPE || "prototypes/ai-development-dashboard.html");
const out = path.join(__dirname,"../screenshots/parity");
const screens = [["strategy","strategy","leadboard"],["business","impact","leadboard"],["adoption","activity","leadboard"],["operations","monitor","monitorboard"]];
const leadTabs = {strategy:"战略进展", impact:"业务赋能", activity:"应用活力"};
const viewports = [
  {width:1707, height:898},
  {width:1440, height:1000},
  {width:2560, height:1347},
  {width:1280, height:1024},
  {width:1200, height:900},
  {width:1024, height:768},
];
const headerGroup = page => page.locator("#leadboard-header-menu").getByRole("radiogroup", {name:"公司领导看板"});
const center = rect => ({x:rect.x + rect.width / 2, y:rect.y + rect.height / 2});
const required = {
  strategy:["年度","资产","专题","部门"],
  business:["作业工时","交付物","好评率","专题"],
  adoption:["资产","Token","部门","排名"],
  operations:["纳入管理","执行","异常","反馈"]
};
async function inventory(frame) {
  return frame.locator("#al-home").evaluate(el=>{
    function elements(node){return [...node.querySelectorAll("*")].flatMap(x=>x.shadowRoot?[x,...elements(x.shadowRoot)]:[x]);}
    const visible=elements(el).filter(x=>x.getBoundingClientRect().width>0);
    return {headings:visible.filter(x=>x.matches("h1,h2,h3,h4,.card-title,.al-stat-label")).map(x=>x.textContent.trim()),text:visible.filter(x=>x.children.length===0).map(x=>x.textContent.trim()).filter(Boolean).join(" "),
      tables:visible.filter(x=>x.matches("table")).length,charts:visible.filter(x=>x.matches("svg,.al-ring,.al-cloud-wrap,.al-chart")).length};
  });
}
async function checkShell(page, sidebar, viewport, buildHeader, anchor, view) {
  const board = page.locator(".company-board-screen");
  const area = await board.boundingBox();
  const nav = await sidebar.boundingBox();
  assert(area.x >= nav.x + nav.width - 1 && area.x > 100, "keep native sidebar");
  assert(Math.abs(viewport.width - area.x - area.width) < 32, "right pane fills available width");
  assert(Math.abs(viewport.height - area.y - area.height) < 32, "right pane fills available height");
  assert.equal(await board.locator(".al-header").count(), 0, "no second header inside board");
  assert.equal(await board.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "no horizontal board scrolling");
  if (view === "monitor") {
    assert.equal(await page.locator("#leadboard-header-menu").count(), 0, "monitor has no theme selector");
    assert.equal(await page.getByRole("radio", {name:"运营监控", exact:true}).count(), 0);
  } else {
    const group = headerGroup(page);
    const radios = group.getByRole("radio");
    assert.deepEqual((await radios.allTextContents()).map(label => label.trim()), Object.values(leadTabs));
    assert(await group.getByRole("radio", {name:leadTabs[view], checked:true}).isVisible());
    const selector = await group.boundingBox();
    const position = center(selector);
    assert(Math.abs(position.x - buildHeader.x) < 2 && Math.abs(position.y - buildHeader.y) < 2,
      "leader selector matches the center of the native /build/apps header");
    assert(selector.y + selector.height <= area.y + 1, "selector sits above right pane");
  }
  const cards = page.locator("#al-home").locator(".card, .al-panel, .al-stat, .om-panel, .om-metric");
  await cards.first().waitFor();
  const extent = await cards.evaluateAll(nodes => {
    const rects = nodes.map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    return {
      left:Math.min(...rects.map(rect => rect.left)),
      right:Math.max(...rects.map(rect => rect.right)),
      bottom:Math.max(...rects.map(rect => rect.bottom)),
    };
  });
  const gaps = {left:extent.left - area.x, right:area.x + area.width - extent.right,
    bottom:area.y + area.height - extent.bottom};
  const label = anchor + " " + viewport.width + "×" + viewport.height + " " + JSON.stringify(gaps);
  assert(gaps.left >= -1 && gaps.left < 48 && gaps.right >= -1 && gaps.right < 48, "card side gutters: " + label);
  assert(gaps.bottom < 48, "unused area below cards: " + label);
  return area;
}

async function checkTabHistory(page) {
  await page.goto(root + "/leadboard");
  const group = headerGroup(page);
  await group.getByRole("radio", {name:leadTabs.impact}).click();
  const month = page.locator('#al-home input[type="month"]');
  const period = "2025-05";
  await month.fill(period);
  await page.waitForURL(url => url.searchParams.get("period") === period);
  await page.locator('#al-home [data-detail="topic-register"]').click();
  const detail = page.locator("#al-detail > div:visible");
  await detail.getByRole("heading", {name:"专题台账", exact:true}).first().waitFor();
  const detailUrl = page.url();
  await group.getByRole("radio", {name:leadTabs.activity}).click();
  await page.locator("#al-home:visible #al-adoption").waitFor();
  const next = new URL(page.url()).searchParams;
  assert.equal(next.get("period"), period, "switching view preserves reporting month");
  assert(!next.has("detail") && !next.has("title"), "new view opens at overview");
  await page.goBack();
  assert.equal(page.url(), detailUrl, "browser back restores the exact drilldown");
  await page.reload();
  await detail.getByRole("heading", {name:"专题台账", exact:true}).first().waitFor();
  assert(await group.getByRole("radio", {name:leadTabs.impact, checked:true}).isVisible());
  await detail.locator("[data-back]").click();
  await page.locator("#al-home:visible #al-business").waitFor();
  assert.equal(await month.inputValue(), period);
  const ledgerMenu = page.locator('a.navlink[href^="/board-ledger"]');
  await ledgerMenu.click();
  await page.waitForURL(url => url.pathname === "/board-ledger" && url.searchParams.get("year") === period.slice(0, 4));
  assert.equal(await ledgerMenu.getAttribute("href"), "/board-ledger", "ledger uses its default menu target when open");
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:"chrome"});
  try {
    const screen=viewports[0];
    const original=await browser.newPage({viewport:screen});
    await original.goto(pathToFileURL(prototype).href);
    const frame=original.frames().find(f=>f.parentFrame());
    const page=await browser.newPage({viewport:screen,storageState:process.env.BOARD_SESSION});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(root+"/build/apps");
    const buildGroup = page.locator(".build-tab").getByRole("radiogroup");
    await buildGroup.waitFor();
    const nativeCenters = new Map();
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      nativeCenters.set(viewport.width, center(await buildGroup.boundingBox()));
    }
    for(const [anchor,view,route] of screens) {
      await page.setViewportSize(screen);
      await frame.locator("[data-anchor="+anchor+"]").first().click();
      await page.goto(root+"/dashboard");
      const sidebar = page.locator('a.navlink[href="/'+route+'"]');
      await sidebar.click();
      if (view!=="monitor" && view!=="strategy") await headerGroup(page).getByRole("radio", {name:leadTabs[view]}).click();
      assert.equal(await sidebar.getAttribute("aria-current"),"page","native menu highlight");
      await page.locator("#al-home:not([hidden])").waitFor();
      await page.locator('#ai-leader[data-active-screen="'+anchor+'"]').waitFor();
      await page.waitForLoadState("networkidle");
      const area=await checkShell(page,sidebar,screen,nativeCenters.get(screen.width),anchor,view);
      await original.setViewportSize({width:Math.round(area.width),height:Math.round(area.height)});
      await frame.locator("#al-home").waitFor();
      const a=await inventory(frame),b=await inventory(page);
      assert(await page.locator("#ai-leader").evaluate(el=>!!getComputedStyle(el).getPropertyValue("--al-paper")), "dashboard theme");
      await original.screenshot({path:path.join(out,anchor+"-prototype.png")});
      await page.screenshot({path:path.join(out,anchor+"-local.png")});
      if(anchor==="strategy") {
        await page.locator(".company-board-screen").screenshot({path:path.join(out,"strategy-content-local.png")});
      }
      console.log(anchor,JSON.stringify({prototype:a.headings,local:b.headings,charts:[a.charts,b.charts],tables:[a.tables,b.tables]}));
      for(const word of required[anchor])assert((b.headings.join(" ")+b.text).includes(word),anchor+" missing "+word);
      for (const viewport of viewports.slice(1)) {
        await page.setViewportSize(viewport);
        await checkShell(page,sidebar,viewport,nativeCenters.get(viewport.width),anchor,view);
      }
    }
    await page.setViewportSize(screen);
    await checkTabHistory(page);
    await page.goto(root+"/board-ledger");
    const nav=page.getByRole("navigation",{name:"看板填报台账"});
    await nav.waitFor();
    const titles=["年度建设计划","知识接入计划","科研与经营"];
    assert.deepEqual(await nav.getByRole("link").allTextContents(),titles);
    for (const name of titles) {
      await nav.getByRole("link",{name,exact:true}).click();
      assert.equal(await nav.getByRole("link",{name,exact:true}).getAttribute("aria-current"),"page");
      assert.equal(await page.locator('a.navlink[href="/board-ledger"]').getAttribute("aria-current"),"page");
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator("main.br-center").getByRole("alert").count(),0,name);
    }
    await nav.getByRole("link",{name:titles[0]}).click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({path:path.join(out,"registers-local.png")});
    await page.goto(root+"/leadboard");
    await page.locator("#strategy-cockpit .card.hero").waitFor();
    await page.getByRole("button",{name:/主题/}).first().click();
    await page.locator("html.dark").waitFor();
    for(const [selector,token] of [[".hero .goal-label","--text-2"],[".hero .total","--brand-main"]]) {
      const colors=await page.locator("#strategy-cockpit").locator(selector).first().evaluate((el,token)=>{
        const style=getComputedStyle(el);
        return [style.color.match(/\d+/g).join(" "),style.getPropertyValue(token).trim()];
      },token);
      assert.equal(colors[0],colors[1],"strategy follows the native dark theme on "+selector);
    }
    await page.screenshot({path:path.join(out,"strategy-dark.png")});
    await page.getByRole("button",{name:/主题/}).first().click();
    console.log("Three registers, native light/dark theme, page errors:",errors);
    assert.equal(errors.length,0);
  } finally {await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
