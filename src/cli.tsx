#!/usr/bin/env node
// nm-watch is a live terminal board of firstmate's no-mistakes runs.

import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {render} from 'ink';

import {FleetSource, type Source} from './collect/collect.js';
import {herdrSocket, PLUGIN_DIR, PLUGIN_ID} from './collect/herdr.js';
import {execHandover, execRunner} from './collect/run.js';
import {DemoSource} from './demo/fleet.js';
import {App} from './tui/app.js';
import {Model} from './tui/model.js';

const usage = `usage: nm-watch [--home <dir>]
       nm-watch --demo
       nm-watch herdr-setup

  --home       firstmate home to watch (default $FM_HOME; one of the two is required)
  --demo       watch a built-in synthetic fleet instead of a firstmate home
  herdr-setup  link nm-watch's herdr plugin, so runs open in a herdr popup
  -h, --help   show this help`;

const INTERVAL_MS = 5_000;

function fail(msg: string): never {
	process.stderr.write(`nm-watch: ${msg}\n`);
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
			demo: {type: 'boolean', default: false},
			help: {type: 'boolean', short: 'h', default: false},
		},
		allowPositionals: true,
	});
} catch (error) {
	fail(`${(error as Error).message}\n\n${usage}`);
}
if (args.values.help) {
	process.stdout.write(`${usage}\n`);
	process.exit(0);
}

const [command, ...extra] = args.positionals;
if (command === 'herdr-setup' && extra.length === 0) herdrSetup();
if (command !== undefined) fail(`unknown command: ${args.positionals.join(' ')}\n\n${usage}`);

// herdrSetup links the plugin that lets nm-watch open runs in a herdr
// popup. Linking only registers the plugin directory with herdr; it changes
// no herdr config and adds no keybindings.
function herdrSetup(): never {
	process.stdout.write(`Linking the nm-watch herdr plugin from ${PLUGIN_DIR}\n`);
	const r = spawnSync('herdr', ['plugin', 'link', PLUGIN_DIR], {stdio: 'inherit'});
	if (r.error) fail((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'herdr is not installed or not on PATH' : `herdr: ${r.error.message}`);
	if (r.status !== 0) fail(`herdr plugin link failed; if an older nm-watch plugin is linked, run \`herdr plugin unlink ${PLUGIN_ID}\` first`);
	process.stdout.write(`Done. Inside herdr, Enter now opens a run in a popup. Undo with \`herdr plugin unlink ${PLUGIN_ID}\`.\n`);
	process.exit(0);
}

// Inside herdr, runs open in a popup through nm-watch's herdr plugin.
const socket = herdrSocket(process.env);
let source: Source;
if (args.values.demo) {
	source = new DemoSource(socket);
} else {
	if (!args.values.home) fail(`no firstmate home: pass --home <dir> or set FM_HOME\n\n${usage}`);
	const home = path.resolve(args.values.home);
	try {
		if (!statSync(path.join(home, 'bin', 'fm-bearings-snapshot.sh')).isFile()) throw new Error('not a file');
	} catch {
		fail(`${home} does not look like a firstmate home (no bin/fm-bearings-snapshot.sh); pass --home or set FM_HOME`);
	}
	source = new FleetSource(
		{
			home,
			cacheDir: path.join(userCacheDir(), 'nm-watch', 'secondmate-summary-cache'),
			fleetTimeoutMs: 60_000,
			taskTimeoutMs: 15_000,
			concurrency: 4,
			herdrSocket: socket,
		},
		execRunner,
		execHandover,
	);
}
const model = new Model({
	intervalMs: INTERVAL_MS,
	inactiveIntervalMs: 6 * INTERVAL_MS,
	fleetIntervalMs: 15_000,
	popup: socket !== undefined,
});

const app = render(<App model={model} source={source} />, {alternateScreen: true});
await app.waitUntilExit();
process.exit(0);
