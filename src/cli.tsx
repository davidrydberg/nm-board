#!/usr/bin/env node
// fleetwatch is a live terminal board of firstmate's no-mistakes runs.

import {statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {render} from 'ink';

import {FleetSource} from './collect/collect.js';
import {execHandover, execRunner} from './collect/run.js';
import {App} from './tui/app.js';
import {Model} from './tui/model.js';

const usage = `usage: fleetwatch [--home <dir>]

  --home      firstmate home to watch (default $FM_HOME; one of the two is required)
  -h, --help  show this help`;

const INTERVAL_MS = 5_000;

function fail(msg: string): never {
	process.stderr.write(`fleetwatch: ${msg}\n`);
	process.exit(2);
}

// userCacheDir follows each platform's convention for per-user caches.
function userCacheDir(): string {
	if (process.env['XDG_CACHE_HOME']) return process.env['XDG_CACHE_HOME'];
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
	return path.join(os.homedir(), '.cache');
}

let args;
try {
	args = parseArgs({
		options: {
			home: {type: 'string', default: process.env['FM_HOME'] ?? ''},
			help: {type: 'boolean', short: 'h', default: false},
		},
	}).values;
} catch (error) {
	fail(`${(error as Error).message}\n\n${usage}`);
}
if (args.help) {
	process.stdout.write(`${usage}\n`);
	process.exit(0);
}

if (!args.home) fail(`no firstmate home: pass --home <dir> or set FM_HOME\n\n${usage}`);
const home = path.resolve(args.home);
try {
	if (!statSync(path.join(home, 'bin', 'fm-bearings-snapshot.sh')).isFile()) throw new Error('not a file');
} catch {
	fail(`${home} does not look like a firstmate home (no bin/fm-bearings-snapshot.sh); pass --home or set FM_HOME`);
}

const source = new FleetSource(
	{
		home,
		cacheDir: path.join(userCacheDir(), 'fleetwatch', 'secondmate-summary-cache'),
		fleetTimeoutMs: 60_000,
		taskTimeoutMs: 15_000,
		concurrency: 4,
	},
	execRunner,
	execHandover,
);
const model = new Model({
	intervalMs: INTERVAL_MS,
	inactiveIntervalMs: 6 * INTERVAL_MS,
	fleetIntervalMs: 15_000,
});

const app = render(<App model={model} source={source} />, {alternateScreen: true});
await app.waitUntilExit();
process.exit(0);
