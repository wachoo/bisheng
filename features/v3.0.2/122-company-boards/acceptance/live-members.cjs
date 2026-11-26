const {request}=require("playwright");
const {publicEncrypt,constants}=require("node:crypto");
const assert=require("node:assert/strict");

async function main() {
  const ctx=await request.newContext({baseURL:"http://127.0.0.1:3001",storageState:process.env.BOARD_SESSION});
  try {
    async function api(path,data) {
      const r=data?await ctx.post(path,{data}):await ctx.get(path);
      const b=await r.json();
      assert.equal(b.status_code,200,JSON.stringify(b.message || b.detail || r.status()));
      return b.data;
    }
    const {public_key}=await api("/api/v1/user/public_key");
    const pem=public_key.includes("-----BEGIN")?public_key:"-----BEGIN PUBLIC KEY-----\n"+public_key+"\n-----END PUBLIC KEY-----";
    const password=process.env.BOARD_TEST_PASS;
    assert.ok(password,"Set BOARD_TEST_PASS for the local test accounts");
    for (const [suffix,org] of [["buyer","集中采购中心"],["finance","财务共享中心"],["ops","运营管理中心"]]) {
      const person_id="board1126"+suffix;
      const user_name="采集验收1126·"+org;
      const tree=await api("/api/v1/departments/search?keyword="+encodeURIComponent(org));
      function find(nodes) {for(const n of nodes){if(n.name===org && n.matched)return n; const child=find(n.children||[]); if(child)return child;}}
      const dept=find(tree.roots);
      assert.ok(dept);
      const base="/api/v1/departments/"+encodeURIComponent(dept.dept_id);
      const members=()=>api(base+"/members?keyword="+encodeURIComponent(user_name)+"&page=1&limit=20");
      if (!(await members()).data.some(m=>m.user_name===user_name)) {
        const role=(await api(base+"/assignable-roles")).find(r=>r.role_name==="普通用户");
        assert.ok(role);
        await api("/api/v1/departments/local-members",{dept_id:dept.dept_id,user_name,person_id,
          password:publicEncrypt({key:pem,padding:constants.RSA_PKCS1_PADDING},Buffer.from(password)).toString("base64"),role_ids:[role.id]});
      }
      const account=(await members()).data.find(m=>m.user_name===user_name);
      assert.ok(account && Number(account.is_primary)===1);
      console.log(org,person_id,account.user_id,dept.id);
    }
  } finally {await ctx.dispose();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
