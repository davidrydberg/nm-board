// view.js shows one no-mistakes run for nm-watch. The nm-watch herdr
// plugin runs it in a popup, and demo mode also runs it full screen. It reads
// its run from NM_WATCH_RUN and NM_WATCH_CWD; NM_WATCH_DEMO swaps
// no-mistakes for a synthetic stand-in.

import {render} from 'ink';

import {DEMO_TASKS, demoRunId} from './demo/fleet.js';
import {DemoView} from './demo/view.js';

const env = process.env;
const runId = env['NM_WATCH_RUN'] ?? '';

// waitForKey keeps a failure on screen, since a popup closes as soon as its
// program exits.
function waitForKey(msg: string): Promise<void> {
	process.stdout.write(`\r\n${msg}\r\n\r\npress any key to close\r\n`);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	return new Promise((resolve) => process.stdin.resume().once('data', () => resolve()));
}

let status = 0;
if (env['NM_WATCH_DEMO'] === '1') {
	const index = DEMO_TASKS.findIndex((_, i) => demoRunId(i) === runId);
	if (index < 0) {
		await waitForKey(`nm-watch: no demo run ${runId}`);
		status = 1;
	} else {
		await render(<DemoView index={index} start={Date.now()} />, {alternateScreen: true}).waitUntilExit();
	}
} else if (!runId) {
	await waitForKey('nm-watch: no run to show (NM_WATCH_RUN is empty)');
	status = 2;
} else {
	try {
		// The pty binding loads only here, so demo mode never needs it.
		const {attachWithEsc} = await import('./view/attach.js');
		status = await attachWithEsc(env['NM_WATCH_CWD'] ?? '', runId);
		if (status !== 0) await waitForKey(`no-mistakes exited with status ${status}; if it printed nothing above, it may not be on the PATH herdr runs plugins with`);
	} catch (error) {
		await waitForKey(`nm-watch: could not open the run: ${(error as Error).message}`);
		status = 1;
	}
}
process.exit(status);
