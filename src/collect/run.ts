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
			finish(code === 0 ? {stdout} : {stdout, error: failure(name, stderr, code, signal)});
		});
	});

// failure explains a non-zero exit by the first line of stderr.
function failure(name: string, stderr: string, code: number | null, signal: NodeJS.Signals | null): string {
	const first = stderr.trim().split('\n')[0];
	return `${name}: ${first || (signal ? `killed by ${signal}` : `exit status ${code}`)}`;
}

// Handover runs a command that takes over the terminal until it exits.
export type Handover = (cmd: Cmd) => Promise<RunResult>;

// StreamHandle is the part of stdin's libuv handle that reads the terminal.
// Node sets `reading` before it calls readStart and clears it before readStop.
interface StreamHandle {
	reading?: boolean;
	readStart(): number;
	readStop(): number;
}

// holdStdin stops fleetwatch reading its terminal until the returned release
// runs. Pausing the stream or removing its listeners is not enough: Node reads
// ahead into the stream's buffer and would take keys typed for the command. So
// the current read stops, and a read Node starts meanwhile waits for release.
function holdStdin(): () => void {
	const handle = (process.stdin as unknown as {_handle?: StreamHandle})._handle;
	if (!handle || typeof handle.readStart !== 'function') return () => {};
	let wanted = handle.reading === true;
	if (wanted) handle.readStop();
	handle.readStart = () => {
		wanted = true;
		return 0;
	};
	return () => {
		delete (handle as Partial<StreamHandle>).readStart;
		if (wanted && handle.reading) handle.readStart();
	};
}

// execHandover runs a command on fleetwatch's own terminal: it reads stdin and
// draws on stdout, and its stderr is kept to explain a failure. While it runs,
// fleetwatch neither reads stdin nor handles SIGINT, so every key and Ctrl+C
// goes to the command.
export const execHandover: Handover = (cmd) =>
	new Promise((resolve) => {
		const name = commandName(cmd);
		let stderr = '';
		const ignore = () => {};
		process.on('SIGINT', ignore);
		const releaseStdin = holdStdin();
		let settled = false;
		const finish = (error?: string) => {
			if (settled) return;
			settled = true;
			releaseStdin();
			process.off('SIGINT', ignore);
			resolve(error === undefined ? {stdout: ''} : {stdout: '', error});
		};
		const child = spawn(cmd.name, cmd.args, {cwd: cmd.cwd, env: {...process.env, ...cmd.env}, stdio: ['inherit', 'inherit', 'pipe']});
		child.stderr.setEncoding('utf8').on('data', (s: string) => {
			if (stderr.length < 8192) stderr += s;
		});
		child.on('error', (error: NodeJS.ErrnoException) =>
			finish(error.code === 'ENOENT' ? `${name} is not installed or not on PATH` : `${name}: ${error.message}`),
		);
		child.on('close', (code, signal) => finish(code === 0 ? undefined : failure(name, stderr, code, signal)));
	});
