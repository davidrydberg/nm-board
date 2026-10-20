#!/usr/bin/env node
// fleetwatch is a live terminal view of firstmate's agents.

import {statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {render} from 'ink';

import {FleetSource} from './collect/collect.js';
import {execRunner} from './collect/run.js';
import {App} from './tui/app.js';
import {Model} from './tui/model.js';

const usage = `usage: fleetwatch [--home <dir>] [--interval <s>] [--fleet-interval <s>] [--pr-interval <s>] [--concurrency <n>]

  --home            firstmate home to watch (default $FM_HOME; one of the two is required)
  --interval        seconds between reads of each live agent's local state (default 5)
  --fleet-interval  seconds between bearings snapshot reads (default 15)
  --pr-interval     seconds between GitHub reads of open PRs and checks (default 90)
  --concurrency     local commands run at once (default 4)
  -h, --help        show this help`;

function fail(msg: string): never {
	process.stderr.write(`fleetwatch: ${msg}\n`);
	process.exit(2);
}

function positive(name: string, value: string, fallback: number): number {
	if (value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got ${JSON.stringify(value)}`);
	return n;
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
			interval: {type: 'string', default: ''},
			'fleet-interval': {type: 'string', default: ''},
			'pr-interval': {type: 'string', default: ''},
			concurrency: {type: 'string', default: ''},
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

const intervalMs = positive('interval', args.interval, 5) * 1000;
const source = new FleetSource(
	{
		home,
		cacheDir: path.join(userCacheDir(), 'fleetwatch', 'secondmate-summary-cache'),
		fleetTimeoutMs: 60_000,
		taskTimeoutMs: 15_000,
		prTimeoutMs: 20_000,
		focusTimeoutMs: 5_000,
		concurrency: Math.floor(positive('concurrency', args.concurrency, 4)),
		prConcurrency: 2,
	},
	execRunner,
);
const model = new Model({
	intervalMs,
	inactiveIntervalMs: 6 * intervalMs,
	fleetIntervalMs: positive('fleet-interval', args['fleet-interval'], 15) * 1000,
	prIntervalMs: positive('pr-interval', args['pr-interval'], 90) * 1000,
});

const app = render(<App model={model} source={source} />, {alternateScreen: true});
await app.waitUntilExit();
process.exit(0);
