#!/usr/bin/env bash
# FICTIONAL-data test stack. Runs tests/e2e/browser/openemr-frame.mjs; pass the log name, the modes are environment variables (FRAME_WIDTH, UI, ORDERS, DRAFT, VISIT ...).
# Usage: run-frame.sh <log name>   (environment: FRAME_WIDTH, UI, ORDERS, ORDER_REQUEST ...)
S=${OPENEMR_RUN_DIR:?set OPENEMR_RUN_DIR to a work directory for certificates, the client id and logs}
cd "$(git rev-parse --show-toplevel)"
OPENEMR_URL=https://localhost:9300 OPENEMR_USER=admin OPENEMR_PASS='Oe-Test-Pass-2026' APP_ORIGIN=https://127.0.0.1:3082 APP_NAME=StethoLink OPENEMR_PID=1 SHOTS=$S/shots NODE_PATH=/opt/node-tools/node_modules timeout 600 node tests/e2e/browser/openemr-frame.mjs > $S/frame-$1.log 2>&1
echo "exit $?" >> $S/frame-$1.log
