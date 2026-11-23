# BiSheng 云上单机部署操作手册

> 基线：阿里云 ECS + Docker Compose，2026-11 部署实况整理。
> 适用于从零部署一套完整的 BiSheng 平台（含企业微信 SSO、MinIO、OnlyOffice）。

---

## 0. 环境基线

| 项 | 本环境取值 | 说明 |
|---|---|---|
| 服务器 | 1 台 ECS `ecs.e-c1m4.xlarge`（4 vCPU / 14 GiB） | 全栈单机 |
| 系统 | Alibaba Cloud Linux 4.0.6（OpenAnolis Edition），内核 6.6.102 | 基于 RHEL 9 系 |
| Docker | 24.0.9，Compose v2.26.1 | cgroup v2 / systemd driver |
| 磁盘 | 40 G，已用约 88% | 镜像层占大头，需预留 ≥ 10 G |
| 公网 IP | `8.148.26.50`（示例） | 内网 `172.17.176.216` |
| 域名 | `ai.gzbwa.site` → 上述 IP | DNS 托管在阿里云 |
| 代码目录 | `/root/app/bisheng` | git 工作树 |
| 配置目录 | `/root/app/bisheng/docker` | compose + `.env` |

---

## 1. 前置准备

### 1.1 DNS

在域名服务商添加 A 记录，指向 ECS 公网 IP。验证：

```bash
dig +short ai.gzbwa.site
```

### 1.2 安全组（入方向）

| 端口 | 协议 | 来源 | 用途 |
|---|---|---|---|
| 22 | TCP | 运维出口 IP + `100.104.0.0/16` | SSH / 阿里云 Workbench |
| 80 | TCP | `0.0.0.0/0` | ACME 验证 + 跳转 443（未备案时会被阿里云拦截） |
| 443 | TCP | `0.0.0.0/0` | 唯一 Web 入口 |
| 9001 | TCP | 仅运维 IP | MinIO 管理台（可选） |
| 7860 / 8080 / 9200 / 19530 / 9100 / 6379 / 3306 | TCP | 仅运维 IP | 仅调试需要，生产建议全部关闭 |

> 原则：对公网只暴露 443（+80 用于证书）。其余端口只在调试时按 IP 白名单临时放行。

### 1.3 镜像仓库登录

```bash
docker login cr.dataelem.com    # 私有仓库，凭据由供应商提供
```

- **必须在拉取镜像之前完成**，否则第一次 `docker compose up -d` 会在拉私有镜像时 401/403
- `install.sh` 会读取 `.env` 里的 `CR_REGISTRY_USERNAME` / `CR_REGISTRY_PASSWORD` 自动登录；手工部署或单独 `docker pull` 时要先执行上面的命令
- 验证：
  ```bash
  docker pull cr.dataelem.com/mysql:8.0    # 能拉取即登录成功
  ```
- 用 `docker/data/img` 里的离线 tar.gz `docker load` 导入镜像时**不需要**登录（见 §1.4 离线部署）

Docker Hub 在部分云网络不可达，公共镜像统一走 `docker.m.daocloud.io` 或 `cr.dataelem.com`。

### 1.4 网络出入口清单

> 交付给客户运维时可整节作为放行依据。原则：**入向只开 443（+80 用于证书），其余端口保持内网**；出向按实际启用的功能逐项放行，未启用的功能对应域名可以不开。

#### 入方向（公网 → 平台）

| 端口 | 协议 | 来源 | 用途 | 不开的影响 |
|---|---|---|---|---|
| 443 | TCP | `0.0.0.0/0` | 唯一 Web 入口：platform `/`、client `/workspace`、`/api` → backend:7860、`/apps`、企微回调 `/api/v1/user/wecom/callback`、根目录 `WW_verify_*.txt` | 平台与企微登录全部不可用 |
| 80 | TCP | `0.0.0.0/0` | ACME HTTP-01 续期 / 301 跳转 443（走 TLS-ALPN 或 DNS-01 时可关闭） | 无法用 HTTP-01 续期；已签发证书不受影响 |
| 443（`office.<域名>` 虚拟主机） | TCP | `0.0.0.0/0` | OnlyOffice 文档服务，浏览器直连，`office_url` 必须 HTTPS | 文档预览/编辑不可用 |
| 9001 | TCP | 运维 IP | MinIO 管理台（可选） | 无影响 |
| 22 | TCP | 运维出口 IP + `100.104.0.0/16` | SSH / 云控制台 Workbench | 无法运维 |

Docker 内部端口（3306 / 6379 / 9000 / 9100 / 19530 / 9200 / 7860 / 8080 等）不要对公网开放。

> 企业微信服务器需要回访 443 上的回调地址，所以入口域名必须公网可达，且与企微后台的「可信域名 / 授权回调域」完全一致。

#### 出方向（平台 → 互联网）

| 功能 | 目标地址 | 端口 | 触发条件 / 关闭影响 |
|---|---|---|---|
| 企微 SSO / 组织同步 | `qyapi.weixin.qq.com`、`open.weixin.qq.com`、`login.work.weixin.qq.com` | 443 | 使用企微登录或企微通讯录同步；关闭后无法登录/同步 |
| 大模型 / 嵌入 / 重排 | 按所选供应商：`dashscope.aliyuncs.com`、`ark.cn-beijing.volces.com`、`api.openai.com` 等 | 443 | 使用托管模型时；改为自建内网模型则无需 |
| 文档解析 | `mineru.net`（MinerU V4）、`paddleocr.aistudio-app.com`（PaddleOCR jobs） | 443 | 取决于 `knowledges.loader_provider`；本地/自建 ETL4LM 解析则无需 |
| 语音转写 / TTS | 阿里云 `dashscope` / `nls-gateway` | 443 / wss | 音视频知识库转写、TTS 时 |
| 证书签发与续期 | `acme-v02.api.letsencrypt.org` | 443 | 使用 Let's Encrypt；内部 CA 或商业证书无需 |
| 安装 / 升级（一次性） | `cr.dataelem.com`、`docker.m.daocloud.io`、`mirrors.aliyun.com`、`registry.npmmirror.com`、`cdn.npmmirror.com`、`astral.sh`、`github.com`、`gh-proxy.com`、PyPI 镜像 | 443 | 构建镜像、安装系统依赖时；离线导入镜像后运行期不需要 |
| 托管应用运行时 | 应用基础镜像所在 registry | 443 | 启用 `app-runtime` 且需要拉取镜像时 |

#### 离线 / 纯内网部署

1. **镜像**：`docker/data/img` 下的 12 个 `.tar.gz`（约 5.8GB）直接 `docker load`，无需访问 registry。
2. **证书**：使用内部 CA 或商业证书，可关闭 ACME 出向（`acme-v02.api.letsencrypt.org`）。
3. **模型 / 解析**：改为内网端点（vLLM、自建 MinerU、ETL4LM），并在系统配置里改 URL。
4. **企微**：完全不出网时企微 SSO 与组织同步不可用；必须使用则放行上表三个企微域名，或给平台配置正向代理。
5. **时间同步**：使用内网 NTP。

**最小放行清单**：入向 443（+ 按需 80 与 `office.<域名>`），出向企微三个域名 + 实际使用的模型/解析域名；其余都是安装期依赖，可离线解决。

---

## 2. 代码与配置

### 2.1 获取代码

```bash
git clone https://github.com/<org>/bisheng.git /root/app/bisheng
cd /root/app/bisheng
git checkout uat/ecs-ali      # 部署分支
```

部署分支约定：每套环境一个长期分支，功能分支通过 cherry-pick 合入。

### 2.2 准备 `.env`

```bash
cd /root/app/bisheng/docker
cp .env.example .env
chmod 600 .env
```

必须设置的变量（其余保持模板默认）：

| 变量 | 说明 |
|---|---|
| `BISHENG_BACKEND_IMAGE` / `BISHENG_FRONTEND_IMAGE` | 平台镜像 tag，按日期命名（见 §3.3） |
| `MYSQL_ROOT_PASSWORD` / `BS_DATABASE_URL` | 数据库口令（URL 中需与口令一致） |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO 根凭据，仅用于管理台 |
| `MINIO_APP_ACCESS_KEY/SECRET_KEY` | 后端对象存储身份 |
| `MINIO_MILVUS_ACCESS_KEY/SECRET_KEY` | Milvus 对象存储身份 |
| `BS_DSH_PLATFORM_PUBLIC_URL` | 对外访问地址，如 `https://ai.gzbwa.site` |
| `BISHENG_NGINX_CONF_DIR` | tls-proxy 的 nginx 配置目录 |
| `ONLYOFFICE_IMAGE` | 见 §8 |

> `.env` 含明文口令，务必 `chmod 600` 且不要提交到仓库（模板已 gitignore）。

### 2.3 分支与镜像对照

| 环境 | 镜像 tag | 含义 |
|---|---|---|
| 当前 | `src-v3.0.1-1119` | 11-19 发布线 |
| 回滚 | `src-v3.0.1-1112` | 上一版基线 |

命名规则：`src-<版本>-<MMDD>`。同日多次发布追加序号（如 `-1119-2`）。

---

## 3. 镜像获取与构建

### 3.1 中间件镜像

全部来自私有仓库，直接 `docker pull` 即可（compose 会自动拉取）。**拉取前先完成 §1.3 的 `docker login cr.dataelem.com`**；如果是用离线 tar.gz 导入镜像，则跳过登录。

### 3.2 后端镜像

标准构建的第一行是 `FROM dataelement/bisheng-backend:base.v10`。

#### base 镜像是什么

`src/backend/base.Dockerfile` 就是它的构建源，由 CI 在推送 `base.v*` tag 时发布：

```yaml
# .github/workflows/base_ci.yml
on:
  push:
    tags: ["base.v*"]
# ...
docker buildx build -f ./src/backend/base.Dockerfile \
  --platform linux/amd64 \
  --tag dataelement/bisheng-backend:<tag>-amd64 --push ./src/backend/
```

版本号取自 git tag（`base.v10` → 镜像 `:base.v10-amd64`，再由 multi-arch manifest 合成最终 tag）。它装的是重量级、变化慢的部分：

| 层 | 内容 |
|---|---|
| 基础 | `python:3.11-slim` |
| 系统库 | gcc/g++/build-essential、libreoffice、ffmpeg、wget、vim、中文字体、libgl 等 |
| 工具 | pandoc 3.6.4（GitHub release）、uv（astral.sh） |
| Python | `uv sync --frozen --no-dev` 形成的 venv 快照 |
| 数据 | NLTK punkt / pos_tagger、playwright chromium 及系统依赖 |

所以 `Dockerfile` 只需在它之上补依赖差异和源码，构建很快。

#### 云上构建流程（Docker Hub 不可达时，已实测）

Docker Hub 不可达的机器上，直接 `docker buildx build` 会在拉取 `python:3.11-slim` 时就失败。可行路径是：从镜像代理拉 python 基础镜像，用一份加速版 Dockerfile 走国内源。

**1. 准备 python 基础镜像**

```bash
docker pull docker.m.daocloud.io/library/python:3.11-slim
docker tag docker.m.daocloud.io/library/python:3.11-slim python:3.11-slim
```

**2. 生成加速版 Dockerfile**

在 `base.Dockerfile` 的 `FROM` 之后插入源替换，并把结果写成**构建上下文内**的 `base.Dockerfile.fast`。BuildKit 会把 `-f` 的裸文件名解析成上下文内的相对路径，放在 `/tmp` 会报
`failed to read dockerfile: open /var/lib/docker/tmp/buildkit-mount…: no such file or directory`。

```bash
cd src/backend
{ head -n1 base.Dockerfile
  cat <<'EOF'
RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list
ENV UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple
ENV UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
ENV UV_HTTP_TIMEOUT=300
EOF
  tail -n +2 base.Dockerfile; } > base.Dockerfile.fast

head -8 base.Dockerfile.fast        # 应看到 FROM 之后紧跟 RUN sed …
```

（`base.Dockerfile.fast` 已加入 `.gitignore`，不会污染工作区。）

`UV_HTTP_TIMEOUT=300` 是必须的：uv 默认 30s 超时，在约 0.8 MB/s 的经济型带宽上下载 `rapidfuzz`、`playwright` 这类几十 MB 的包会直接失败（实测报 `Failed to download … network timeout`）。

**3. 后台构建（断开 SSH 不影响）**

```bash
cd src/backend
nohup sh -c 'docker build -f base.Dockerfile.fast --platform linux/amd64 \
  -t dataelement/bisheng-backend:base.v10 . > /tmp/base-build.log 2>&1; \
  echo "EXIT=$?" >> /tmp/base-build.log' >/dev/null 2>&1 &
```

查看进度：

```bash
tail -f /tmp/base-build.log
grep -c "^#[0-9]* .*Get:" /tmp/base-build.log      # 已下包数
docker images | grep base.v10                       # 成功才有输出
```

成功标志：BuildKit 日志出现 `naming to docker.io/dataelement/bisheng-backend:base.v10`，且末尾 `EXIT=0`。`Successfully tagged …` 是旧版 builder 的输出，BuildKit 下不会出现。

完成后校验 NLTK 数据确实装进了基础镜像（`nltk.download` 失败时不报错，旧的 base 曾因此缺数据）：

```bash
docker run --rm dataelement/bisheng-backend:base.v10 python -c \
  "import nltk; [nltk.data.find(p) for p in ('tokenizers/punkt','tokenizers/punkt_tab','taggers/averaged_perceptron_tagger','taggers/averaged_perceptron_tagger_eng')]; print('NLTK OK')"
```

**4. 用标准 Dockerfile 构建正式后端镜像**

```bash
cd src/backend
docker build -t bisheng-backend:src-v3.0.1-<MMDD> .
```

#### 实测耗时与资源

| 阶段 | 耗时（4C / 14 GiB、约 5–6 Mbps） |
|---|---|
| apt 依赖（300+ 包，含 gcc / libreoffice） | 10–20 分钟 |
| pandoc / uv sync / NLTK / chromium | 15–25 分钟 |
| 标准 Dockerfile 构建（依赖已缓存） | 5–10 分钟 |

- **磁盘**：构建前至少预留 10 GB（apt 包 + venv + chromium + 构建层）。不足时先 `docker builder prune -f`（实测可回收约 4 GB 构建缓存）和 `docker image prune -f`，再用 `df -h /` 确认
- **内存**：构建前建议停掉 OnlyOffice 等非必要容器，腾出 2–3 GB
- **带宽**：经济型实例出带宽约 5 Mbps，下载上限 0.7–0.8 MB/s；临时提到 100 Mbps 可快十倍

arm64 构建还需按 CI 的做法先移除 `ibm-db`（该驱动不支持 arm64）：

```bash
sed -i '/ibm-db*/d' pyproject.toml
```

镜像代理可用时，直接 `docker pull dataelement/bisheng-backend:base.v10` 更省事。

**A. 标准构建（网络允许时）**

```bash
cd /root/app/bisheng/src/backend
docker build -t bisheng-backend:src-v3.0.1-<MMDD> .
```

**B. 增量镜像（应急，本环境使用）**

以现有镜像为底，替换改动文件后提交：

```bash
docker create --name tmp bisheng-backend:src-v3.0.1-<旧MMDD>
docker cp bisheng/sso_sync/domain/services/xxx.py tmp:/app/bisheng/sso_sync/domain/services/xxx.py
docker commit --change 'CMD ["sh", "entrypoint.sh"]' tmp bisheng-backend:src-v3.0.1-<MMDD>
docker rm -f tmp
```

> 增量镜像内容正确但不可复现，基础镜像可用后应重建。

### 3.3 前端镜像

前端是构建产物，推荐在本机构建后传输：

```bash
# 本机（需 node 20+ / pnpm）
cd src/frontend
pnpm install --frozen-lockfile
pnpm --filter bisheng build        # platform
pnpm --filter bishengchat build    # client
tar czf /tmp/fe-build.tgz client/build platform/build
scp /tmp/fe-build.tgz root@<host>:/tmp/
```

```bash
# 服务器
mkdir -p /tmp/fe-release && tar xzf /tmp/fe-build.tgz -C /tmp/fe-release
cat > /tmp/fe-release/Dockerfile <<'EOF'
FROM bisheng-frontend:src-v3.0.1-<旧版本>
RUN rm -rf /usr/share/nginx/html/platform /usr/share/nginx/html/client
COPY platform/build/ /usr/share/nginx/html/platform/
COPY client/build/ /usr/share/nginx/html/client/
EOF
docker build -t bisheng-frontend:src-v3.0.1-<MMDD> /tmp/fe-release
```

> 必须删旧目录再 COPY，否则历史构建的旧 chunk 会残留（易导致前端加载到旧资源）。

#### 服务器本机构建（`src/frontend/Dockerfile`）

也可以直接在这台机器上构建，不依赖本机产物：

```bash
# 基础镜像走代理（Docker Hub 不可达时）
docker pull docker.m.daocloud.io/library/node:20-alpine
docker tag  docker.m.daocloud.io/library/node:20-alpine node:20-alpine
docker tag  docker.m.daocloud.io/library/nginx:1.30-alpine nginx:latest   # Dockerfile 最后一段是 FROM nginx

cd src/frontend
docker build -f Dockerfile -t bisheng-frontend:src-v3.0.2-<MMDD> .
```

- `FROM nginx` 没有固定版本，构建时会拉 Docker Hub 的 `library/nginx:latest`；这台机器访问不了 Docker Hub，**必须先给本地 nginx 打 `latest` 标签**（用 daocloud 镜像，或 TLS 反代在用的 `nginx:1.30-alpine`），否则报 `nginx: failed to do request … i/o timeout`
- npm 依赖走 `src/frontend/.npmrc` 里的 `registry.npmmirror.com`，1900+ 包，构建约 15–20 分钟
- 产物镜像约 140 MB（干净分层，比叠加式更新出来的镜像小很多）

---

## 4. 启动整套服务

### 4.1 服务清单（15 个容器）

`mysql` `redis` `elasticsearch` `etcd` `minio` `milvus` `openfga` `openfga-migrate` `backend` `backend_worker` `backend_beat` `frontend` `code-runner-1` `code-runner-2` + 独立项目 `office`

### 4.2 启动

```bash
cd /root/app/bisheng/docker
docker compose up -d
```

首次启动顺序由 `depends_on` 保证；backend 会自动建表并执行 Alembic 迁移。

### 4.3 验证清单

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
curl -sk https://<域名>/            # 200
curl -sk https://<域名>/workspace/  # 200
curl -sk https://<域名>/admin       # 200
curl -sk https://<域名>/api/v1/user/wecom/availability   # 200
```

数据库 / 向量库 / 对象存储就绪判断：

```bash
docker exec bisheng-backend curl -sf http://minio:9000/minio/health/live   # 200
docker inspect -f '{{.State.Health.Status}}' bisheng-milvus-standalone      # healthy
```

---

## 5. 域名与 TLS

### 5.1 nginx 只接受域名

`docker/nginx/tls/conf.d/bisheng.conf`：

```nginx
server { listen 80 default_server; server_name _; return 444; }
server { listen 443 ssl default_server; server_name _; ssl_reject_handshake on; }

server { listen 80; server_name <域名>; ... 301 → https ... }
server { listen 443 ssl; server_name <域名>; ... proxy_pass http://frontend:3001 ... }
```

效果：IP 直连 443 在握手阶段被拒（连证书都不发），80 直接断连。

### 5.2 证书：acme.sh + Let's Encrypt

```bash
# 安装
curl -sSL -o acme.sh https://gitee.com/neilpang/acme.sh/raw/master/acme.sh
sh acme.sh --install
```

**方式 A：TLS-ALPN-01（80 被备案拦截时唯一可用）**

```bash
/root/.acme.sh/acme.sh --issue --alpn -d <域名> --server letsencrypt \
  --pre-hook  "docker stop bisheng-tls-proxy" \
  --post-hook "/usr/local/sbin/bisheng-tls-reload.sh" \
  --accountemail admin@<域名>
```

**方式 B：HTTP-01 webroot（域名已备案、80 可用时，无中断）**

```bash
/root/.acme.sh/acme.sh --issue -d <域名> --webroot /var/www/acme --server letsencrypt
```

配套两处配置：

```yaml
# docker/nginx/tls/docker-compose.yml
- /var/www/acme:/var/www/acme:ro
```
```nginx
location ^~ /.well-known/acme-challenge/ { root /var/www/acme; default_type text/plain; }
```

### 5.3 证书安装与续期钩子

```bash
/root/.acme.sh/acme.sh --install-cert -d <域名> --ecc \
  --key-file       /etc/nginx/ssl/server.key \
  --fullchain-file /etc/nginx/ssl/server.crt \
  --reloadcmd      /usr/local/sbin/bisheng-tls-reload.sh
```

`bisheng-tls-reload.sh` 的作用：先确保容器启动、轮询 `nginx -t` 通过，再 reload。避免续期时容器处于停止状态导致 reload 失败。

cron（acme.sh 安装时自动写入）：

```
38 1,7,13,19 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null
```

> **中断窗口**：TLS-ALPN 续期需独占 443，站点中断 10–20 秒；HTTP-01 无中断。

### 5.4 备案注意

未备案域名，阿里云会在 **80 端口入口**返回 403「Non-compliance ICP Filing」页面（服务器本机访问正常，说明拦截在网络层）。此时 HTTP-01 必然失败，只能走 TLS-ALPN 或完成备案。

---

## 6. 企业微信 SSO

### 6.1 企微后台

1. 应用管理 → 自建应用 → 记录 `corpid` / `agentid` / `secret`
2. **网页授权及 JS-SDK** → 可信域名 = `<域名>`，上传 `WW_verify_*.txt` 到站点根目录完成校验
3. **企业微信授权登录** → 可信域名同上（PC 扫码用）
4. 应用主页（工作台入口）：

```
https://<域名>/api/v1/user/wecom/authorize?mode=silent&return_to=https%3A%2F%2F<域名>%2Fworkspace%2F
```

5. 可见范围 → 添加部门/成员

### 6.2 平台侧

在「组织同步」中新建一条 `wecom` 配置（active，且只能有一条），填入 corpid/secret/agentid，即可在登录页出现企业微信入口。

### 6.3 已知问题

- 报 **19334 企业微信授权失败**：多数是 Redis 中 `org_sync:wecom:token:{id}` 缓存了被轮换的 token。当前版本已内置 40014/42001 自动重取；旧版本需手动 `DEL` 该 key。
- 回调成功但无 userid：成员不在应用可见范围，日志出现 `returned no userid`。

---

## 7. MinIO

### 7.1 身份分离（必须）

| 主体 | 用途 | 权限 |
|---|---|---|
| root | 管理台 | 全部 |
| `bisheng-app` | backend / worker / beat | `bisheng`、`tmp-dir` |
| `bisheng-milvus` | milvus | `a-bucket` |

在管理台 Identity → Policies 建策略，再挂到对应用户。**策略需包含 lifecycle**：

```json
{ "Effect": "Allow",
  "Action": ["s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"],
  "Resource": ["arn:aws:s3:::bisheng", "arn:aws:s3:::tmp-dir"] }
```

> 漏掉 lifecycle 会导致 backend 启动失败：`_ensure_tmp_bucket_lifecycle` 抛 AccessDenied，容器反复重启。
> 注意 MinIO 只认 AWS 风格 action 名，且没有 `DeleteLifecycleConfiguration`。

### 7.2 管理台访问

容器启动参数 `--console-address ":9001"`，但默认 compose 只映射 `9100:9000`。需要时：

```yaml
ports:
  - "9100:9000"
  - "127.0.0.1:9001:9001"   # 仅本机 + SSH 隧道
```

```bash
ssh -N -L 9001:127.0.0.1:9001 root@<host>
# 浏览器 http://127.0.0.1:9001
```

公网开放请在安全组限制来源 IP，并先更换默认口令。

### 7.3 客户端工具

```bash
curl -sSL -o /usr/local/bin/mc \
  https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z
chmod +x /usr/local/bin/mc
export MC_HOST_local="http://<root-user>:<root-pass>@127.0.0.1:9100"
mc admin user list local
```

---

## 8. OnlyOffice（可选）

### 8.1 版本选择

**不要用 7.1.1**：其内置 Erlang OTP 22 在 cgroup v2 内核上 `erl_child_setup` 自旋 100% CPU，RabbitMQ 永远起不来。使用 8.1.3+：

```ini
ONLYOFFICE_IMAGE=docker.m.daocloud.io/onlyoffice/documentserver:8.1.3
```

### 8.2 /dev/shm

默认 64 MB 会导致编辑器卡死，必须在 compose 中设置：

```yaml
services:
  office:
    shm_size: "1gb"
    ports: ["8701:80"]
```

启动约 9 分钟（首次含字体缓存生成），验证：

```bash
curl -s http://127.0.0.1:8701/healthcheck          # true
curl -sI http://127.0.0.1:8701/web-apps/apps/api/documents/api.js   # 200
```

### 8.3 接入平台

平台通过 DB 配置 `office_url` 下发给前端。**必须是 HTTPS**，否则浏览器以混合内容拦截。推荐子域名：

```
office.<域名> → 443 → nginx 反代 → office:80
```

证书并入现有 LE 证书（追加 SAN 后重签）。

---

## 9. 安全加固

### 9.1 SSH 来源白名单

`/usr/local/sbin/ssh-source-guard.sh` + systemd 单元，iptables 只放行：

```
ALLOW="<运维出口网段> 100.104.0.0/16"
```

- `100.104.0.0/16` 是**阿里云 Workbench / 控制台远程连接的来源**，漏掉会导致控制台登录失败
- 脚本 `clear_rules()` 先删本单元所有规则再重建，换白名单不会留孤儿规则
- 3389 一律 DROP

### 9.2 端口最小化

- frontend 的 3001 只绑 `127.0.0.1:3001:3001`，对外只走 nginx 443
- 安全组只保留 22 / 80 / 443；调试端口用完即关

### 9.3 凭据管理

- `.env` 权限 600，不入库
- 定期清理 `.env.bak-*`（含历史明文口令）
- MinIO 服务 key 与 root 分离；离职/轮换时只换服务 key

---

## 10. 日常运维

### 10.1 更新镜像

```bash
# 1. 改代码 + 提交
# 2. 构建/加载新镜像，tag 为 src-<版本>-<MMDD>
# 3. 改 .env 的 BISHENG_*_IMAGE
docker compose up -d backend backend_worker backend_beat
docker compose exec frontend nginx -s reload   # 重建 backend 后刷新 upstream 解析
```

> **坑**：backend 重建后容器 IP 会变，frontend 的 nginx 在启动时已把 `backend:7860` 解析成旧 IP，所有 `/api` 请求 502（容器内直连 `127.0.0.1:7860` 却是 200）。`docker compose exec frontend nginx -s reload` 让它重新解析即可；`docker compose up -d frontend` 重建容器也有效，但没必要。

更新前端镜像时同理，方向反过来（frontend → TLS 反代）：

```bash
docker compose up -d frontend
cd nginx/tls && docker compose exec -T tls-proxy nginx -s reload
```

> TLS 反代里是静态的 `proxy_pass http://frontend:3001;`，frontend 重建后 IP 变化，不 reload 就是全站 502。

### 10.2 重启

```bash
docker compose restart backend backend_worker backend_beat
```

### 10.3 备份

| 对象 | 方式 |
|---|---|
| MySQL | `docker exec bisheng-mysql mysqldump -uroot -p<pw> bisheng > backup.sql` |
| MinIO | 挂载卷 `docker/data/milvus-minio` |
| ES | 快照或 `docker/data/es` |
| 配置 | `docker/.env`、`docker/bisheng/config/config.yaml`、`docker/nginx/` |
| 证书 | `/etc/nginx/ssl`、`/root/.acme.sh` |

### 10.4 日志

```bash
docker logs --since 30m bisheng-backend
docker logs --since 30m bisheng-tls-proxy     # 访问日志
docker logs --since 30m bisheng-backend-worker
```

---

## 11. 故障排查速查

| 现象 | 首查 | 常见原因 |
|---|---|---|
| 全站 502 | frontend / TLS 反代状态 + 上下游 IP | backend 重建后 frontend nginx 仍指向旧 IP（reload frontend）；frontend 重建后 TLS 反代仍指向旧 IP（reload tls-proxy） |
| 企业微信 19334 | 后端日志 `getuserinfo rejected` | token 缓存轮换（旧版本）；可见范围/agentid 不匹配 |
| 后端反复重启 | `docker logs bisheng-backend` 找 `ContextInitializationError` | MinIO 策略缺 lifecycle / 凭据错误 |
| 证书错误 | `openssl s_client -connect <域名>:443 -servername <域名>` | SAN 不含域名；续期失败 |
| 80 返回备案页 | 服务器本机 curl 127.0.0.1 | 阿里云未备案拦截（网络层） |
| 控制台 Workbench 连不上 | `iptables -S INPUT` | SSH 白名单漏 `100.104.0.0/16` |
| 磁盘告警 | `docker system df` | 旧镜像层；用 `docker rmi` 清历史 tag |
| OnlyOffice 卡启动 | `docker logs bisheng-office` | Erlang 版本 / shm 过小 |

---

## 12. 回滚

```bash
cd /root/app/bisheng/docker
sed -i 's/^BISHENG_BACKEND_IMAGE=.*/BISHENG_BACKEND_IMAGE=bisheng-backend:src-v3.0.1-1112/' .env
sed -i 's/^BISHENG_FRONTEND_IMAGE=.*/BISHENG_FRONTEND_IMAGE=bisheng-frontend:src-v3.0.1-1112/' .env
docker compose up -d backend backend_worker backend_beat
docker compose up -d frontend
```

- 代码回滚：`git checkout <上一个部署提交>`（部署分支保留每次发布提交）
- 证书回滚：`/etc/nginx/ssl/server.crt.bak-*`、`server.key.bak-*`
- 配置回滚：`docker/.env.bak`（部署基线）

---

## 附录 A：目录布局

```
/root/app/bisheng/
├── docker/
│   ├── docker-compose.yml          # 主栈
│   ├── docker-compose-office.yml   # OnlyOffice（独立项目）
│   ├── .env                        # 600，含明文凭据
│   ├── bisheng/config/config.yaml  # 挂载进容器（!env 引用）
│   ├── nginx/tls/                  # tls-proxy 配置 + compose
│   └── data/                       # MySQL / ES / MinIO 等数据卷
├── src/backend/                    # 源码（镜像构建输入）
└── src/frontend/                   # 前端源码（产物由本机构建）

/etc/nginx/ssl/                     # server.crt/key、ca.crt/key（历史）
/var/www/acme/                      # HTTP-01 webroot
/root/.acme.sh/                     # acme.sh 与证书存储
/usr/local/sbin/ssh-source-guard.sh # SSH 白名单
```

## 附录 B：端口总表

> `A → B` 表示 Docker 端口映射：宿主机开放 A，容器内监听 B。容器之间通信走容器端口（如 `minio:9000`），只有从宿主机或外部访问时才用宿主机端口。

| 端口 | 协议 | 容器 | 说明 |
|---|---|---|---|
| 443 | HTTPS | tls-proxy | 唯一 Web 入口 |
| 80 | HTTP | tls-proxy | ACME 验证 + 跳转 443 |
| 3001 | HTTP | frontend | 仅 127.0.0.1 |
| 7860 | HTTP | backend | API，仅调试 |
| 3306 | TCP (MySQL) | mysql | 业务数据库 |
| 6379 | TCP (Redis) | redis | 缓存 / 队列 |
| 9200 | HTTP | es | 检索 API |
| 9300 | TCP | es | 集群传输，单节点可不暴露 |
| 19530 | gRPC | milvus | 向量库 |
| 9091 | HTTP | milvus | metrics / 健康检查 |
| 9100 → 9000 | HTTP (S3) | minio | 对象存储数据面 |
| 9001 | HTTP | minio | 管理台，按需 |
| 8080 | HTTP | openfga | 权限 API |
| 8081 | gRPC | openfga | 权限 gRPC |
| 2112 | HTTP | openfga | metrics |
| 8701 → 80 | HTTP | office | OnlyOffice，可选 |
