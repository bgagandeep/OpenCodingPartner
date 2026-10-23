#!/bin/sh
# Start the dashboard on this machine. Loopback only: http://127.0.0.1:4317
set -eu
cd "$(dirname "$0")/.."
corepack pnpm install
exec corepack pnpm app
