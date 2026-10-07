# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN useradd --create-home --uid 10001 app

FROM base AS deps
COPY requirements.txt .
RUN pip install -r requirements.txt

# `docker build --target test` -> lint + unit tests; set INTEGRATION=1 to include integration tests
FROM deps AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
CMD ["sh", "-c", "ruff check . && pytest -q"]

FROM deps AS runtime
COPY worker ./worker
USER app
EXPOSE 9100
CMD ["python", "-m", "worker.main"]
