#!/bin/sh
# Claude Code hook -> Henry daemon. Never blocks, never fails the tool call.
# Usage in settings.json: "command": "/path/to/henry-hook.sh PreToolUse"
# The running daemon publishes its port in <henry home>/port; a session outlives the daemon,
# so the HENRY_PORT in its environment may name a port the daemon left. File first, env next.
henry_home="${HENRY_HOME:-$HOME/.henry}"
port=""
[ -f "$henry_home/port" ] && read -r port 2>/dev/null < "$henry_home/port"
case "$port" in "" | *[!0-9]*) port="${HENRY_PORT:-14711}" ;; esac
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"henrySession":"%s","henryHookEvent":"%s","payload":%s}' "${HENRY_SESSION:-}" "${1:-}" "$payload" \
  | curl -s -o /dev/null --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:$port/hook" 2>/dev/null
exit 0
