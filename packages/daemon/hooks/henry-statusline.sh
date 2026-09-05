#!/bin/sh
# Claude Code statusLine command -> Henry daemon. The daemon answers with a compact line
# ("henry · 5h 42% · 7d 17% · $0.42") which Claude Code displays; when the daemon is down
# this prints nothing and Claude Code shows no status line. Never fails.
# The running daemon publishes its port in <henry home>/port; a session outlives the daemon,
# so the HENRY_PORT in its environment may name a port the daemon left. File first, env next.
henry_home="${HENRY_HOME:-$HOME/.henry}"
port=""
[ -f "$henry_home/port" ] && read -r port 2>/dev/null < "$henry_home/port"
case "$port" in "" | *[!0-9]*) port="${HENRY_PORT:-14711}" ;; esac
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"henrySession":"%s","payload":%s}' "${HENRY_SESSION:-}" "$payload" \
  | curl -s --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:$port/statusline" 2>/dev/null
exit 0
