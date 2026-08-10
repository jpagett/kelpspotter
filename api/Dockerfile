FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

# Earth Engine calls are I/O-bound waits on Google's servers, so threads beat
# processes here. Cloud Run supplies PORT.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 120 main:app
