FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    PORT=8720

WORKDIR /app

COPY requirements.txt requirements-provider.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip install --no-cache-dir --upgrade -r requirements-provider.txt \
    && python -m pip install --no-cache-dir --upgrade --no-deps msgpack==1.2.1 \
    && python -c "from importlib.metadata import version; from signalrcore.hub_connection_builder import HubConnectionBuilder; assert version('fiinquantx') == '0.1.67'; assert version('signalrcore') == '1.0.2'; assert version('msgpack') == '1.2.1'" \
    && adduser --disabled-password --gecos "" --uid 10001 app

COPY --chown=app:app fiinquant_sidecar.py ./

USER app

EXPOSE 8720

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8720/health', timeout=2)" || exit 1

CMD ["python", "fiinquant_sidecar.py"]
