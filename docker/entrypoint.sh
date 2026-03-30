#!/usr/bin/env bash
set -euo pipefail
umask 077

mkdir -p /data/capture
cd /data

case "${1:-dashboard}" in
  dashboard)
    shift || true
    exec node /app/src/dashboard-server.js "$@"
    ;;
  receiver)
    shift || true
    exec node /app/src/otp-receiver.js "$@"
    ;;
  capture-login)
    shift || true
    exec node /app/src/capture-login.js "$@"
    ;;
  login|fetch|extract)
    exec node /app/src/gettransfer.js "$@"
    ;;
  shell)
    shift || true
    exec bash "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
