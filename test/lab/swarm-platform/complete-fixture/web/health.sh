#!/bin/bash
# A single HTTP readiness request, with no Node startup cost or retry loop.
port="${PORT:-8080}"
case "$port" in ''|*[!0-9]*) exit 1 ;; esac
exec 3<>"/dev/tcp/127.0.0.1/${port}" || exit 1
printf 'GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3 || exit 1
IFS= read -r -t 1 status <&3 || exit 1
# Drain the small response so closing the probe does not reset the server socket.
while IFS= read -r -t 1 line <&3; do :; done
case "$status" in 'HTTP/1.1 200 '*|'HTTP/1.0 200 '*) exit 0 ;; *) exit 1 ;; esac
