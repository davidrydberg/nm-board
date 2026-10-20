import {spawn} from 'node:child_process';

// Cmd is one external command fleetwatch runs. env is added to the inherited
// environment.
export interface Cmd {
	name: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

// RunResult carries stdout even alongside an error, so callers can still
// parse output from a command that exited non-zero.
export interface RunResult {
	stdout: string;
	error?: string;
}

// Runner runs a command to completion or until timeoutMs passes.
export type Runner = (cmd: Cmd, timeoutMs: number) => Promise<RunResult>;

const commandName = (cmd: Cmd) => cmd.name.split('/').at(-1) ?? cmd.name;

// execRunner runs commands as child processes in their own process group. On
// timeout it kills the whole group, so a script's own children cannot outlive
// the bound or hold its output open.
export const execRunner: Runner = (cmd, timeoutMs) =>
	new Promise((resolve) => {
		const name = commandName(cmd);
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		const finish = (r: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		const child = spawn(cmd.name, cmd.args, {
			cwd: cmd.cwd,
			env: {...process.env, ...cmd.env},
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		const kill = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
			} catch {
				// The group already exited.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
			// Resolve even if a stray descendant keeps the pipes open.
			finish({stdout, error: `${name}: timed out`});
		}, timeoutMs);
		child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s));
		child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s));
		child.on('error', (error) => finish({stdout, error: `${name}: ${error.message}`}));
		child.on('close', (code, signal) => {
			if (timedOut) return;
			if (code === 0) {
				finish({stdout});
				return;
			}
			const first = stderr.trim().split('\n')[0];
			const why = first || (signal ? `killed by ${signal}` : `exit status ${code}`);
			finish({stdout, error: `${name}: ${why}`});
		});
	});
