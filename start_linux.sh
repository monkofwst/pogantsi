#!/usr/bin/env bash
cd "$(dirname "$0")"
(xdg-open http://localhost:8765 >/dev/null 2>&1 || true) &
python3 -m http.server 8765
