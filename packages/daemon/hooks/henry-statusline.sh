#!/bin/sh
# Claude Code statusLine command -> Henry daemon. The daemon answers with a compact line
# ("henry · 5h 42% · 7d 17% · $0.42") which Claude Code displays; when the daemon is down
# this prints nothing and Claude Code shows no status line. Never fails.
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"henrySession":"%s","payload":%s}' "${HENRY_SESSION:-}" "$payload" \
  | curl -s --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${HENRY_PORT:-14711}/statusline" 2>/dev/null
exit 0
