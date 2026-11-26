// Display names used by the local November 2026 business scenarios.
// The second name only locates records created by the original rehearsal.
const legacy = name => "采集验收1126·" + name;
const topics = [
  ["物资采购提质增效", legacy("采购协同")],
  ["重大项目履约保障", legacy("工程履约")],
];
const scenes = [
  ["大宗物资询比价", legacy("采购比价")],
  ["关键合同履约核查", legacy("履约核对")],
];
const employees = [
  ["物资采购比价助手", legacy("采购报价助手")],
  ["项目合同履约助手", legacy("履约核查助手")],
];
const knowledge = ["物资采购定价指引", legacy("采购规则问答库")];
const category = ["数字化", legacy("供应链规则")];
const tool = ["供应商询价服务", legacy("报价服务")];
const childTool = ["物资询价查询", "board1126_quote"];
const skill = ["供应商报价复核规范", legacy("报价复核规范"), "board1126-quote-check"];
const modelServices = {
  embedding: ["采购知识向量服务", legacy("本地向量服务")],
  chat: ["采购协同推演服务", legacy("工具回放模型")],
};
const question = "采购报价应如何统一比价口径？";
const answer = "将各供应商报价折算到统一税率与计量单位，核对运费、交货周期及付款条件，按含税到货总价记录差异。";
// The first entry identifies the recorded local run. An exported manifest
// identifies independently created copies in another local development database.
const manifestPath = process.env.BOARD_ASSET_MANIFEST ||
  require("node:path").join(require("node:os").tmpdir(), "board-live1126-assets.json");
async function assetManifests(catalog, readLibrary) {
  const fs = require("node:fs");
  const archived = require("./live-assets.sample.json").assets;
  const matchesEmployee = (id,i) => catalog.some(a=>a.id==="assistant:"+id && employees[i]?.includes(a.name));
  const originalDatabase = archived.employees.every(matchesEmployee);
  const manifests = originalDatabase ? [archived] : [];
  if (fs.existsSync(manifestPath)) {
    const saved = JSON.parse(fs.readFileSync(manifestPath,"utf8"));
    const copiedArchive = archived.employees.some(id=>saved.employees?.includes(id));
    let trusted = copiedArchive ? originalDatabase : saved.employees?.some(matchesEmployee);
    // A new database can resume immediately after its first library POST.
    // The index collection name includes a per-library random suffix.
    if (!trusted && !copiedArchive && saved.knowledge_collection &&
        catalog.some(a=>a.id==="knowledge:"+saved.knowledge && knowledge.includes(a.name))) {
      const library = await readLibrary(saved.knowledge);
      trusted = library?.collection_name === saved.knowledge_collection;
    }
    if (trusted) manifests.push(saved);
  }
  return manifests;
}
const members = [
  {account:"board1126buyer", department:"集中采购中心", names:["采购询价岗", legacy("集中采购中心")]},
  {account:"board1126finance", department:"财务共享中心", names:["结算审核岗", legacy("财务共享中心")]},
  {account:"board1126ops", department:"运营管理中心", names:["合同履约岗", legacy("运营管理中心")]},
];

function named(rows, names) {
  for (const name of names) {
    const row = rows.find(item => item.name === name);
    if (row) return row;
  }
}

module.exports = {topics, scenes, employees, knowledge, category, tool, childTool, skill, members, named,
  modelServices, question, answer, assetManifests, manifestPath};
