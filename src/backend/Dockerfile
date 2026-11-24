FROM dataelement/bisheng-backend:base.v10

WORKDIR /app

# 先装依赖再复制源码，利用 Docker 层缓存：uv.lock 不变时此层命中缓存
COPY ./pyproject.toml ./uv.lock ./
RUN uv sync --frozen --no-dev && uv cache clean
ENV PATH="/app/.venv/bin:$PATH"

# NLTK 数据由 base 镜像提供（base.Dockerfile 用 curl + 校验安装，失败会让基础镜像
# 构建失败）。这里不要再调 nltk.download：它失败时只返回 False、不抛异常，且
# raw.githubusercontent.com 在受限网络里会长时间挂住，让应用镜像构建超时。

COPY ./ ./

# dmPython 附带的 dmssl 包含 libssl.so / libcrypto.so 等原生库。
# 将它们移入 bin/ 子目录，然后设置 DM_HOME，驱动即可找到这些库。
# dmPython / dmSQLAlchemy / dmAsync 在 Linux 上由 pyproject.toml 自动包含，
# 已由 base 镜像的 uv sync 安装到 venv，此处仅整理 .so 目录。
RUN SITE=$(python -c "import site; print(site.getsitepackages()[0])") && \
    DMSSL="$SITE/dmssl" && \
    if [ -d "$DMSSL" ]; then \
        mkdir -p "$DMSSL/bin" && \
        mv "$DMSSL"/*.so "$DMSSL/bin/" 2>/dev/null || true; \
    fi

# DM_HOME 指向 venv 内的 dmssl，与 base 镜像的 uv sync venv 路径保持一致。
ENV DM_HOME="/app/.venv/lib/python3.11/site-packages/dmssl/"

CMD ["sh", "entrypoint.sh"]
