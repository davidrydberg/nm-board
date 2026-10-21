// Runs no-mistakes' own view of one run behind an Esc key that closes it.

import {spawn} from '@lydell/node-pty';

export const ESC = '\x1b';
export const CTRL_C = '\x03';

// mapInput turns a lone Esc into Ctrl+C. no-mistakes leaves its view on
// Ctrl+C in every mode, editors and confirmations included, and leaving the
// view only detaches: the run keeps going. Its own Esc only closes help, diff,
// and editors, so it is given up here. Escape sequences such as arrow keys,
// Alt+key, and terminal answers arrive as one longer chunk and pass through.
export function mapInput(chunk: string): string {
	return chunk === ESC ? CTRL_C : chunk;
}

// attachWithEsc runs `no-mistakes attach --run <id>` on a pseudo-terminal of
// its own, so every key reaches mapInput before no-mistakes reads it. It
// resolves with no-mistakes' exit status.
export function attachWithEsc(cwd: string, runId: string): Promise<number> {
	const {stdin, stdout} = process;
	const child = spawn('no-mistakes', ['attach', '--run', runId], {
		name: process.env['TERM'] || 'xterm-256color',
		cols: stdout.columns || 80,
		rows: stdout.rows || 24,
		cwd: cwd || process.cwd(),
		env: process.env,
	});
	const onKeys = (chunk: string) => child.write(mapInput(chunk));
	const onResize = () => child.resize(stdout.columns, stdout.rows);
	if (stdin.isTTY) stdin.setRawMode(true);
	stdin.setEncoding('utf8').on('data', onKeys);
	stdout.on('resize', onResize);
	child.onData((s) => stdout.write(s));
	return new Promise((resolve) =>
		child.onExit(({exitCode}) => {
			stdin.off('data', onKeys).pause();
			stdout.off('resize', onResize);
			if (stdin.isTTY) stdin.setRawMode(false);
			resolve(exitCode);
		}),
	);
}
