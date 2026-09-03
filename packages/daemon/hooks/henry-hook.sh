#!/bin/sh
# Claude Code hook -> Henry daemon. Never blocks, never fails the tool call.
# Usage in settings.json: "command": "/path/to/henry-hook.sh PreToolUse"
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"henrySession":"%s","henryHookEvent":"%s","payload":%s}' "${HENRY_SESSION:-}" "${1:-}" "$payload" \
  | curl -s -o /dev/null --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${HENRY_PORT:-4711}/hook" 2>/dev/null
exit 0
