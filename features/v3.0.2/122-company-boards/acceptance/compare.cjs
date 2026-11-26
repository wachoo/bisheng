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
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:"chrome"});
  try {
    const screen={width:1440,height:1000};
    const original=await browser.newPage({viewport:screen});
    await original.goto(pathToFileURL(prototype).href);
    const frame=original.frames().find(f=>f.parentFrame());
    const page=await browser.newPage({viewport:screen,storageState:process.env.BOARD_SESSION});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    for(const [anchor,view,route] of screens) {
      await frame.locator("[data-anchor="+anchor+"]").first().click();
      await page.goto(root+"/dashboard");
      const sidebar = page.locator('a.navlink[href="/'+route+'"]');
      await sidebar.click();
      if (view!=="monitor" && view!=="strategy") await page.locator('[data-anchor="'+anchor+'"]').click();
      assert.equal(await sidebar.getAttribute("aria-current"),"page","native menu highlight");
      await page.locator("#al-home:not([hidden])").waitFor();
      await page.locator("[data-anchor="+anchor+"][aria-current=page]").waitFor();
      await page.waitForLoadState("networkidle");
      const area=await page.locator(".company-board-screen").boundingBox(), nav=await sidebar.boundingBox();
      assert(area.x>=nav.x+nav.width-1 && area.x>100,"dashboard must occupy native right pane");
      assert(area.x+area.width<=screen.width+1,"right pane overflows");
      await original.setViewportSize({width:Math.round(area.width),height:Math.round(area.height)});
      await frame.locator("#al-home").waitFor();
      const a=await inventory(frame),b=await inventory(page);
      const geometry=async w=>w.locator(".al-header").evaluate(el=>({display:getComputedStyle(el).display,height:el.getBoundingClientRect().height}));
      const av=await geometry(frame), bv=await geometry(page);
      assert.equal(bv.display,av.display,anchor+" header layout");
      assert(Math.abs(av.height-bv.height)<10,anchor+" header height");
      assert(await page.locator("#ai-leader").evaluate(el=>!!getComputedStyle(el).getPropertyValue("--al-paper")), "dashboard theme");
      await original.screenshot({path:path.join(out,anchor+"-prototype.png")});
      await page.screenshot({path:path.join(out,anchor+"-local.png")});
      if(anchor==="strategy") {
        await page.locator(".company-board-screen").screenshot({path:path.join(out,"strategy-content-local.png")});
      }
      console.log(anchor,JSON.stringify({prototype:a.headings,local:b.headings,charts:[a.charts,b.charts],tables:[a.tables,b.tables]}));
      for(const word of required[anchor])assert((b.headings.join(" ")+b.text).includes(word),anchor+" missing "+word);
    }
    await page.goto(root+"/board-ledger");
    await page.getByRole("link",{name:/年度目标|年度建设目标/}).first().waitFor();
    const hrefs=await page.locator('a[href*="/board-ledger/"]').evaluateAll(xs=>[...new Set(xs.map(x=>x.href))]);
    assert(hrefs.length>=18,"only "+hrefs.length+" register links");
    for(const href of hrefs) {
      await page.goto(href);const add=page.getByRole("button",{name:/新增|新建|添加/}).last();await add.click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.locator('a.navlink[href="/board-ledger"]').getAttribute("aria-current"),"page","native register menu");
      assert(await page.getByRole("dialog").getByRole("button",{name:/保存/}).count(),"no save action "+href);
    }
    await page.goto(root+"/board-ledger/project");await page.waitForLoadState("networkidle");
    await page.screenshot({path:path.join(out,"registers-local.png")});
    console.log("registers",hrefs.length,"dialogs opened; page errors",errors);
    assert.equal(errors.length,0);
  } finally {await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
