// The nm-watch view state and its update logic. The model never runs a
// command: dispatch returns effects, the app runs them through a Source, and
// their results come back as events. That keeps every read in the background
// and the update logic testable without a terminal.

import type {Fleet} from '../collect/collect.js';
import type {Agent, Detail} from '../fleet/agent.js';
import {emptyBearings, type Bearings} from '../fleet/bearings.js';
import {buildBoard, CARD_LINES, columnWidths, visibleEnd, type Card, type Column} from './board.js';
import {deriveInfo, type Info} from './rows.js';

export interface Config {
	// intervalMs is how often each live agent's local state is re-read.
	intervalMs: number;
	// inactiveIntervalMs is the same for done and unknown agents.
	inactiveIntervalMs: number;
	// fleetIntervalMs is how often the bearings snapshot is re-read.
	fleetIntervalMs: number;
	// popup is set when Enter opens runs in a herdr popup, which Esc closes.
	popup?: boolean;
}

export type Effect =
	| {kind: 'fleet'}
	| {kind: 'task'; agent: Agent}
	| {kind: 'attach'; agent: Agent; worktree: string; runId: string}
	| {kind: 'quit'};

// Key mirrors the parts of Ink's Key nm-watch reacts to.
export interface Key {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
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
	| {type: 'attached'; id: string; note?: string}
	| {type: 'attachError'; id: string; error: string}
	| {type: 'key'; input: string; key: Key}
	| {type: 'resize'; columns: number; rows: number};

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

	infos = new Map<string, Info>();
	board: Column[] = [];
	col = 0; // index into board
	card = 0; // index into the column's cards
	cardId = ''; // the selected card's agent
	cardChosen = false; // the user has moved the board selection
	boardLeft = 0; // first column on screen
	cardTop = 0; // first card on screen in the selected column
	cardTopFor = '';
	filter = '';
	filtering = false;

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
			case 'attached':
			case 'attachError':
				// Whatever the captain did in the run's view shows on the board now.
				if (ev.type === 'attachError') this.setFlash(`could not open the run of ${ev.id}: ${ev.error}`);
				else if (ev.note) this.setFlash(ev.note);
				this.taskDone.delete(ev.id);
				effects.push(...this.schedule());
				break;
			case 'key':
				effects.push(...this.key(ev.input, ev.key));
				break;
		}
		this.layoutBoard();
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
		return effects;
	}

	// forceRefresh makes every source due now.
	private forceRefresh(): Effect[] {
		this.fleetDone = undefined;
		this.taskDone.clear();
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
		} else if (input === 'q') return [{kind: 'quit'}];
		else if (input === '/') this.filtering = true;
		else if (input === 'r') return this.forceRefresh();
		else if (key.leftArrow || input === 'h') this.moveColumn(-1);
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

	// derive recomputes per-agent info and rebuilds the board.
	private derive(): void {
		this.infos = new Map();
		for (const a of this.agents) this.infos.set(a.id, deriveInfo(a, this.details.get(a.id), this.bearings));
		this.rebuild();
	}

	// rebuild re-lays the board and keeps the selection on the same card.
	// Until the user picks one, the first card is selected. When the selected
	// card leaves the board, the selection moves to the nearest card.
	private rebuild(): void {
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

	bodyHeight(): number {
		return Math.max(this.height - 2, 1);
	}

	// cardSlots is how many cards fit in a column between its heading and the
	// board's info line. Each card takes CARD_LINES lines and a gap; the last
	// gap holds the count of cards below.
	cardSlots(): number {
		return Math.max(Math.floor((this.bodyHeight() - 3) / (CARD_LINES + 1)), 1);
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
