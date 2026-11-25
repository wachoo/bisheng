# 订阅信息源服务

本服务为毕昇频道提供 AIHOT 热点事件和能源招标公告。每个事件或公告有一个稳定的文章 ID，Markdown 用于检索、问答和知识文件，HTML 用于详情阅读。管理员在 `/admin/sources` 查看采集记录、调整周期、暂停或恢复来源，并试采预览转换结果。

Linux 测试机部署、内网接入和回退步骤见[测试环境部署指引](deployment.md)。

## 本机启动

在本目录运行 Docker Compose。准备两个独立的随机凭据，可以在 PowerShell 会话中生成：

```powershell
$apiKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:INFORMATION_API_KEYS = @{ bisheng = $apiKey } | ConvertTo-Json -Compress
$env:INFORMATION_ADMIN_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose up -d --build
Invoke-RestMethod 'http://127.0.0.1:8765/health'
```

将凭据保存至部署环境的密钥管理配置，后续启动时传入相同的值。管理入口为 `http://127.0.0.1:8765/admin/sources`，浏览器用户名为 `admin`，密码取自 `INFORMATION_ADMIN_PASSWORD`。Compose 默认只发布到本机，可通过内网 HTTPS 反向代理开放远程管理。应用端口通过 `INFORMATION_PORT` 调整。

镜像以单进程运行，各来源有各自的后台采集线程。命名卷 `articles` 持久保存配置、订阅、文章历史版本、待重试条目和采集记录。每个服务实例使用专属卷，升级时在相同的 Compose 项目下复用该卷。默认每 30 分钟检查一次，管理页可设 60 秒至 7 天。启用后即开始采集，毕昇随后订阅也可以读取首批文章。

## 接入毕昇

Information 可以作为单独的服务部署。接入方需有毕昇频道的 Information 客户端、默认 Worker 和定时调度。毕昇侧另有知识文件临时对象清理修复，涉及带中文、百分号、空格或加号的文件名，可随毕昇后端发布。

在隔离测试实例的系统配置中编辑已有 `information_conf`，保留其他参数。将 `base_url` 设为后端和默认 Worker **都能访问的服务根地址**，将 `api_key` 设为上例的 `$apiKey` 值。处于同一个 Docker 网络时，根地址可用 `http://information:8765`。两个独立 Compose 项目默认各有自己的网络，需将 Information 服务接入毕昇的内网，或使用两端均可达的内网代理地址。毕昇自行拼接 `/information/*`。

在工作台的频道管理中，从网站来源目录选取“AIHOT 热点榜”或“能源招标机会雷达”，保存频道。默认 Worker 和定时调度须已运行。首次拉取默认选取最近发布的 36 篇，后续按包含下界的游标接收新文章和修订。独立调用方可在 `INFORMATION_API_KEYS` 对象中各设一组名称和密钥；订阅按名称保存，轮换密钥时保留原名称。

## 核对正文与采集结果

打开来源详情页，运行试采并选取条目，核对正文、文章 ID 和原文链接。试采显示本次转换与当前正式版本的比较结果，不写入正式文章或更新同步时间。正式采集会记录每次尝试及失败原因。

- **热点事件**保留 AIHOT 自身可读的事件概要、进展和报道时间线。报道链接供读者打开。仅排名或热度变化时保留原文章版本。
- **招标公告**在正文中区分原公告和雷达研判，保留采购范围、明确的截止时间和溯源地址。另发公告按独立公告处理。两份真实输入摘录见 [samples](samples/)。
- **采集范围**限于配置的目标信息源。能源雷达提供判断理由、逐条原文证据、公开附件和公告正文。频道与知识文件分别保留证据引用和正文的原有换行、空格。发布机构的原公告链接仅供溯源。
- **表格与图片**按目标信息源实际提供的结构转换。规则表格生成 Markdown 表格，合并单元格等复杂结构在 Markdown 中保留 HTML 表格。正文图片保留地址、替代文字和图注，显示原图需要阅读端能访问图源。
- **部分成功**表示已交付可用条目，详情失败的条目进入后续轮次重试。列表请求失败或全部条目失败时保留上次成功时间。暂停后，毕昇仍可读取历史文章。
- **历史范围**受上游滚动列表约束。自启用起保存正式版本，停机跨过列表窗口时可能出现缺口。频道索引接收同 ID 修订，已转存的知识文件保留转存时正文。

## 本地回归

在本目录使用 Python 3.12 和 uv 运行：

```sh
uv run --python 3.12 --with-requirements requirements.txt --with httpx==0.28.1 python -m unittest discover -v
```

测试在临时 SQLite 文件中回放真实样例和边界条件，覆盖文章身份、修订与分页、独立订阅、失败重试、管理鉴权及暂停期间的在途采集。
