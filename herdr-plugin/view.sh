#!/bin/sh
# Runs fleetwatch's run view on the Node that fleetwatch runs on, which
# fleetwatch passes in FLEETWATCH_NODE. herdr starts plugin panes in the
# plugin directory.
exec "${FLEETWATCH_NODE:-node}" ../dist/view.js
