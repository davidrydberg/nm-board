import {parseToon, toonObject, toonString, toonTable} from './toon.js';

export interface Step {
	name: string;
	status: string;
	findings: number;
	durationMs: number;
}

export interface ActiveStep {
	step: string;
	status: string;
	activeFor: string;
	lastActivity: string;
	round: string;
}

export interface Finding {
	id: string;
	severity: string;
	file: string;
	action: string;
	description: string;
}

export interface Gate {
	step: string;
	status: string;
	risk: string;
	findings: Finding[];
}

// Pipeline is one no-mistakes run as `no-mistakes axi status` reports it.
// noRun is set when the command answered but had no run to attribute, such as
// a branch without runs or a detached worktree.
export interface Pipeline {
	runId: string;
	branch: string;
	status: string;
	outcome: string;
	error: string;
	pr: string;
	findings: string;
	awaitingAgent: string;
	head: string;
	steps: Step[];
	active: ActiveStep[];
	gate?: Gate;
	noRun: boolean;
	note: string;
}

function emptyPipeline(): Pipeline {
	return {
		runId: '',
		branch: '',
		status: '',
		outcome: '',
		error: '',
		pr: '',
		findings: '',
		awaitingAgent: '',
		head: '',
		steps: [],
		active: [],
		noRun: false,
		note: '',
	};
}

export function noRun(note: string, branch = ''): Pipeline {
	return {...emptyPipeline(), noRun: true, note, branch};
}

export function parsePipeline(out: string): Pipeline {
	const doc = parseToon(out);
	const run = toonObject(doc, 'run');
	if (!run) {
		if (!('current_branch' in doc)) {
			throw new Error('no-mistakes status: neither a run nor a current branch in output');
		}
		const runs = doc['runs'];
		const count = toonString(doc, 'count');
		let note = '';
		if (typeof runs === 'string') note = runs;
		else if (count) note = `no run attributed to this worktree (${count} runs listed)`;
		return noRun(note, toonString(doc, 'current_branch'));
	}
	const p: Pipeline = {
		...emptyPipeline(),
		runId: toonString(run, 'id'),
		branch: toonString(run, 'branch'),
		status: toonString(run, 'status'),
		pr: toonString(run, 'pr'),
		findings: toonString(run, 'findings'),
		awaitingAgent: toonString(run, 'awaiting_agent'),
		head: toonString(run, 'head'),
		outcome: toonString(doc, 'outcome'),
		error: toonString(doc, 'error'),
	};
	p.steps = toonTable(run, 'steps').map((r) => ({
		name: r['step'] ?? '',
		status: r['status'] ?? '',
		findings: Number.parseInt(r['findings'] ?? '', 10) || 0,
		durationMs: Number.parseInt(r['duration_ms'] ?? '', 10) || 0,
	}));
	p.active = toonTable(run, 'active_steps').map((r) => ({
		step: r['step'] ?? '',
		status: r['status'] ?? '',
		activeFor: r['active_for'] ?? '',
		lastActivity: r['last_activity'] ?? '',
		round: r['round'] ?? '',
	}));
	const g = toonObject(doc, 'gate');
	if (g) {
		p.gate = {
			step: toonString(g, 'step'),
			status: toonString(g, 'status'),
			risk: toonString(g, 'risk'),
			findings: toonTable(g, 'findings').map((r) => ({
				id: r['id'] ?? '',
				severity: r['severity'] ?? '',
				file: r['file'] ?? '',
				action: r['action'] ?? '',
				description: r['description'] ?? '',
			})),
		};
	}
	return p;
}

// stage is a short label for where the run stands, for list rows.
export function stage(p: Pipeline): string {
	if (p.noRun) return 'no run';
	if (p.gate) return `${p.gate.step} gate`;
	if (p.outcome) {
		const failed = p.steps.find((s) => s.status === 'failed');
		if (failed && p.outcome !== 'passed') return `${p.outcome} at ${failed.name}`;
		return p.outcome;
	}
	const active = p.active[0];
	if (active) return `${active.step} ${active.status}`;
	const open = p.steps.find((s) => s.status !== 'completed' && s.status !== 'skipped');
	if (open) return `${open.name} ${open.status}`;
	return p.status;
}

// askUser lists gate findings that wait on a human authority decision.
export function askUser(p: Pipeline): Finding[] {
	return p.gate?.findings.filter((f) => f.action.toLowerCase() === 'ask-user') ?? [];
}
