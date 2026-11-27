// Local, persistent business-entry replay. Uses normal authenticated product endpoints.
// BOARD_SESSION and BOARD_ADMIN_SESSION are Playwright storageState files kept outside Git.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const fixture = require('./live-business-sample.cjs');
const { chromium, request } = require(require.resolve('playwright', {paths: [process.cwd()]}));
const baseURL = 'http://127.0.0.1:3001';
const prefix = '/api/v1/company-boards/';
const dailyAcknowledgement = '已收到您的工作安排';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function business(context, method, url, data) {
  const response = await context.fetch(url, {method, data});
  const body = await response.json();
  if (!response.ok() || body.status_code !== 200) {
    throw new Error(`${method} ${url}: HTTP ${response.status()}, business ${body.status_code}`);
  }
  return body.data;
}

async function snapshot(admin, period) {
  const [board, issues, trends] = await Promise.all([
    business(admin, 'GET', prefix + 'overview?board=lead&' + period),
    business(admin, 'GET', prefix + 'feedback?' + period),
    business(admin, 'GET', prefix + 'trends?board=lead&' + period),
  ]);
  const r = board.runtime;
  const month = Number(new URLSearchParams(period).get('month'));
  const rounds = trends.months[month - 1].rows.filter(row => row.kind === 'employee')
    .reduce((total, row) => total + row.rounds, 0);
  return {
    totals: {runs:r.observed_runs, rounds, success:r.successful_tasks, failed:r.failed_tasks,
      skill:r.skill_calls, knowledge:r.knowledge_success, mcp:r.tool_success, mcp_failure:r.tool_failure,
      scene_uses:board.scene_service.uses, scene_users:board.scene_service.users,
      negative:board.satisfaction.negative, pending:issues.pending, closed:issues.closed},
    runs: r.recent_runs, issues: issues.rows, usage: r.usage,
  };
}

async function daily(user, model) {
  const req = await user.post('/api/v1/workstation/chat/completions', {timeout:140000,
    data:{clientTimestamp:new Date().toISOString(), model, text:`已收到本周采购询价安排。请只回复“${dailyAcknowledgement}”。`}});
  if (!req.ok()) throw new Error('Daily chat HTTP ' + req.status());
  const packets = (await req.text()).split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)));
  const last = packets.find(p=>p.final);
  const saved = last?.responseMessage?.messageId;
  if (!saved) throw new Error('Missing final message. Event types: ' +
    packets.map(x=>x.type || x.event || x.status_code || Object.keys(x).join(',')).slice(-6).join(' / '));
  const chat=last.responseMessage.conversationId;
  const history=await business(user,'GET','/api/v1/workstation/messages/'+chat+'/agent');
  const answer=history.find(row=>row.category==='agent_answer' && Number(row.message_id)===Number(saved));
  return {chat, message:saved, answer:answer?.message?.msg};
}

async function assistant(storageState, asset, prompt) {
  const browser = await chromium.launch({channel:'chrome'});
  try {
    const page = await browser.newPage({storageState});
    await page.goto(baseURL + '/workspace/');
    return await page.evaluate(({asset, prompt, chat})=>new Promise((resolve, reject)=>{
      const ws = new WebSocket(`ws://${location.host}/api/v1/assistant/chat/${asset}`);
      const data = {id:asset, chatId:chat, type:5};
      let ready = false, message, answer, timeline, failure;
      const frames = [];
      const timer = setTimeout(()=>{ws.close(); reject(new Error('Socket timeout: ' + frames.slice(-6)));}, 140000);
      ws.onopen = ()=>ws.send(JSON.stringify({chat_id:chat, flow_id:asset, chatHistory:[], inputs:{data}}));
      ws.onmessage = ev=>{
        const item=JSON.parse(ev.data);
        frames.push(item.category + '/' + item.type);
        if (item.category==='error' || item.type==='error') failure = String(item.message).slice(0,160);
        if (item.category==='answer' && ['end','end_cover'].includes(item.type)) {
          message=item.message_id;
          answer = String(item.message).slice(0,160);
          const extra = typeof item.extra === 'string' ? JSON.parse(item.extra || '{}') : item.extra;
          timeline = (extra?.assistant_timeline || []).filter(x=>x.type==='tool').map(x=>({
            name:x.tool_key, category:x.category, result:x.status,
          }));
        }
        if (item.category==='processing' && item.type==='close') {
          if (!ready && !failure) {
            ready=true;
            ws.send(JSON.stringify({chat_id:chat, flow_id:asset, chatHistory:[], inputs:{data, input:prompt}}));
          } else {
            clearTimeout(timer); ws.close();
            resolve({chat, message, answer, timeline, failure, frames:[...new Set(frames)]});
          }
        }
      };
      ws.onclose = ev=>{clearTimeout(timer); if (!message && !failure) reject(new Error('WebSocket close ' + ev.code + ' ' + ev.reason));};
    }), {asset, prompt, chat:randomUUID().replaceAll('-','')});
  } finally {await browser.close();}
}

async function replay() {
  const [action, target, sample, asset, chat] = process.argv.slice(2);
  const user = await request.newContext({baseURL, storageState:process.env.BOARD_SESSION});
  const admin = await request.newContext({baseURL, storageState:process.env.BOARD_ADMIN_SESSION});
  const yearMonth = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
  const [year, month] = yearMonth.split('-');
  const period = 'year=' + year + '&month=' + Number(month);
  let evidence;
  try {
    const userId = (await business(user,'GET','/api/v1/user/info')).user_id;
    const before = await snapshot(admin, period);
    let receipt;
    let expected;
    if (action==='daily') {
      expected = {runs:0, rounds:0, scene_uses:0};
      receipt = await daily(user,target);
    } else if (action==='assistant') {
      expected = {success:1, rounds:1, scene_uses:1};
      if (sample==='tools' || sample==='reject') Object.assign(expected,{skill:1, knowledge:1, [sample==='reject'?'mcp_failure':'mcp']:1});
      const prompt = sample==='tools' || sample==='reject'
        ? fixture.question + '请应用报价复核规范，检索定价指引，并查询供应商甲的报价。' +
          (sample==='reject'?'供应商已撤回原报价，请核对该单是否仍可用。':'')
        : '请确认本周关键合同履约核查安排，回复“已收到履约核查安排”。';
      receipt = await assistant(process.env.BOARD_SESSION,target,prompt);
    } else if (action==='rate') {
      const liked = Number(sample);
      if (![1,2].includes(liked)) throw new Error('Expected 1 (like) or 2 (dislike)');
      expected = liked===2 ? {negative:1,pending:1,closed:0} : {negative:0,pending:0};
      await business(user,'POST','/api/v1/session/chat/message/telemetry',{message_id:Number(target),operation_type:liked===1?'like':'dislike'});
      await business(user,'POST','/api/v1/liked',{message_id:Number(target),liked});
      if (liked===2) await business(user,'POST','/api/v1/chat/comment',{message_id:Number(target),comment:'原报价已撤回，请确认是否需要重新向供应商询价。'});
      const rows=await business(user,'GET',`/api/v1/chat/history?flow_id=${asset}&chat_id=${chat}&page_size=40`);
      receipt={message:Number(target), liked, savedRating:rows.find(r=>Number(r.id)===Number(target))?.liked};
    } else if (action==='verify-resolution') {
      expected={pending:0,closed:0};
      receipt={run:target};
    } else if (action==='resolve') {
      expected={negative:0,pending:-1,closed:1};
      await business(user,'PUT',prefix+'feedback/'+target+'/resolution',{measure:'已核对报价回执，确认原报价撤回，已通知采购岗重新询价。'});
      receipt={run:target};
    } else throw new Error('Expected daily, assistant, rate, or resolve');
    let after = await snapshot(admin,period);
    function awaitingProjection() {
      if (action==='assistant') return after.totals.runs===before.totals.runs || after.totals.rounds===before.totals.rounds;
      if (action==='resolve') return !after.issues.some(i=>i.run_id===target && i.resolved_at);
      if (action==='rate' && Number(sample)===2) return after.totals.pending===before.totals.pending;
      return false;
    }
    for(let n=0; awaitingProjection() && n<10; n++){
      await pause(300);
      after=await snapshot(admin,period);
    }
    const delta = Object.fromEntries(Object.keys(before.totals).map(k=>[k,Number(after.totals[k])-Number(before.totals[k])]));
    const checks = {counts:Object.keys(expected).every(k=>delta[k]===expected[k])};
    if(action==='daily') checks.savedAnswer=receipt.answer?.includes(dailyAcknowledgement)===true;
    if(action==='assistant'){
      if(receipt.message && ['tools','reject'].includes(sample)){
        const rows = await business(user,'GET',`/api/v1/chat/history?flow_id=${target}&chat_id=${receipt.chat}&page_size=40`);
        const traces = rows.filter(row=>['tool_result','tool','knowledge'].includes(row.category))
          .map(row=>JSON.stringify(row));
        receipt.knowledgeHit = traces.some(text=>text.includes(fixture.answer) || text.includes('K-1126'));
        receipt.mcpQuote = traces.some(text=>text.includes('Q-1126'));
        receipt.knowledgeQuestion = traces.some(text=>text.includes(fixture.question) || text.includes('验收采购报价的复核规则是什么？'));
        receipt.mcpRejected = traces.some(text=>text.includes('供应商报价服务拒绝请求'));
        checks.knowledgeAnswer = receipt.knowledgeHit;
        checks.mcpResponse = sample==='tools' ? receipt.mcpQuote : receipt.mcpRejected && !receipt.mcpQuote;
        checks.skill = receipt.timeline?.some(step=>step.name==='use_assistant_skill' && step.result==='done') || false;
      }
      const run=after.runs.find(r=>r.asset_id==='assistant:'+target && !before.runs.some(v=>v.id===r.id));
      if(run){
        const detail=await business(admin,'GET',prefix+'monitoring/runs/'+run.id+'?'+period);
        receipt.run=run.id; receipt.department=detail.department_id; receipt.status=detail.status;
      }
      checks.terminal = !!receipt.message && receipt.status==='success';
      checks.department = receipt.department === Number(process.env.BOARD_EXPECTED_DEPARTMENT);
    }
    if(action==='rate') checks.savedRating=receipt.savedRating===Number(sample);
    if(action==='resolve' || action==='verify-resolution'){
      const issue=after.issues.find(i=>i.run_id===target);
      receipt.resolvedAt=issue?.resolved_at;
      receipt.measure=issue?.measure;
      checks.closedIssue=!!issue?.resolved_at && (action==='resolve'
        ? issue.measure==='已核对报价回执，确认原报价撤回，已通知采购岗重新询价。'
        : !!issue.measure?.trim());
    }
    if(action==='rate' && Number(sample)===2) receipt.newIssues=after.issues.filter(i=>!before.issues.some(x=>x.run_id===i.run_id)).map(i=>i.run_id);
    const matched = Object.values(checks).every(Boolean);
    evidence={action,target,sample,userId,at:new Date().toISOString(),expected,receipt,before:before.totals,after:after.totals,delta,checks,matched};
    if(process.env.BOARD_CHAT_EVIDENCE) fs.appendFileSync(process.env.BOARD_CHAT_EVIDENCE,JSON.stringify(evidence)+'\n');
    console.log(JSON.stringify(evidence));
    if (!matched) process.exitCode=2;
  } finally {await user.dispose();await admin.dispose();}
}
replay().catch(err=>{console.error(err.message);process.exitCode=1;});
