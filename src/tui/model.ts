// The fleetwatch view state and its update logic. The model never runs a
// command: dispatch returns effects, the app runs them through a Source, and
// their results come back as events. That keeps every read in the background
// and the update logic testable without a terminal.

import type {Fleet} from '../collect/collect.js';
import type {Agent, Detail} from '../fleet/agent.js';
import {emptyBearings, type Bearings} from '../fleet/bearings.js';
import {isTerminal, type PR} from '../fleet/pr.js';
import {buildBoard, CARD_LINES, columnWidths, place, visibleEnd, type Card, type Column} from './board.js';
import {detailLines} from './render.js';
import {buildRows, deriveInfo, isHeader, type Info, type Row} from './rows.js';

export interface Config {
	// intervalMs is how often each live agent's local state is re-read.
	intervalMs: number;
	// inactiveIntervalMs is the same for done and unknown agents.
	inactiveIntervalMs: number;
	// fleetIntervalMs is how often the bearings snapshot is re-read.
	fleetIntervalMs: number;
	// prIntervalMs is how often an open PR and its checks are re-read.
	prIntervalMs: number;
}

export type Effect =
	| {kind: 'fleet'}
	| {kind: 'task'; agent: Agent}
	| {kind: 'pr'; url: string}
	| {kind: 'focus'; id: string; session: string; pane: string}
	| {kind: 'attach'; agent: Agent; worktree: string; runId: string}
	| {kind: 'quit'};

// Key mirrors the parts of Ink's Key fleetwatch reacts to.
export interface Key {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	pageUp?: boolean;
	pageDown?: boolean;
	home?: boolean;
	end?: boolean;
	return?: boolean;
	escape?: boolean;
	backspace?: boolean;
	delete?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	tab?: boolean;
}

export type Event =
	| {type: 'tick'}
	| {type: 'fleet'; fleet: Fleet}
	| {type: 'fleetError'; error: string}
	| {type: 'task'; id: string; detail: Detail}
	| {type: 'pr'; url: string; pr: PR}
	| {type: 'prError'; url: string; error: string}
	| {type: 'focused'; id: string}
	| {type: 'focusError'; id: string; error: string}
	| {type: 'attached'; id: string}
	| {type: 'attachError'; id: string; error: string}
	| {type: 'key'; input: string; key: Key}
	| {type: 'resize'; columns: number; rows: number};

export interface PrEntry {
	pr?: PR;
	error?: string;
	at?: number; // last successful read
	done?: number; // last attempt finished
	pending: boolean;
	forced: boolean;
}

// Placed is where a task's run stood when fleetwatch first saw it there.
interface Placed {
	column: string;
	status: string;
	at: number;
}

export class Model {
	bearings: Bearings = emptyBearings();
	agents: Agent[] = [];
	loaded = false;
	fleetAt?: number;
	fleetDone?: number;
	fleetError?: string;
	// The first fleet read starts with the app, so the model begins with it
	// in flight.
	fleetBusy = true;

	details = new Map<string, Detail>();
	taskDone = new Map<string, number>();
	taskPending = new Set<string>();
	prs = new Map<string, PrEntry>();

	infos = new Map<string, Info>();
	// view is the board of no-mistakes runs, or the v1 list of agents.
	view: 'board' | 'list' = 'board';

	board: Column[] = [];
	col = 0; // index into board
	card = 0; // index into the column's cards
	cardId = ''; // the selected card's agent
	cardChosen = false; // the user has moved the board selection
	boardLeft = 0; // first column on screen
	cardTop = 0; // first card on screen in the selected column
	cardTopFor = '';
	// placedAt is when each task was first seen where it is now, for cards
	// whose time there no-mistakes does not report.
	placedAt = new Map<string, Placed>();

	rows: Row[] = [];
	hidden = 0; // inactive agents hideInactive left out
	cursor = 0; // index into rows; always an agent row when any exist
	selected = '';
	chosen = false; // the user has moved the selection
	listTop = 0;
	filter = '';
	filtering = false;
	hideInactive = false;
	detailTop = 0;
	detailFor = '';

	columns = 0;
	height = 0;
	flash = '';
	flashAt = 0;

	constructor(
		readonly cfg: Config,
		readonly now: () => number = Date.now,
	) {}

	// start is the app's first effect: the initial fleet read.
	start(): Effect[] {
		return [{kind: 'fleet'}];
	}

	dispatch(ev: Event): Effect[] {
		const effects: Effect[] = [];
		switch (ev.type) {
			case 'resize':
				this.columns = ev.columns;
				this.height = ev.rows;
				break;
			case 'tick':
				effects.push(...this.schedule());
				break;
			case 'fleet':
				this.fleetBusy = false;
				this.fleetDone = this.now();
				this.fleetError = undefined;
				this.fleetAt = this.fleetDone;
				this.loaded = true;
				this.bearings = ev.fleet.bearings;
				this.agents = ev.fleet.agents;
				this.pruneGone();
				this.derive();
				effects.push(...this.schedule());
				break;
			case 'fleetError':
				this.fleetBusy = false;
				this.fleetDone = this.now();
				this.fleetError = ev.error;
				effects.push(...this.schedule());
				break;
			case 'task':
				this.taskPending.delete(ev.id);
				if (!this.agents.some((a) => a.id === ev.id)) break;
				this.taskDone.set(ev.id, this.now());
				this.details.set(ev.id, ev.detail);
				this.derive();
				effects.push(...this.schedule());
				break;
			case 'pr':
			case 'prError': {
				const e = this.prs.get(ev.url);
				if (!e) break;
				e.pending = false;
				e.done = this.now();
				if (ev.type === 'pr') {
					e.pr = ev.pr;
					e.error = undefined;
					e.at = e.done;
				} else {
					e.error = ev.error;
				}
				break;
			}
			case 'focused':
				this.setFlash(`focused ${ev.id} in herdr`);
				break;
			case 'focusError':
				this.setFlash(`focus ${ev.id} failed: ${ev.error}`);
				break;
			case 'attached':
			case 'attachError':
				// Whatever the captain did in the run's view shows on the board now.
				if (ev.type === 'attachError') this.setFlash(`could not open the run of ${ev.id}: ${ev.error}`);
				this.taskDone.delete(ev.id);
				effects.push(...this.schedule());
				break;
			case 'key':
				effects.push(...this.key(ev.input, ev.key));
				break;
		}
		this.layout();
		return effects;
	}

	// schedule starts every read that is due and not already running, so no
	// command ever blocks the view and no source is read twice at once.
	private schedule(): Effect[] {
		const now = this.now();
		const effects: Effect[] = [];
		if (!this.fleetBusy && (this.fleetDone === undefined || now - this.fleetDone >= this.cfg.fleetIntervalMs)) {
			this.fleetBusy = true;
			effects.push({kind: 'fleet'});
		}
		for (const a of this.agents) {
			if (a.absent || this.taskPending.has(a.id)) continue;
			const every = this.infos.get(a.id)?.inactive ? this.cfg.inactiveIntervalMs : this.cfg.intervalMs;
			const done = this.taskDone.get(a.id);
			if (done !== undefined && now - done < every) continue;
			this.taskPending.add(a.id);
			effects.push({kind: 'task', agent: a});
		}
		for (const [url, e] of this.prs) {
			if (e.pending) continue;
			if (e.done !== undefined && !e.forced) {
				if (now - e.done < this.cfg.prIntervalMs || (e.pr && isTerminal(e.pr))) continue;
			}
			e.pending = true;
			e.forced = false;
			effects.push({kind: 'pr', url});
		}
		return effects;
	}

	// forceRefresh makes every source due now, including PRs already merged.
	private forceRefresh(): Effect[] {
		this.fleetDone = undefined;
		this.taskDone.clear();
		for (const e of this.prs.values()) e.forced = true;
		this.setFlash('refreshing');
		return this.schedule();
	}

	private key(input: string, key: Key): Effect[] {
		if (key.ctrl && input === 'c') return [{kind: 'quit'}];
		if (this.filtering) {
			if (key.return) {
				this.filtering = false;
			} else if (key.escape) {
				this.filtering = false;
				this.filter = '';
			} else if (key.backspace || key.delete) {
				this.filter = this.filter.slice(0, -1);
			} else if (input && !key.ctrl && !key.meta && !key.tab) {
				this.filter += input;
			}
			this.rebuild();
			return [];
		}
		if (key.escape) {
			if (this.filter) {
				this.filter = '';
				this.rebuild();
			}
		} else if (key.tab) this.view = this.view === 'board' ? 'list' : 'board';
		else if (input === 'q') return [{kind: 'quit'}];
		else if (input === '/') this.filtering = true;
		else if (input === 'r') return this.forceRefresh();
		else if (this.view === 'board') return this.boardKey(input, key);
		else if (key.upArrow || input === 'k') this.move(-1);
		else if (key.downArrow || input === 'j') this.move(1);
		else if (key.home || input === 'g') this.move(-this.rows.length);
		else if (key.end || input === 'G') this.move(this.rows.length);
		else if (key.pageUp) this.scrollDetail(-1);
		else if (key.pageDown) this.scrollDetail(1);
		else if (key.return) return this.focusSelected();
		else if (input === 'd') {
			this.hideInactive = !this.hideInactive;
			this.rebuild();
		}
		return [];
	}

	private boardKey(input: string, key: Key): Effect[] {
		if (key.leftArrow || input === 'h') this.moveColumn(-1);
		else if (key.rightArrow || input === 'l') this.moveColumn(1);
		else if (key.upArrow || input === 'k') this.moveCard(-1);
		else if (key.downArrow || input === 'j') this.moveCard(1);
		else if (key.return) return this.attachSelected();
		return [];
	}

	// attachSelected opens no-mistakes' own view of the selected card's run.
	private attachSelected(): Effect[] {
		const a = this.selectedCardAgent();
		if (!a) return [];
		const d = this.details.get(a.id);
		const runId = d?.pipeline && !d.pipeline.noRun ? d.pipeline.runId : '';
		if (!runId) {
			this.setFlash(`${a.id} has no no-mistakes run to open`);
			return [];
		}
		return [{kind: 'attach', agent: a, worktree: d?.meta?.worktree ?? '', runId}];
	}

	private focusSelected(): Effect[] {
		const a = this.selectedAgent();
		if (!a) return [];
		const meta = this.details.get(a.id)?.meta;
		if (a.absent || !meta?.herdrPane) {
			this.setFlash(`${a.id} has no recorded herdr pane`);
			return [];
		}
		return [{kind: 'focus', id: a.id, session: meta.herdrSession, pane: meta.herdrPane}];
	}

	private setFlash(s: string): void {
		this.flash = s;
		this.flashAt = this.now();
	}

	// pruneGone drops cached reads for agents no longer in the roster.
	private pruneGone(): void {
		const live = new Set(this.agents.map((a) => a.id));
		for (const id of this.details.keys()) {
			if (!live.has(id)) {
				this.details.delete(id);
				this.taskDone.delete(id);
			}
		}
	}

	// derive recomputes per-agent info, registers PRs to watch, notes where
	// each run stands, and rebuilds rows and board.
	private derive(): void {
		this.infos = new Map();
		const wanted = new Set<string>();
		const placedAt = new Map<string, Placed>();
		for (const a of this.agents) {
			const d = this.details.get(a.id);
			const inf = deriveInfo(a, d, this.bearings);
			this.infos.set(a.id, inf);
			const at = place(d);
			if (at) {
				const was = this.placedAt.get(a.id);
				const same = was && was.column === at.column && was.status === at.status;
				placedAt.set(a.id, same ? was : {column: at.column, status: at.status, at: this.now()});
			}
			if (inf.prUrl) {
				wanted.add(inf.prUrl);
				if (!this.prs.has(inf.prUrl)) this.prs.set(inf.prUrl, {pending: false, forced: false});
			}
		}
		for (const [url, e] of this.prs) {
			if (!wanted.has(url) && !e.pending) this.prs.delete(url);
		}
		this.placedAt = placedAt;
		this.rebuild();
	}

	// rebuild regroups rows and keeps the selection on the same agent. Until
	// the user picks one, the selection stays on the top row as groups fill in.
	private rebuild(): void {
		this.rebuildBoard();
		({rows: this.rows, hidden: this.hidden} = buildRows(this.agents, this.infos, this.filter, this.hideInactive));
		if (this.chosen) {
			const i = this.rows.findIndex((r) => !isHeader(r) && this.agents[r.agent]!.id === this.selected);
			if (i >= 0) {
				this.cursor = i;
				return;
			}
		} else {
			this.cursor = 0;
		}
		this.cursor = Math.max(Math.min(this.cursor, this.rows.length - 1), 0);
		this.settle(1);
	}

	// move shifts the selection by delta agent rows, skipping headers.
	private move(delta: number): void {
		if (this.rows.length === 0) return;
		this.chosen = true;
		const step = delta < 0 ? -1 : 1;
		for (let n = Math.abs(delta); n > 0; n--) {
			let next = this.cursor + step;
			while (next >= 0 && next < this.rows.length && isHeader(this.rows[next]!)) next += step;
			if (next < 0 || next >= this.rows.length) break;
			this.cursor = next;
		}
		this.settle(step);
	}

	// settle moves the cursor off a header and records the selected agent.
	private settle(step: number): void {
		for (const dir of [step, -step]) {
			for (let i = this.cursor; i >= 0 && i < this.rows.length; i += dir) {
				const r = this.rows[i]!;
				if (!isHeader(r)) {
					this.cursor = i;
					this.selected = this.agents[r.agent]!.id;
					return;
				}
			}
		}
		this.selected = '';
	}

	// rebuildBoard re-lays the board and keeps the selection on the same card.
	// Until the user picks one, the first card is selected. When the selected
	// card leaves the board, the selection moves to the nearest card.
	private rebuildBoard(): void {
		this.board = buildBoard(this.agents, this.details, this.infos, this.filter);
		const col = this.board.findIndex((c) => c.cards.some((card) => this.agents[card.agent]!.id === this.cardId));
		if (this.cardChosen && col >= 0) {
			this.col = col;
			this.card = this.board[col]!.cards.findIndex((card) => this.agents[card.agent]!.id === this.cardId);
		} else {
			if (!this.cardChosen) [this.col, this.card] = [0, 0];
			this.col = Math.min(this.col, this.board.length - 1);
			this.moveColumn(0);
		}
		this.cardId = this.selectedCardAgent()?.id ?? '';
	}

	// moveColumn moves the board selection to the nearest column with cards
	// in a direction, or with delta 0 to the nearest one either way.
	private moveColumn(delta: number): void {
		const has = (i: number) => (this.board[i]?.cards.length ?? 0) > 0;
		let next = -1;
		if (delta === 0) {
			for (let d = 0; d < this.board.length && next < 0; d++) next = has(this.col - d) ? this.col - d : has(this.col + d) ? this.col + d : -1;
		} else {
			for (let i = this.col + delta; i >= 0 && i < this.board.length && next < 0; i += delta) if (has(i)) next = i;
		}
		if (next < 0) {
			if (delta === 0) this.card = 0;
			return;
		}
		if (delta !== 0) this.cardChosen = true;
		this.col = next;
		this.card = Math.min(this.card, this.board[next]!.cards.length - 1);
		this.cardId = this.selectedCardAgent()?.id ?? '';
	}

	private moveCard(delta: number): void {
		const n = this.board[this.col]?.cards.length ?? 0;
		if (n === 0) return;
		this.cardChosen = true;
		this.card = Math.min(Math.max(this.card + delta, 0), n - 1);
		this.cardId = this.selectedCardAgent()?.id ?? '';
	}

	selectedCard(): Card | undefined {
		return this.board[this.col]?.cards[this.card];
	}

	selectedCardAgent(): Agent | undefined {
		const c = this.selectedCard();
		return c ? this.agents[c.agent] : undefined;
	}

	selectedAgent(): Agent | undefined {
		const r = this.rows[this.cursor];
		return r && !isHeader(r) ? this.agents[r.agent] : undefined;
	}

	listWidth(): number {
		const w = Math.min(Math.max(Math.floor((this.columns * 2) / 5), 34), 60);
		return Math.max(Math.min(w, this.columns - 20), 10);
	}

	detailWidth(): number {
		return Math.max(this.columns - this.listWidth() - 3, 10);
	}

	bodyHeight(): number {
		return Math.max(this.height - 2, 1);
	}

	// cardSlots is how many cards fit in a column between its heading and the
	// board's info line. Each card takes CARD_LINES lines and a gap.
	cardSlots(): number {
		return Math.max(Math.floor((this.bodyHeight() - 3 + 1) / (CARD_LINES + 1)), 1);
	}

	private scrollDetail(direction: number): void {
		const a = this.selectedAgent();
		if (!a) return;
		const h = this.bodyHeight();
		const max = Math.max(detailLines(this, a, this.detailWidth()).length - h, 0);
		this.detailTop = Math.min(Math.max(this.detailTop + direction * Math.max(Math.floor(h / 2), 1), 0), max);
	}

	// layout keeps the selected row on screen and resets the detail scroll
	// when the selection changes.
	private layout(): void {
		this.layoutBoard();
		const h = this.bodyHeight();
		if (this.cursor < this.listTop) this.listTop = this.cursor;
		if (this.cursor >= this.listTop + h) this.listTop = this.cursor - h + 1;
		// Keep a group's header visible when its first agent is selected.
		const above = this.rows[this.cursor - 1];
		if (above && isHeader(above) && this.cursor - 1 < this.listTop) this.listTop = this.cursor - 1;
		this.listTop = Math.max(Math.min(this.listTop, this.rows.length - h), 0);
		if (this.selected !== this.detailFor) {
			this.detailTop = 0;
			this.detailFor = this.selected;
		}
	}

	// layoutBoard scrolls the board sideways so the selected column shows,
	// using all the width it can, and down so the selected card shows.
	private layoutBoard(): void {
		const widths = columnWidths(this.board, this.columns);
		if (this.col < this.boardLeft) this.boardLeft = this.col;
		while (this.boardLeft < this.col && visibleEnd(widths, this.boardLeft, this.columns) <= this.col) this.boardLeft++;
		while (this.boardLeft > 0 && visibleEnd(widths, this.boardLeft - 1, this.columns) === this.board.length) this.boardLeft--;
		const name = this.board[this.col]?.name ?? '';
		if (name !== this.cardTopFor) {
			this.cardTop = 0;
			this.cardTopFor = name;
		}
		const n = this.cardSlots();
		if (this.card < this.cardTop) this.cardTop = this.card;
		if (this.card >= this.cardTop + n) this.cardTop = this.card - n + 1;
	}
}
