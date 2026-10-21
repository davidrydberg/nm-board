// view.js shows one no-mistakes run for fleetwatch. The fleetwatch herdr
// plugin runs it in a popup, and demo mode also runs it full screen. It reads
// its run from FLEETWATCH_RUN and FLEETWATCH_CWD; FLEETWATCH_DEMO swaps
// no-mistakes for a synthetic stand-in.

import {render} from 'ink';

import {DEMO_TASKS, demoRunId} from './demo/fleet.js';
import {DemoView} from './demo/view.js';

const env = process.env;
const runId = env['FLEETWATCH_RUN'] ?? '';

// waitForKey keeps a failure on screen, since a popup closes as soon as its
// program exits.
function waitForKey(msg: string): Promise<void> {
	process.stdout.write(`\r\n${msg}\r\n\r\npress any key to close\r\n`);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	return new Promise((resolve) => process.stdin.resume().once('data', () => resolve()));
}

let status = 0;
if (env['FLEETWATCH_DEMO'] === '1') {
	const index = DEMO_TASKS.findIndex((_, i) => demoRunId(i) === runId);
	if (index < 0) {
		await waitForKey(`fleetwatch: no demo run ${runId}`);
		status = 1;
	} else {
		await render(<DemoView index={index} start={Date.now()} />, {alternateScreen: true}).waitUntilExit();
	}
} else if (!runId) {
	await waitForKey('fleetwatch: no run to show (FLEETWATCH_RUN is empty)');
	status = 2;
} else {
	try {
		// The pty binding loads only here, so demo mode never needs it.
		const {attachWithEsc} = await import('./view/attach.js');
		status = await attachWithEsc(env['FLEETWATCH_CWD'] ?? '', runId);
		if (status !== 0) await waitForKey(`no-mistakes exited with status ${status}; if it printed nothing above, it may not be on the PATH herdr runs plugins with`);
	} catch (error) {
		await waitForKey(`fleetwatch: could not open the run: ${(error as Error).message}`);
		status = 1;
	}
}
process.exit(status);
