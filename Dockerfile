FROM python:3.11-slim

WORKDIR /app

# Install dependencies first so image layers cache well
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ src/
COPY static/ static/
COPY alembic/ alembic/
COPY alembic.ini run.py ./
COPY data/*.md data/*.txt data/*.docx data/eval_dataset.json data/

EXPOSE 8000

# HOST must be 0.0.0.0 inside a container; JWT_SECRET_KEY comes from the
# environment (see docker-compose.yml / your orchestrator's secret store).
ENV HOST=0.0.0.0 PORT=8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)" || exit 1

CMD ["python", "run.py", "--server"]
