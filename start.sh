#!/bin/bash
# Auto-start all services when the repl opens
set -e

echo "[start] launching API server..."
pnpm --filter @workspace/api-server run dev &
API_PID=$!

echo "[start] launching Smart Study frontend..."
pnpm --filter @workspace/smart-study run dev &
WEB_PID=$!

echo "[start] all services started (api=$API_PID, web=$WEB_PID)"

# Keep alive — exit only if a child dies
wait -n 2>/dev/null || wait
