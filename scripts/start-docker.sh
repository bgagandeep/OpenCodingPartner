#!/bin/sh
# Build and start the dashboard in Docker. The published port is 127.0.0.1:4317.
set -eu
cd "$(dirname "$0")/.."
docker compose up -d --build ocp
echo "Open Coding Partner is at http://127.0.0.1:4317"
echo "Optional model server beside it: docker compose --profile ollama up -d"
