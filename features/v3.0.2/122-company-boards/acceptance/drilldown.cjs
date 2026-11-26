// Run against the local frontend with BOARD_SESSION pointing to a Playwright storageState file.
// From a directory with Playwright installed: node <path-to-this-script>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd(), __dirname] }));

const base = process.env.BOARD_BASE_URL || 'http://127.0.0.1:3001';
const period = '2026-05', date = '2026-05-22', start = date+'T01:00:00+00:00', end=date+'T01:02:00+00:00';
const topic='e2e-topic', scene='e2e-scene', department=303;
const name='核对部门', runId='e2e00000000000000000000000000001', comment='核对汇总少了一列';
const worker=(i)=>'核对员工'+String(i+1).padStart(2,'0');
const staff=Array.from({length:15},(_,i)=>({id:'assistant:e2e'+String(i+1).padStart(2,'0'),name:worker(i),kind:'employee',
  department_id:department,scene_ids:[scene],monitored:true,success:25-i,failed:0,last:end}));
const named=staff[12];
const other={id:'tool:e2e',kind:'tool',name:'其他部门工具',department_id:null,scene_ids:[],monitored:false,success:0,failed:0,last:null};
const all=[...staff,other], ledger=[
  {id:topic,kind:'topic',year:2026,name:'核对专题',effective_date:'2026-01-01'},
  {id:scene,kind:'scene',year:2026,name:'核对场景',parent_id:topic,effective_date:'2026-01-02'}];
const receipt={id:runId,asset_id:named.id,started_at:start,ended_at:end,status:'success',source:'核对输入摘录',
  output:'核对输出摘录',own:true,issue:{comment},active_seconds:80,department_id:304};
const trend=(a)=>({kind:'employee',asset_id:a.id,department_id:304,successful:a.successful||a.success,failed:0,
  cancelled:0,entered:0,timed:a.success,active_seconds:a.success*80,linked:a.success,negative:a===named?1:0,tokens:1000,
  rounds:1,output_category:null,output_day:null});
const measures=staff.map(trend);
const point={month:5,rows:measures,files_known:true};
const series={months:Array.from({length:12},(_,i)=>({...point,month:i+1,rows:i===4?measures:[]})),year:point,last90:point};
const overview={year:2026,month:5,cutoff:date,catalog_as_of:'2026-06-01',departments:[{id:department,name},{id:304,name:'使用部门'}],assets:all,
  ledger,strategy:{employee_built:15,scene_launched:1,knowledge_verified:0,knowledge_planned:0},runtime:{
    detail_access:true,scope:'web',observed_runs:25,successful_tasks:25,failed_tasks:0,active_seconds:2000,timed_tasks:25,
    timing_coverage:1,observed_timing_coverage:1,usage:[],department_usage:[],recent_runs:[receipt],tool_success:0,
    tool_failure:0,skill_calls:0,knowledge_success:0,file_outputs:0,code_versions:0,deliverables:0,coverage_note:''},
  satisfaction:{successful:25,linked:25,negative:1,positive_rate:0.96}};

async function verify(page) {
  const issue={run_id:runId,asset_id:named.id.slice(10),opened_at:end,resolved_at:null,comment,measure:null};
  const requests=[],unexpected=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/company-boards/**',async route=>{
    const url=new URL(route.request().url()), p=url.searchParams, endpoint=url.pathname.split('/company-boards/')[1];
    requests.push({endpoint,params:Object.fromEntries(p)});
    const reply=(data)=>route.fulfill({json:{status_code:200,status_message:'SUCCESS',data}});
    switch(endpoint){
      case 'access':return reply({lead:true,monitor:true,resolve:true,manage:true});
      case 'overview':return reply(overview);
      case 'registers':return reply(staff.map((a,i)=>({id:'reuse'+i,revision:1,year:2026,kind:'scene-asset',name:a.name,
        parent_id:scene,date:'2026-01-01',fields:{asset:a.id}})));
      case 'trends':return reply(series);
      case 'monitoring':{
        const assets=all.filter(a=>(!p.get('kind')||a.kind===p.get('kind'))&&(!p.get('topic')||a.scene_ids.includes(scene))
          &&(!p.get('scene')||a.scene_ids.includes(p.get('scene')))&&(!p.get('department')||String(a.department_id)===p.get('department')));
        return reply({assets,days:[{day:22,success:assets.reduce((n,a)=>n+a.success,0),failed:0}],
          filters:{topics:[{id:topic,name:'核对专题'}],scenes:[{id:scene,name:'核对场景',topic_id:topic}]}});
      }
      case 'monitoring/feedback':{
        const closed=!!issue.resolved_at, allowed=(!p.get('run_id')||p.get('run_id')===runId)
          &&(!p.get('search')||comment.includes(p.get('search'))||named.name.includes(p.get('search')));
        const stage=p.get('stage')===(closed?'closed':'pending');
        return reply({pending:allowed&&!closed?1:0,closed:allowed&&closed?1:0,rows:allowed&&stage?[issue]:[],details:true});
      }
      case 'monitoring/runs/'+runId:return reply(receipt);
      case 'asset-activity':{
        const run={id:runId,start,end,status:'success'};
        return reply({known:true,last:end,total:1,series:[{date,success:1,failed:0,entered:0}],rows:[run],latest:run});
      }
      case 'feedback/'+runId+'/resolution':
        assert.equal(route.request().method(),'PUT');issue.measure=route.request().postDataJSON().measure;issue.resolved_at=end;
        return reply({});
      default:unexpected.push(endpoint);return route.fulfill({status:404,body:'unexpected test endpoint'});
    }
  });
  await page.goto(base+'/monitorboard?view=monitor&period='+period);
  const home=page.locator('#al-home'), detail=()=>page.locator('#al-detail > div:visible').last();
  const backward=async()=>{await detail().locator('[data-back]').first().click();};
  await home.getByRole('heading',{name:'每日运行趋势'}).waitFor();
  for(const [key,value] of [['topic',topic],['scene',scene],['department',String(department)],['type','employee']]){
    await home.locator('[data-op-field="'+key+'"]').selectOption(value);
  }
  await home.locator('[data-op-drill="all"]').first().click();
  assert.equal(await detail().locator('tbody tr').first().getByRole('button').first().innerText(),staff[0].name+' ↗');
  await detail().getByRole('button',{name:'下一页'}).click();
  const employeeLink=detail().getByRole('button',{name:named.name+' ↗',exact:true});
  await employeeLink.click();
  let workerView=detail();
  // Some viewport sizes display the history behind its own tab.
  let runLink=workerView.getByRole('button',{name:new RegExp(runId)});
  if(!await runLink.count()){
    const recordTab=workerView.getByRole('button',{name:/执行记录|执行日志|最近执行/}).first();
    if(await recordTab.count())await recordTab.click();
  }
  await page.setViewportSize({width:1280,height:600});
  const logLink=workerView.locator(".wm-log").getByRole("button",{name:new RegExp(runId)}).first();
  await logLink.scrollIntoViewIfNeeded();
  const workerY=await page.locator(".company-board-screen").evaluate(el=>el.scrollTop);
  assert(workerY>0,"a real scrolled worker list is required");
  await logLink.click();
  await detail().getByRole('heading',{name:'执行日志'}).waitFor();
  assert.equal(await detail().locator('.fb-excerpt').first().innerText(),receipt.source);
  assert.match(await detail().locator('.wm-steps').innerText(),/开始执行[\s\S]*09:00[\s\S]*执行结束[\s\S]*09:02/);
  await backward();
  await detail().locator(".wm-log").waitFor();
  const restored=await page.locator(".company-board-screen").evaluate(el=>el.scrollTop);
  assert(Math.abs(restored-workerY)<3,"worker scroll "+workerY+" became "+restored);
  await backward();
  await detail().getByRole('button',{name:named.name+' ↗',exact:true}).waitFor();
  assert.match(await detail().locator('.al-paging').innerText(),/2\s*\/\s*2/);
  await backward();
  assert.equal(await home.locator('[data-op-field="department"]').inputValue(),String(department));
  assert.equal(await home.locator('[data-op-field="scene"]').inputValue(),scene);
  assert.ok(requests.some(x=>x.endpoint==='monitoring'&&x.params.topic===topic&&x.params.scene===scene&&x.params.kind==='employee'
    &&x.params.department===String(department)),'scoped monitoring request');
  assert.ok(requests.some(x=>x.endpoint==='asset-activity'&&x.params.asset===named.id&&!x.params.department),'asset owner does not restrict use by other departments');

  await home.locator('[data-feedback-open]').click();
  await detail().locator('[data-search]').fill('少了一列');
  await detail().getByRole('button',{name:comment+' ↗',exact:true}).click();
  const draft='已复核验收样本，仅在当前浏览器测试中保存。';
  await detail().locator('textarea').fill(draft);
  await detail().getByRole('button',{name:new RegExp(runId)}).click();
  await detail().getByRole('heading',{name:'单次执行'}).waitFor();
  await backward();assert.equal(await detail().locator('textarea').inputValue(),draft);
  await detail().locator('[data-feedback-close]').click();
  await detail().getByText(draft,{exact:true}).waitFor();
  await backward();
  await detail().getByRole('button',{name:'已处理',exact:true}).click();
  await detail().getByRole('button',{name:comment+' ↗',exact:true}).waitFor();
  assert.equal(issue.measure,draft);
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
}
async function main(){
  const state=process.env.BOARD_SESSION;
  if(!state||!fs.existsSync(state))throw Error('Set BOARD_SESSION to an authenticated local Playwright storageState file.');
  const browser=await chromium.launch({channel:process.env.BOARD_BROWSER||'chrome',headless:true});
  try{const context=await browser.newContext({storageState:state,locale:'zh-CN',viewport:{width:1440,height:1000}});
    const page=await context.newPage();page.setDefaultTimeout(12000);await verify(page);
    console.log('PASS: monitor filters, ledger pagination, employee execution, private excerpts, feedback search, draft restoration and disposition');
  }finally{await browser.close();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={verify};
