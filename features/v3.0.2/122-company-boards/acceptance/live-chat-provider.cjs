// Register a separate test model through the same API as model management.
// Start live-chat-model.py as board1126-test-model:8000 on the local Compose network first.
const { request } = require(require.resolve('playwright', {paths:[process.cwd()]}));

async function main() {
  const admin = await request.newContext({baseURL:'http://127.0.0.1:3001',
    storageState:process.env.BOARD_ADMIN_SESSION});
  try {
    const name = '采集验收1126·工具回放模型';
    const modelName = 'board-live-chat';
    async function find() {
      const list = await (await admin.get('/api/v1/llm')).json();
      if (list.status_code !== 200) throw new Error('Cannot read model catalog: ' + list.status_code);
      return list.data.find(s=>s.name === name);
    }
    let server = await find();
    if (!server) {
      const response=await admin.post('/api/v1/llm', {data:{
        name,type:'openai_compatible',description:'本地合成数据，生成固定工具指令供采集链路验收。',
        share_to_children:false,config:{openai_api_base:'http://board1126-test-model:8000/v1',openai_api_key:'local-test'},
        models:[{name:'采集验收1126·工具回放',model_name:modelName,model_type:'llm',online:true,config:{}}],
      }});
      const result=await response.json();
      if(result.status_code !== 200) throw new Error('Cannot register model: ' + result.status_code);
      server=await find();
    }
    const model=server?.models.find(m=>m.model_name === modelName && m.online);
    if(!model) throw new Error('The test server has no online board-live-chat model');
    const settingsPath='/api/v1/llm/assistant';
    const config=await (await admin.get(settingsPath)).json();
    const current=config.data?.data;
    if(!Array.isArray(current?.llm_list) || !current.llm_list.length) throw new Error('Existing assistant model settings required');
    if(!current.llm_list.some(m=>Number(m.model_id)===model.id)){
      const result=await(await admin.post(settingsPath,{data:{...current,llm_list:[...current.llm_list,{
        model_id:model.id,agent_executor_type:'function call',knowledge_max_content:15000,
        knowledge_sort_index:false,streaming:true,default:false,
      }]}})).json();
      if(result.status_code!==200)throw new Error('Cannot add non-default test model: '+result.status_code);
    }
    console.log(JSON.stringify({server:server.id,model:model.id}));
  } finally {await admin.dispose();}
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
