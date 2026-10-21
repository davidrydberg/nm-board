// The built-in synthetic fleet `nm-watch --demo` shows: made-up projects,
// tasks, runs, steps, and findings, so the board runs with no firstmate home
// and never reads or starts a no-mistakes daemon.

import type {Fleet, Source} from '../collect/collect.js';
import {openPopup, VIEW_SCRIPT, viewEnv} from '../collect/herdr.js';
import {execHandover, type Handover} from '../collect/run.js';
import {buildRoster, type Agent, type Detail} from '../fleet/agent.js';
import {BEARINGS_SCHEMA, MAIN_OWNER, type Bearings} from '../fleet/bearings.js';
import {emptyPipeline, noRun, PIPELINE_STEPS, type Finding, type Pipeline} from '../fleet/pipeline.js';
import {parseMeta} from '../fleet/task.js';
import {age} from '../tui/render.js';

export const DEMO_HOME = '/demo';

// DemoTask is one synthetic task. at is the step its run stands at and that
// step's status; a run without a step has no run yet, and a run past the last
// step passed. minutes is how long the run has been at its step.
export interface DemoTask {
	id: string;
	repo: string;
	name: string;
	state: string;
	doing: string;
	step?: string;
	status?: string;
	minutes: number;
	findings?: Finding[];
	hold?: string;
}

export const DEMO_TASKS: DemoTask[] = [
	{
		id: 'checkout-retry',
		repo: 'billing-api',
		name: 'Retry failed card payments with backoff',
		state: 'parked',
		doing: 'parked at review: 2 finding(s) · ask-user: authority decision',
		step: 'review',
		status: 'awaiting_approval',
		minutes: 14,
		findings: [
			{
				id: 'retry-window-unbounded',
				severity: 'warning',
				file: 'src/payments/retry.ts',
				action: 'ask-user',
				description: 'Retries keep going until the card network gives up, which can be days. Should a failed payment stop after 24 hours?',
			},
			{
				id: 'retry-email-copy',
				severity: 'info',
				file: 'src/emails/payment-failed.ts',
				action: 'ask-user',
				description: 'The customer email now says "we will try again tomorrow". Is that a promise support wants to make?',
			},
		],
		hold: 'Payment retries: how long to keep retrying a failed card',
	},
	{
		id: 'dark-mode',
		repo: 'storefront',
		name: 'Dark mode for the storefront',
		state: 'working',
		doing: 'validating (fixing)',
		step: 'review',
		status: 'fixing',
		minutes: 3,
	},
	{
		id: 'search-typos',
		repo: 'search-service',
		name: 'Typo-tolerant product search',
		state: 'working',
		doing: 'validating (running)',
		step: 'test',
		status: 'running',
		minutes: 6,
	},
	{
		id: 'rate-limit-flags',
		repo: 'cli',
		name: 'Flags to set per-command rate limits',
		state: 'failed',
		doing: 'run failed at test',
		step: 'test',
		status: 'failed',
		minutes: 0,
	},
	{
		id: 'offline-cart',
		repo: 'mobile-app',
		name: 'Keep the cart when the app goes offline',
		state: 'working',
		doing: 'validating (running)',
		step: 'document',
		status: 'running',
		minutes: 1,
	},
	{
		id: 'image-cdn',
		repo: 'storefront',
		name: 'Serve product images from the CDN',
		state: 'working',
		doing: 'validating (running)',
		step: 'pr',
		status: 'running',
		minutes: 2,
	},
	{
		id: 'docs-quickstart',
		repo: 'docs-site',
		name: 'Rewrite the quickstart',
		state: 'working',
		doing: 'checks running on the PR',
		step: 'ci',
		status: 'running',
		minutes: 18,
	},
	{
		id: 'invoice-pdf',
		repo: 'billing-api',
		name: 'Invoices as PDF attachments',
		state: 'done',
		doing: 'checks green: PR ready for review',
		step: 'done',
		status: 'passed',
		minutes: 0,
	},
	{
		id: 'color-output',
		repo: 'cli',
		name: 'Respect NO_COLOR in every command',
		state: 'working',
		doing: 'implementing',
		minutes: 0,
	},
];

// demoRunId is a task's synthetic run id, in the shape of a real one.
export const demoRunId = (i: number) => `01JZDEMQ7R${String(i + 1).padStart(16, '0')}`;

export function demoBearings(): Bearings {
	return {
		schema: BEARINGS_SCHEMA,
		home: 'demo fleet',
		generated: '',
		inFlight: DEMO_TASKS.map((t) => ({id: t.id, kind: 'ship', state: t.state, repo: t.repo, name: t.name, doing: t.doing})),
		secondmates: [],
		reconcile: [],
		decisions: DEMO_TASKS.filter((t) => t.hold).map((t) => ({id: t.id, key: t.id, verb: 'captain-hold', summary: t.hold!, owner: MAIN_OWNER})),
	};
}

// demoPipeline is a task's run as `no-mistakes axi status` would report it,
// with times counted from start.
export function demoPipeline(i: number, start: number, now: number): Pipeline {
	const t = DEMO_TASKS[i]!;
	const branch = `fm/${t.id}`;
	if (!t.step) return noRun('no run on this branch yet', branch);
	const at = t.step === 'done' ? PIPELINE_STEPS.length : PIPELINE_STEPS.indexOf(t.step);
	const spent = age(now - start + t.minutes * 60_000);
	const p: Pipeline = {
		...emptyPipeline(),
		runId: demoRunId(i),
		branch,
		status: t.status === 'passed' ? 'completed' : t.status === 'failed' ? 'failed' : 'running',
		outcome: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : '',
		head: (0x5e1d0000 + i * 0x1111).toString(16),
		findings: t.findings ? `${t.findings.length} awaiting` : 'none',
		steps: PIPELINE_STEPS.map((name, k) => ({
			name,
			status: k < at ? 'completed' : k === at ? t.status! : 'pending',
			findings: k === at ? (t.findings?.length ?? 0) : 0,
			durationMs: k < at ? 2_000 + ((i * 7 + k * 13) % 90) * 1_000 : 0,
		})),
	};
	if (t.status === 'awaiting_approval' || t.status === 'fix_review') {
		p.awaitingAgent = `parked ${spent}`;
		p.gate = {step: t.step, status: t.status, risk: 'medium', findings: t.findings ?? []};
	} else if (t.status === 'running' || t.status === 'fixing') {
		p.active = [{step: t.step, status: t.status, activeFor: spent, lastActivity: 'agent producing output', round: '1'}];
	}
	return p;
}

export function demoDetail(id: string, start: number, now: number): Detail {
	const i = DEMO_TASKS.findIndex((t) => t.id === id);
	const d: Detail = {status: [], fetchedAt: now};
	if (i < 0) return d;
	const t = DEMO_TASKS[i]!;
	d.meta = {...parseMeta(''), kind: 'ship', mode: 'no-mistakes', branch: `fm/${t.id}`};
	d.pipeline = demoPipeline(i, start, now);
	d.crew = {state: t.state, source: 'demo', detail: t.doing, runId: d.pipeline.runId};
	return d;
}

// DemoSource serves the synthetic fleet. Opening a run shows a synthetic
// stand-in for no-mistakes' view, in a herdr popup or full screen.
export class DemoSource implements Source {
	private readonly start: number;

	constructor(
		private readonly herdrSocket?: string,
		private readonly handover: Handover = execHandover,
		private readonly now: () => number = Date.now,
	) {
		this.start = now();
	}

	async fleet(): Promise<Fleet> {
		const b = demoBearings();
		return {bearings: b, agents: buildRoster(b, DEMO_HOME, new Map())};
	}

	async task(a: Agent): Promise<Detail> {
		return demoDetail(a.id, this.start, this.now());
	}

	async popup(_a: Agent, _worktree: string, runId: string): Promise<boolean> {
		if (!this.herdrSocket) return false;
		await openPopup(this.herdrSocket, {runId, cwd: '', demo: true});
		return true;
	}

	async attach(_a: Agent, _worktree: string, runId: string): Promise<void> {
		const r = await this.handover({name: process.execPath, args: [VIEW_SCRIPT], env: viewEnv({runId, cwd: '', demo: true})});
		if (r.error) throw new Error(r.error);
	}
}
