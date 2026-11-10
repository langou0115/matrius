FROM node:24-slim AS agent-builder
WORKDIR /opt/matrius
COPY package.json package-lock.json ./
COPY agent/package.json ./agent/package.json
COPY scripts/sync-katex.mjs ./scripts/sync-katex.mjs
RUN npm ci --no-audit --no-fund
COPY agent ./agent
COPY src/core ./src/core
COPY tsconfig.json ./tsconfig.json
COPY scripts/run-services.mjs ./scripts/run-services.mjs

FROM python:3.12-slim

ARG PYPI_INDEX_CANDIDATES="https://pypi.org/simple,https://pypi.tuna.tsinghua.edu.cn/simple"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/app/.venv/bin:$PATH

COPY --from=agent-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-builder /opt/matrius /opt/matrius

WORKDIR /app

COPY server/scripts/select-index.py ./scripts/select-index.py
RUN for index in $(python3 scripts/select-index.py); do \
      pip install --no-cache-dir "uv==0.13.3" -i "$index" && break; \
    done \
    && command -v uv >/dev/null

COPY server/pyproject.toml server/uv.lock ./
COPY server/scripts/install-python-deps.sh ./scripts/install-python-deps.sh
RUN --mount=type=cache,target=/root/.cache/uv \
    bash scripts/install-python-deps.sh --no-dev --venv /app/.venv

COPY server/alembic.ini ./
COPY server/alembic ./alembic
COPY server/app ./app
COPY server/scripts/entrypoint.sh ./scripts/entrypoint.sh

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gosu libstdc++6 \
        libreoffice-writer libreoffice-calc libreoffice-impress \
        fonts-noto-cjk fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 matrius \
    && mkdir -p /data/files

COPY server/vendor ./vendor

RUN mkdir -p /usr/share/fonts/truetype/noto \
    && cp /app/vendor/fonts/NotoSansSC.ttf /usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf \
    && fc-cache -f \
    && chmod +x /app/scripts/entrypoint.sh /app/vendor/officecli/linux-x64/officecli \
    && chown -R matrius:matrius /app /data

# Linux x64 is the only bundled engine in production; Windows/macOS builds are for local development.
ENV OFFICECLI_PATH=/app/vendor/officecli/linux-x64/officecli \
    LIBREOFFICE_PATH=/usr/bin/libreoffice \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TMPDIR=/tmp

# The entrypoint starts as root to fix volume ownership, then drops to matrius.
EXPOSE 8000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
