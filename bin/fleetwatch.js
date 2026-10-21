#!/usr/bin/env node
// Runs the fleetwatch binary from the platform package npm installed beside
// this one as an optional dependency.

const {spawnSync} = require('node:child_process');

const pkg = `fleetwatch-${process.platform}-${process.arch}`;
let binary;
try {
	binary = require.resolve(`${pkg}/bin/fleetwatch`);
} catch {
	process.stderr.write(`fleetwatch: no prebuilt binary for ${process.platform}-${process.arch} (${pkg} is not installed)\n`);
	process.exit(1);
}

const r = spawnSync(binary, process.argv.slice(2), {stdio: 'inherit'});
if (r.error) {
	process.stderr.write(`fleetwatch: ${r.error.message}\n`);
	process.exit(1);
}
process.exit(r.status ?? 1);
