FROM python:3.11-slim

ARG PANDOC_ARCH=amd64
ENV PANDOC_ARCH=$PANDOC_ARCH
ENV PATH="${PATH}:/root/.local/bin"

WORKDIR /app

# 安装依赖（合并指令、清理缓存、禁用推荐包）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    gcc g++ curl build-essential libreoffice \
    wget procps vim fonts-wqy-zenhei \
    libglib2.0-0 libsm6 libxrender1 libxext6 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# 安装 FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*


# 安装 pandoc（GitHub 直连不稳定，失败时走代理；与下面的 NLTK 数据同样处理）
RUN mkdir -p /opt/pandoc && \
    cd /opt/pandoc && \
    ( wget -q --tries=3 --timeout=60 https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-${PANDOC_ARCH}.tar.gz || \
      wget -q --tries=3 --timeout=120 https://gh-proxy.com/https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-${PANDOC_ARCH}.tar.gz ) && \
    tar xvf pandoc-3.6.4-linux-${PANDOC_ARCH}.tar.gz && \
    cp pandoc-3.6.4/bin/pandoc /usr/bin/ && \
    rm -rf /opt/pandoc

# 安装 uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# 安装 Poetry
#RUN curl -sSL https://install.python-poetry.org | python3 - --version 1.8.2

# 拷贝依赖文件并安装全量 Python 包，形成 venv 快照
# Dockerfile 构建时再跑一次 uv sync，只安装 delta，速度极快
COPY ./pyproject.toml ./uv.lock ./
RUN uv sync --frozen --no-dev && uv cache clean

ENV PATH="/app/.venv/bin:$PATH"

# 安装 NLTK 数据
# nltk.download 失败时只返回 False、不抛异常，镜像会"构建成功"却缺数据；
# 同时 raw.githubusercontent.com 在部分网络不可达。这里直连优先、GitHub 代理兜底，
# 最后显式校验四个数据集都在，缺任何一个就让构建失败。
RUN mkdir -p /usr/share/nltk_data/tokenizers /usr/share/nltk_data/taggers && \
    for p in tokenizers/punkt tokenizers/punkt_tab taggers/averaged_perceptron_tagger taggers/averaged_perceptron_tagger_eng; do \
      name=$(basename "$p"); \
      url="https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/$p.zip"; \
      curl -fsSL --max-time 120 -o "/tmp/$name.zip" "$url" || \
        curl -fsSL --max-time 300 -o "/tmp/$name.zip" "https://gh-proxy.com/$url"; \
      python -c "import zipfile; zipfile.ZipFile('/tmp/$name.zip').extractall('/usr/share/nltk_data/$(dirname "$p")')"; \
    done && \
    python -c "import nltk; [nltk.data.find(p) for p in ('tokenizers/punkt','tokenizers/punkt_tab','taggers/averaged_perceptron_tagger','taggers/averaged_perceptron_tagger_eng')]"

# 安装 playwright chromium（包已在 venv 里，此处下载 chromium 二进制及系统依赖）
RUN playwright install chromium && playwright install-deps

