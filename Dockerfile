# Verea API (backend/ + core/) for Fly.io. The data (DEM, 4G coverage cache, relief grid) lives
# on a volume mounted at /data: see scripts/server_data.py, which fills it once.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt

COPY config.py ./
COPY core/ core/
COPY utils/ utils/
COPY backend/ backend/
COPY scripts/server_data.py scripts/get_coverage.py scripts/prebuild_coverage_cache.py scripts/dem_tiles.txt scripts/
# The code reads ./data: point it at the volume (mounted as root, so the app runs as root:
# the Fly machine is its own VM)
RUN ln -s /data /app/data

EXPOSE 8080
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
