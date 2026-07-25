#!/bin/bash
# Start all Sage services.
# Safe to run at any time — kills any existing process on the ports first.

echo "[start] stopping any existing services on ports 5000 and 8080..."
fuser -k 5000/tcp 2>/dev/null || true
fuser -k 8080/tcp 2>/dev/null || true
sleep 0.5

echo "[start] launching API server (port 8080)..."
pnpm --filter @workspace/api-server run dev &
API_PID=$!

echo "[start] launching Smart Study frontend (port 5000)..."
pnpm --filter @workspace/smart-study run dev &
WEB_PID=$!

echo "[start] services started (api=$API_PID web=$WEB_PID) — waiting..."

# Exit if either child exits (causes a clean restart via Run button or supervisor)
wait -n 2>/dev/null || true
echo "[start] a service exited — shutting down the other..."
kill $API_PID $WEB_PID 2>/dev/null || true
wait 2>/dev/null || true
echo "[start] done."
