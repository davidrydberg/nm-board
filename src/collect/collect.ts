// Reads fleet state from a firstmate home and no-mistakes.
// Every read is bounded by a timeout; nothing here writes to firstmate state.

import {mkdir, open, readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {buildRoster, type Agent, type Detail} from '../fleet/agent.js';
import {parseBearings, type Bearings} from '../fleet/bearings.js';
import {noRun, parsePipeline, type Pipeline} from '../fleet/pipeline.js';
import {parseCrewState, parseMeta, parseStatusLog, type Meta} from '../fleet/task.js';
import {openPopup} from './herdr.js';
import {execHandover, type Cmd, type Handover, type Runner} from './run.js';

export interface Config {
	home: string;
	// cacheDir receives the bearings snapshot's parent-side remote summary
	// cache, so refreshing never writes into the firstmate home's state/.
	cacheDir: string;
	fleetTimeoutMs: number;
	taskTimeoutMs: number;
	concurrency: number; // concurrent local commands
	// herdrSocket is the API socket of the herdr server fleetwatch runs in;
	// with it, runs open in a herdr popup.
	herdrSocket?: string;
}

// Fleet is one bearings read and the agents it yields.
export interface Fleet {
	bearings: Bearings;
	agents: Agent[];
}

// Source is everything the view reads; the model calls it only through
// effects, never while rendering.
export interface Source {
	fleet(): Promise<Fleet>;
	task(a: Agent): Promise<Detail>;
	// popup opens no-mistakes' own view of one run in a herdr popup over the
	// board. It resolves false when fleetwatch does not run inside herdr.
	popup(a: Agent, worktree: string, runId: string): Promise<boolean>;
	// attach hands the terminal to no-mistakes' own view of one run until the
	// captain leaves it.
	attach(a: Agent, worktree: string, runId: string): Promise<void>;
}

// Limiter runs at most n tasks at once.
class Limiter {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	constructor(private readonly n: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

// bearingsCmd is the snapshot command. Decisions are uncapped so a captain
// decision is never dropped from the view by the default display bound.
export function bearingsCmd(cfg: Pick<Config, 'home' | 'cacheDir'>): Cmd {
	const env: Record<string, string> = {FM_HOME: cfg.home, FM_BEARINGS_DECISIONS: '1000'};
	if (cfg.cacheDir) env['FM_SNAPSHOT_CACHE_DIR'] = cfg.cacheDir;
	return {
		name: path.join(cfg.home, 'bin', 'fm-bearings-snapshot.sh'),
		args: ['--json', '--all-in-flight'],
		cwd: cfg.home,
		env,
	};
}

// attachCmd opens no-mistakes' own view of one run.
export function attachCmd(cwd: string, runId: string): Cmd {
	return {name: 'no-mistakes', args: ['attach', '--run', runId], cwd};
}

export class FleetSource implements Source {
	private readonly local: Limiter;

	constructor(
		private readonly cfg: Config,
		private readonly run: Runner,
		private readonly handover: Handover = execHandover,
		private readonly now: () => number = Date.now,
	) {
		this.local = new Limiter(Math.max(cfg.concurrency, 1));
	}

	async fleet(): Promise<Fleet> {
		if (this.cfg.cacheDir) await mkdir(path.dirname(this.cfg.cacheDir), {recursive: true, mode: 0o700});
		const r = await this.run(bearingsCmd(this.cfg), this.cfg.fleetTimeoutMs);
		let bearings: Bearings;
		try {
			bearings = parseBearings(r.stdout);
		} catch (error) {
			throw new Error(r.error ?? (error as Error).message);
		}
		const smMeta = new Map<string, Meta>();
		const owners = new Set(bearings.secondmates.map((s) => s.id));
		for (const f of bearings.inFlight) {
			const slash = f.id.indexOf('/');
			if (slash >= 0) owners.add(f.id.slice(0, slash));
		}
		for (const id of owners) {
			const text = await readOptional(path.join(this.cfg.home, 'state', `${id}.meta`));
			if (text !== undefined) smMeta.set(id, parseMeta(text));
		}
		return {bearings, agents: buildRoster(bearings, this.cfg.home, smMeta)};
	}

	// task reads one agent's meta, status log, crew state, and no-mistakes
	// run.
	async task(a: Agent): Promise<Detail> {
		const d: Detail = {status: [], fetchedAt: this.now()};
		if (a.absent || !a.home) return d;
		const state = path.join(a.home, 'state');
		try {
			d.meta = parseMeta(await readFile(path.join(state, `${a.taskId}.meta`), 'utf8'));
		} catch (error) {
			d.metaError = (error as Error).message;
		}
		try {
			d.status = parseStatusLog(await readTail(path.join(state, `${a.taskId}.status`), 64 * 1024));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') d.statusError = (error as Error).message;
		}
		if (d.meta?.remoteHost) return d;

		const crew = await this.local.run(() =>
			this.run(
				{name: path.join(a.home, 'bin', 'fm-crew-state.sh'), args: [a.taskId], cwd: a.home, env: {FM_HOME: a.home}},
				this.cfg.taskTimeoutMs,
			),
		);
		try {
			d.crew = parseCrewState(crew.stdout);
		} catch (error) {
			d.crewError = crew.error ?? (error as Error).message;
		}

		const runId = d.crew?.runId ?? '';
		if (!runId && d.meta?.mode !== 'no-mistakes') return d;
		try {
			d.pipeline = await this.pipeline(a, d.meta, runId);
		} catch (error) {
			d.pipelineError = (error as Error).message;
		}
		return d;
	}

	private async pipeline(a: Agent, meta: Meta | undefined, runId: string): Promise<Pipeline> {
		let cwd = a.home;
		if (meta && (await isDir(meta.worktree))) cwd = meta.worktree;
		else if (!runId) return noRun('worktree gone');
		const args = ['axi', 'status', ...(runId ? ['--run', runId] : [])];
		const r = await this.local.run(() => this.run({name: 'no-mistakes', args, cwd}, this.cfg.taskTimeoutMs));
		let p: Pipeline;
		try {
			p = parsePipeline(r.stdout);
		} catch (error) {
			throw new Error(r.error ?? (error as Error).message);
		}
		// Without a run id from crew-state, the worktree's latest run counts only
		// when it is on the task's own branch.
		if (!runId && !p.noRun && meta?.branch && p.branch !== meta.branch) {
			return noRun(`latest run is on ${p.branch}, not this task's branch`, meta.branch);
		}
		return p;
	}

	// popup and attach run no-mistakes in the task's worktree, or in its home
	// once the worktree is gone, like the pipeline read.
	async popup(a: Agent, worktree: string, runId: string): Promise<boolean> {
		if (!this.cfg.herdrSocket) return false;
		await openPopup(this.cfg.herdrSocket, {runId, cwd: await viewDir(a, worktree)});
		return true;
	}

	async attach(a: Agent, worktree: string, runId: string): Promise<void> {
		const r = await this.handover(attachCmd(await viewDir(a, worktree), runId));
		if (r.error) throw new Error(r.error);
	}
}

const viewDir = async (a: Agent, worktree: string) => ((await isDir(worktree)) ? worktree : a.home);

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

// readTail returns at most limit trailing bytes of a file, starting at a
// whole line.
export async function readTail(file: string, limit: number): Promise<string> {
	const fh = await open(file, 'r');
	try {
		const info = await fh.stat();
		const offset = Math.max(info.size - limit, 0);
		const buf = Buffer.alloc(info.size - offset);
		await fh.read(buf, 0, buf.length, offset);
		let text = buf.toString('utf8');
		if (offset > 0) {
			const nl = text.indexOf('\n');
			text = nl >= 0 ? text.slice(nl + 1) : '';
		}
		return text;
	} finally {
		await fh.close();
	}
}

async function isDir(p: string): Promise<boolean> {
	if (!p) return false;
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}
