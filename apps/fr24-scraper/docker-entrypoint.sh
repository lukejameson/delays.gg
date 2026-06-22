#!/bin/bash
set -e

# Find and set CHROME_PATH for puppeteer-real-browser
CHROME_BIN=$(find /opt/chrome -name chrome -type f -path "*/chrome-linux64/*" 2>/dev/null | head -1)

if [ -n "$CHROME_BIN" ]; then
    export CHROME_PATH="$CHROME_BIN"
    echo "Found Chrome at: $CHROME_PATH"
else
    echo "Error: Chrome binary not found in /opt/chrome"
    exit 1
fi

# Clean up stale Xvfb lock from previous crashed run
rm -f /tmp/.X99-lock

# Start Xvfb on display :99 before launching the scraper
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

# Verify Xvfb started
if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "Error: Xvfb failed to start"
    exit 1
fi
echo "Xvfb started on display :99 (PID $XVFB_PID)"

# Clean up Xvfb on exit
trap "kill $XVFB_PID 2>/dev/null || true" EXIT

exec node dist/index.js
