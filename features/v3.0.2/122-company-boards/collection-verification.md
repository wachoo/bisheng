# 公司看板运行采集验证记录

2026 年 11 月 26 日，在本地隔离环境回放 9 次请求。按场景服务量口径，7 次正式成功执行服务了 4 人。公司看板汇总查到 **4 次、2 人**。有 3 次成功执行缺少数字员工终态事件，分别来自开放 API 助手、Web 工作流和开放 API 工作流。三条路径都调用了原产品的应用遥测。看板查询依赖的 `board_runtime_event` 并未因此增加记录。

## 一组可核对的业务数据

采购场景关联助手 A、助手 B 和工作流 C，共享场景再次关联助手 A。四个模拟用户分别用编号 71–74 表示。下表末列是每次调用前后，本租户实际新增的数字员工终态事件数。[逐请求 JSON 与员工明细](acceptance/collection-paths.json)

| 样本 | 入口 | 资产 | 用户 | 执行结果 | 新增终态 |
| --- | --- | --- | --- | --- | ---: |
| 1、2 | 正式 Web 助手，连续使用两次 | A | 71 | 均成功 | 各 1 |
| 3 | 正式 Web 助手 | A | 72 | 成功 | 1 |
| 4 | 正式 Web 助手 | B | 71 | 成功 | 1 |
| 5 | 正式 Web 助手 | A | 72 | 失败 | 1 |
| 6 | 助手预览 | A | 73 | 成功，按口径排除 | 0 |
| 7 | 开放 API 助手 | A | 73 | 成功 | 0 |
| 8 | Web 工作流 | C | 73 | 成功 | 0 |
| 9 | 开放 API 工作流 | C | 74 | 成功 | 0 |

**对账。** 在已采到的记录中，助手 A 为 3 次、2 人，助手 B 为 1 次、1 人。A 关联两个场景，汇总仍只计 3 次。用户 71 使用了 A 和 B，公司合计仍只有 2 人。工作流 C 的两次执行都走完开始节点和结束节点，资产明细显示 0 次、0 人、未监测。另有 1 次失败进入失败数及工时，退出成功服务量。5 条正式 Web 助手终态都有有效计时。这个样本用来定位漏采入口，无法推算全公司历史漏采比例。

## 漏采发生在哪里

- **同一个助手，不同入口。** 样本 1–5 从正式 Web 助手发起，有会话 ID，聊天客户端安装了运行观察器并在结束时写入终态。样本 7 从开放 API 调用同一个 A 并成功返回，但这条路径没有安装同一观察器。用户 73 的这次使用无法出现在场景服务人数里。
- **同一个工作流，两种入口。** 样本 8、9 分别从 Web 和开放 API 进入工作流执行器。两次都完成了 `start_1 → end_1`，都触发 `application_alive` 和 `application_process` 遥测调用，两次都缺少看板终态。调整场景关联或汇总 SQL 无法补出缺失的运行明细。
- **已接入的入口也存在写入失败。** 另一项独立实验临时让 SQLite 拒绝写入看板事件。正式 Web 助手仍返回正常答复，日志记录写入错误，该轮新增终态为 0。恢复写入再提交一次，两次答复合计只查到 1 条终态。该实验复现了写入失败后的丢数，没有据此认定本地业务库或线上发生过相同故障。[写入故障实验](../../../src/backend/test/company_board/test_runtime_observation.py)
- **托管应用。** 另行验证了三种访问 URL 都能转发到上游应用。转发成功只能证明应用被访问，无法从这一步判断用户是否在应用内完成任务。因此没有把访问数纳入上表的 7 次，也没有把它列作第 4 次漏采。[代理入口测试](../../../src/app-proxy/tests/test_proxy.py)

## 复跑与判定

使用项目后端已有的开发或测试 Python 环境，在 `src/backend` 下执行以下命令。设置输出路径可得到本次运行自己的 JSON。样本使用隔离的内存数据库，鉴权身份、模型回复、聊天消息存储和队列传输由测试提供。运行入口、聊天分派、工作流任务及节点执行、看板事实行写入和年度汇总使用项目代码。通用遥测断言检查生产代码发起的调用，未写入 Elasticsearch。测试直接调用服务端路由处理函数，未覆盖网络握手、真实模型与 Celery 跨进程投递。

```powershell
$env:config = Join-Path $env:TEMP ('board-collection-' + [guid]::NewGuid() + '.yaml')
Set-Content -LiteralPath $env:config -Value '{}' -Encoding ascii
$env:BOARD_COLLECTION_REPORT = Join-Path (Get-Location) 'collection-paths.local.json'
python -m unittest discover -s test/company_board -p test_collection_paths.py
python -m unittest discover -s test/company_board -p test_runtime_observation.py
```

托管转发测试在 `src/app-proxy` 下单独运行。

```powershell
uv run --frozen --extra dev pytest -q -p no:cacheprovider tests/test_proxy.py::TestPrefixStripping::test_prefix_stripped_three_forms
```

在同一组输入上修复全部三个执行入口后，业务验收值应为 **7 次成功、1 次失败、4 名服务用户**，预览仍为 0 条终态。届时应更新路径测试中用于记录当前缺口的断言和 JSON，并复查同一执行从路由经过工作线程时只产生一个终态。写入恢复后的补采能力须用独立故障实验验证。[路径回放测试](../../../src/backend/test/company_board/test_collection_paths.py) · [四个看板的完整采集机制](../../../docs/observability/company-board-metrics.md)
