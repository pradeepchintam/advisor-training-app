# Python 3.12: required by aws-sdk-bedrock-runtime (Nova Sonic bidirectional
# streaming SDK), which declares Requires-Python >=3.12.
FROM python:3.12-slim

# System deps:
#   libreoffice — converts .pptx → .pdf (used by pptx_service)
#   poppler-utils — pdftoppm backend for pdf2image
#   fonts — fallback fonts so LibreOffice doesn't render boxes
#   curl + ca-certificates — health checks, debug
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    ca-certificates \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p recordings recordings/presentations

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
