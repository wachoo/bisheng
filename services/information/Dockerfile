FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 INFORMATION_DB=/data/information.sqlite3
WORKDIR /service
COPY requirements.txt .
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --timeout 90 --no-cache-dir -r requirements.txt && mkdir /data && chown 65532:65532 /data
COPY app.py scheduler.py store.py feeds.py aihot_page.py richtext.py source_http.py ./
COPY admin/ admin/
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8765
CMD ["uvicorn", "app:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
