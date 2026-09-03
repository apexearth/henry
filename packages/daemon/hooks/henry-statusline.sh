#!/bin/sh
# Claude Code statusLine command -> Henry daemon. Prints nothing; Henry shows usage itself.
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"henrySession":"%s","payload":%s}' "${HENRY_SESSION:-}" "$payload" \
  | curl -s -o /dev/null --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${HENRY_PORT:-4711}/statusline" 2>/dev/null
exit 0
