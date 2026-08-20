FROM python:3.12.11-slim-bookworm

ARG APP_UID=10001
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    H3_RESULT_DIR=/data/results \
    H3_TEMP_DIR=/data/tmp \
    H3_MODEL_DIR=/models

WORKDIR /worker
COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt
COPY app ./app
COPY model-manifest.yaml ./model-manifest.yaml
RUN useradd --create-home --uid ${APP_UID} worker \
    && mkdir -p /data/results /data/tmp /models \
    && chown -R worker:worker /worker /data /models
USER worker
VOLUME ["/data/results", "/models"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"]
STOPSIGNAL SIGTERM
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
