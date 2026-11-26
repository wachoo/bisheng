# 通过资产创建和发布入口复核看板

本任务从管理端的问答库、MCP、Skill、助手和资产归属接口创建测试资料，逐步读取同一租户的领导看板总览。完成后，可在「知识」「构建」和领导看板中查找带有“采集验收1126”的资料，报价工具的调用名为 `board1126_quote`。[执行脚本](live-assets.cjs) · [2026 年 11 月本地操作前后的真实读数](live-assets.sample.json)

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

1. 完成[年度台账任务](live-planning.cjs)，建立「采集验收1126·采购协同」「采集验收1126·工程履约」两个专题，以及「采集验收1126·供应链规则」分类。完成[组织测试用户任务](live-members.cjs)，建立集中采购中心、财务共享中心、运营管理中心三个普通测试账号。
2. 准备本地管理员已登录的 Playwright storage state，并确认其管理租户与填报租户一致。下例为采购助手选择支持工具调用的验收回放模型，为履约助手选择业务模型。模型 ID 随环境而异。运行时助手会在“助手可用模型”列表中匹配所选 ID，未匹配时会回落到列表中的默认模型。首次回放时采购助手保存的 ID 为 3，第一轮实际由默认模型 DeepSeek 处理；核对模型效果时以执行记录为准。
3. 使用能加载 `playwright` 的 Node.js 环境，从仓库根目录执行。脚本首次运行会使用模型管理 API 新建「采集验收1126·本地向量服务」，其类型为 OpenAI、模型类型为 embedding、模型名为 `board1126-embedding`。测试库在创建时单独指定这个向量模型，系统的默认模型配置可继续用于现有业务。

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

选取正在验收的北京时间年月，以便目录、首次发布和年度接入数处于同一统计窗口。脚本在每次创建前读取指标，比较本步增量，成功时追加到 JSONL。完成后复跑会复用同名资产，并从生产查询接口重新校验五项资产的专题、采购助手的三类绑定和问答条目状态。复跑已有资产只能验证现状和幂等性；观察首次发布的增量需要没有同名资产的本地测试环境。

上线使数字员工进入看板目录。要让普通员工实际发起对话，还需要使用权限。脚本使用资源授权接口向这三个测试账号授予两位助手、报价工具组和问答库的查看者权限；公共 Skill 创建时已具备使用权限。验收时三个账号分别查询自己的权限，五项资产均返回 `use`。

## 问答检索命中与交付内容

对同一条问答分别检索“验收采购报价的复核规则是什么？”和“采购比价时怎样核对含税报价？”。Milvus 和 Elasticsearch 的四次查询均返回问答编号 1。两份索引的记录正文是问题，`metadata.extra.answer` 保存了完整答案“验收规则 K-1126：比较含税总价、交期，并留存复核记录。”。助手随后调用 `KnowledgeUtils.format_retrieved_chunk`，交给模型的分片只含题面。正式工作台对话中的知识工具回执也只出现题面。看板可以据此正确记录一次成功的检索调用，但读者无法据调用成功判断使用者是否拿到了知识答案。[查询和分片原文](live-assets.sample.json) · [索引写入](../../../../src/backend/bisheng/api/services/knowledge_imp.py) · [助手分片格式化](../../../../src/backend/bisheng/knowledge/domain/services/knowledge_utils.py)

可在本机后端容器内复跑以下检查。使用验收库 ID 和已经获准使用该库的测试用户 ID。脚本直接调用助手使用的两个产品检索客户端，以及同一个分片格式化函数。公开的 `/api/v2/filelib/retrieve` 检索端点仅支持文档库与知识空间。

```powershell
docker cp features/v3.0.2/122-company-boards/acceptance/live-qa-retrieval.py bisheng-dev-backend-1:/tmp/board-live-qa-retrieval.py
docker exec -e PYTHONPATH=/app bisheng-dev-backend-1 /app/.venv/bin/python /tmp/board-live-qa-retrieval.py --tenant 1 --knowledge 1 --user 389
```
