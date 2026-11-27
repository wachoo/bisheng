# 通过资产创建和发布入口复核看板

从管理端创建和发布资产后，在「知识」「构建」和领导看板中核对「物资采购定价指引」「物资采购比价助手」「项目合同履约助手」「供应商报价复核规范」和「物资询价查询」。报价工具的 MCP 调用名为 `board1126_quote`。下表和 JSON 保留 2026 年 11 月首次操作时的原始读数、名称与检索回执。[执行业务入口](live-assets.cjs) · [当前名称与原名称对照](live-business-sample.cjs) · [首次操作记录](live-assets.sample.json)

| 操作 | 预期 | 本地首次操作实测 |
| --- | --- | --- |
| 创建公开采购问答库 | 目录多 1 个库，业务分类接入数持平 | 知识库 0 → 1，分类完成数 0 |
| 为问答库选择供应链规则分类 | 分类完成数加 1，库数持平 | 分类完成数 0 → 1，知识库 1 |
| 向库中加入一条采购问答 | 问答条目可用，库数及分类完成数持平 | 问答编号 1 已激活，答案含 K-1126，两项指标保持 1 |
| 解析 MCP 服务配置并创建工具 | 发现并登记 1 项工具 | 工具 39 → 40 |
| 从管理端创建一个公共 Skill | 已启用的公共 Skill 数加 1 | Skill 4 → 5 |
| 依次创建、发布采购报价助手和履约核查助手 | 草稿阶段目录数和年度建成数持平，每次正式发布各加 1 | 两项均依次为 0 → 0 → 1 → 1 → 2 |

## 准备验收供方

在本地项目工作树根目录打开 PowerShell。此操作使用项目后端镜像内已有的 MCP SDK，在开发环境的 Docker 网络中提供报价工具和 OpenAI 兼容的测试向量接口，宿主机无需开放端口。两个接口专用于验收数据。向量只用于核验写入及检索链路，不能用于评价召回质量。

```powershell
$providerScript = (Resolve-Path 'features/v3.0.2/122-company-boards/acceptance/live-assets-provider.py').Path
$backendImage = docker inspect bisheng-dev-backend-1 --format '{{.Config.Image}}'
docker run -d --restart unless-stopped --name board1126-assets --network bisheng-dev_default --mount "type=bind,source=$providerScript,target=/fixture.py,readonly" --entrypoint /app/.venv/bin/python $backendImage /fixture.py
```

已有同名验收容器时使用 `docker start board1126-assets`。供方代码变更后可用 `docker restart board1126-assets` 重新载入挂载的文件。BiSheng 通过 `http://board1126-assets:8126/mcp` 发现报价工具，通过 `http://board1126-assets:8126/v1/embeddings` 取得测试向量。

## 执行资产任务

1. 执行 [live-planning.cjs](live-planning.cjs) 的 `seed` 命令，建立重点专题「物资采购提质增效」「重大项目履约保障」及对应场景，并登记市场、人资、法务、党建、财务、数字化六类知识接入计划。采购定价指引归入「数字化」。执行 [live-members.cjs](live-members.cjs) 创建集中采购中心的采购询价岗、财务共享中心的结算审核岗、运营管理中心的合同履约岗。登录工号分别为 `board1126buyer`、`board1126finance`、`board1126ops`。
2. 准备本地管理员已登录的 Playwright storage state，并确认其管理租户与填报租户一致。下例为采购助手选择支持工具调用的验收回放模型，为履约助手选择业务模型。模型 ID 随环境而异。运行时助手会在“助手可用模型”列表中匹配所选 ID，未匹配时会回落到列表中的默认模型。首次回放时采购助手保存的 ID 为 3，第一轮实际由默认模型 DeepSeek 处理；核对模型效果时以执行记录为准。
3. 使用能加载 `playwright` 的 Node.js 环境，从仓库根目录执行。新建问答库使用「采购知识向量服务」下的 `board1126-embedding` 模型。已有环境复用原来登记的专用服务。

```powershell
$env:BOARD_SESSION = 'C:\local-test\admin-storage-state.json'
$env:BOARD_CHAT_MODEL_ID = '3'
$env:BOARD_SECOND_MODEL_ID = '1'
$env:BOARD_YEAR = '2026'
$env:BOARD_MONTH = '11'
$env:BOARD_ASSET_LOG = Join-Path $env:TEMP 'board-live1126-assets.jsonl'
$env:BOARD_ASSET_MANIFEST = Join-Path $env:TEMP 'board-live1126-assets.json'
node features/v3.0.2/122-company-boards/acceptance/live-assets.cjs
```

选取正在验收的北京时间年月，以便目录、首次发布和年度接入数处于同一统计窗口。脚本在创建成功时保存资产标识到 `BOARD_ASSET_MANIFEST`，随后对比本步指标增量。在同一开发库复跑时使用同一份清单。原始记录通过本租户两位员工的 UUID 识别。新库清单可通过已发布员工的 UUID，或知识库索引的唯一名称核实。账号按工号匹配。复跑可核验五项资产的专题、采购助手绑定的知识库与报价工具，以及问答条目状态。公共 Skill 单独核对管理详情中的启用状态及看板目录中的专题。复用旧采购样本时，脚本会更新该样本原有的两种旧版提示词。首次发布增量需在尚未创建这些资产的环境核验。

资产上线后运行 `live-planning.cjs link`，传入两个逗号分隔的资产 ID 列表。第一个列表包含采购助手、定价指引、报价工具及 Skill，第二个列表包含履约助手和采购助手。脚本给「大宗物资询比价」「关键合同履约核查」补充上述关联，并为尚未设置代表案例的专题选择对应员工。

上线使数字员工进入看板目录。要让普通员工实际发起对话，还需要使用权限。脚本使用资源授权接口向这三个测试账号授予两位助手、报价工具组和问答库的查看者权限；公共 Skill 创建时已具备使用权限。验收时三个账号分别查询自己的权限，五项资产均返回 `use`。

## 问答检索命中与交付内容

首次操作以“验收采购报价的复核规则是什么？”和“采购比价时怎样核对含税报价？”查询同一条问答。Milvus 和 Elasticsearch 的四次查询均返回问答编号 1。两份索引的 `metadata.extra.answer` 保存了含 K-1126 的答案，当时传给助手的分片及对话回执只有题面。当前业务样本的题面为“采购报价应如何统一比价口径？”，复跑时应在工具回执中核对统一税率、计量单位和含税到货总价等答案内容。[首次查询和分片原文](live-assets.sample.json) · [索引写入](../../../../src/backend/bisheng/api/services/knowledge_imp.py) · [助手分片格式化](../../../../src/backend/bisheng/knowledge/domain/services/knowledge_utils.py)

可在本机后端容器内复跑以下检查。使用验收库 ID 和已经获准使用该库的测试用户 ID。脚本直接调用助手使用的两个产品检索客户端，以及同一个分片格式化函数。公开的 `/api/v2/filelib/retrieve` 检索端点仅支持文档库与知识空间。

```powershell
docker cp features/v3.0.2/122-company-boards/acceptance/live-qa-retrieval.py bisheng-dev-backend-1:/tmp/board-live-qa-retrieval.py
docker exec -e PYTHONPATH=/app bisheng-dev-backend-1 /app/.venv/bin/python /tmp/board-live-qa-retrieval.py --tenant 1 --knowledge 1 --user 389
```
