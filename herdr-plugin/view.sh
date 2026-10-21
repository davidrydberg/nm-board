#!/bin/sh
# Runs nm-watch's run view on the Node that nm-watch runs on, which
# nm-watch passes in NM_WATCH_NODE. herdr starts plugin panes in the
# plugin directory.
exec "${NM_WATCH_NODE:-node}" ../dist/view.js
