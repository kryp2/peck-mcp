# openrun.peck.to — FastHTML case-study site
# Build from the peck-to/ workspace root so peck-ui is reachable:
#   docker build -f peck-mcp/openrun/Dockerfile -t openrun .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

# peck-ui is a local package; COPY before pip install so editable works.
COPY peck-ui /deps/peck-ui
COPY peck-mcp/openrun /app

RUN pip install --upgrade pip \
 && pip install /deps/peck-ui \
 && pip install -r requirements.txt

EXPOSE 8080
CMD ["python", "app.py"]
