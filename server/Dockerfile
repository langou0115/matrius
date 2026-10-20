FROM python:3.12-slim

ARG PYPI_INDEX_CANDIDATES="https://pypi.org/simple,https://pypi.tuna.tsinghua.edu.cn/simple"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app

COPY scripts/select-index.py ./scripts/select-index.py
RUN for index in $(python3 scripts/select-index.py); do \
      pip install --no-cache-dir "uv==0.13.3" -i "$index" && break; \
    done \
    && command -v uv >/dev/null

COPY pyproject.toml uv.lock ./
COPY scripts/install-python-deps.sh ./scripts/install-python-deps.sh
RUN --mount=type=cache,target=/root/.cache/uv \
    bash scripts/install-python-deps.sh --no-dev --venv /app/.venv

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

RUN useradd --create-home --uid 10001 matrius \
    && chown -R matrius:matrius /app

USER matrius

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
