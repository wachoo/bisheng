# Information 测试环境部署

适用于与毕昇 API、Worker 位于同一 Docker 主机的 Linux 测试环境。交付目录为 `services/information/`，包含服务代码、管理页、Dockerfile 和 Compose 配置。一个容器运行采集器和 HTTP 服务，文章与订阅写入独立 SQLite 命名卷。

## 拉取交付版本

准备 GitLab 仓库读取权限、Docker Engine、Compose v2 和 OpenSSL。构建需要取得 `python:3.12-slim` 及 Python 依赖，运行时需要访问 `https://aihot.news` 和 `http://47.120.55.7:8001`。

在测试机新建独立检出目录。以下命令在 Bash 中执行，仓库地址使用 GitLab **Clone** 菜单提供的地址，分支名取交付通知中的值。

```bash
read -rp 'GitLab 克隆地址：' repo_url
read -rp '交付分支：' release_branch
git clone --single-branch --branch "$release_branch" --sparse "$repo_url" information-release
cd information-release
git sparse-checkout set services/information
git rev-parse --short HEAD
cd services/information
```

将输出的提交号与交付通知核对。

## 选择网络并启动

在测试机查询 API 和 Worker 的容器网络。以下使用项目默认容器名；实际名称可用 `docker ps` 查询。

```bash
docker inspect --format '{{.Name}} {{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}' \
  bisheng-backend bisheng-backend-worker
```

选择两者共用的网络。首次部署前，检查该网内是否已有其他服务使用 `information` 或 `bisheng-information-test` 别名。Compose 会同时注册这两个 DNS 名称，重名可能将现有调用方分流到新容器。

```bash
read -rp 'API 和 Worker 共用的 Docker 网络名：' network
docker ps -q --filter "network=$network" | xargs -r docker inspect \
  --format "{{.Name}} {{with index .NetworkSettings.Networks \"$network\"}}{{json .Aliases}}{{end}}"
```

确认无冲突后，在服务目录首次生成 `.env`，把两份独立凭据保存在测试环境的凭据管理处。已有 `.env` 的实例沿用原配置。

```bash
if [ ! -e .env ]; then
  (
    set -euC
    umask 077
    docker network inspect "$network" >/dev/null
    api_key=$(openssl rand -hex 32)
    admin_password=$(openssl rand -hex 32)
    cat > .env <<EOF
BISHENG_TEST_NETWORK=$network
INFORMATION_API_KEYS='{"bisheng":"$api_key"}'
INFORMATION_ADMIN_PASSWORD=$admin_password
EOF
  )
fi
```

在该目录定义下列 Bash 函数并启动服务。后续命令沿用这个函数，重新登录后需再次定义。固定项目名使容器重建后继续使用同一个数据卷。

```bash
info() { docker compose -p bisheng-information-test -f compose.yaml -f compose.bisheng.yaml "$@"; }
info config --quiet && info up -d --build
info ps
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8765/health
```

健康接口应返回 `{"status":"ok"}`。默认端口仅绑定本机。如果 8765 已占用，在 `.env` 中设置 `INFORMATION_PORT=18765` 等空闲端口，并在宿主机访问时使用该端口。容器间仍使用 8765。

## 验证并接入毕昇

1. 打开测试机的 `/admin/sources`，使用 `admin` 和 `INFORMATION_ADMIN_PASSWORD` 登录。远程运维可在自己的机器运行 `ssh -L 18765:127.0.0.1:8765 用户@测试机`，再打开 [本机转发的管理页](http://127.0.0.1:18765/admin/sources)。在两个来源详情中查看首轮正式采集记录，确认均有文章；失败条目可展开查看原因。
2. 在测试机上从毕昇 API 和 Worker 分别验证内部地址，两个命令都应输出健康状态。

   ```bash
   (
     set -e
     for c in bisheng-backend bisheng-backend-worker; do
       echo "$c"
       docker exec "$c" python -c 'from urllib.request import urlopen; print(urlopen("http://bisheng-information-test:8765/health", timeout=5).read().decode())'
     done
   )
   ```

3. 切换前记录测试站现有的 `information_conf` 并核对已有频道。API 和 Worker 共用全站订阅地址；新服务只提供 AIHOT 和能源雷达。若还有频道依赖原服务的其他来源，保留现有配置，本次可先验收到第 2 步，或在单独的毕昇实例做频道联调。确认测试站可以切换后，通过毕昇系统配置编辑已有条目，将 `base_url` 设为 `http://bisheng-information-test:8765`，将 `api_key` 设为 `.env` 中 JSON 对象的 `bisheng` 字段值，保留其余参数。平台会自行拼接 `/information/*`。
4. 在工作台创建私有测试频道，选择“AIHOT 热点榜”和“能源招标机会雷达”。确认默认 Worker 与 Beat 正在运行，等一次同步后打开两类文章。雷达可核对判断理由、证据和正文换行，AIHOT 可核对进展和报道链接。首次默认每个来源最多拉取 36 篇。需要验收知识投递时，再选一篇中文标题公告转存并查看知识文件状态。

## 更新与回退

更新前记录服务提交号和当前镜像 ID（`info images`）。在原检出切换到交付的提交，使用同一项目名执行 `info up -d --build`，复验健康、采集和工作台频道。配置、采集记录及文章版本保存在 `bisheng-information-test_articles` 卷。

接入后需要撤回时，先处理本次测试频道对新来源的订阅，再恢复毕昇原来的 `information_conf`，验证原来源可以读取后执行 `info stop information`。仅需回退服务代码时，切回先前的兼容提交并重新构建启动。保留原 `.env` 和数据卷，`down -v` 会删除卷内数据。
