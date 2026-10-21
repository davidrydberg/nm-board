// CrewState is one `bin/fm-crew-state.sh <task>` line:
//
//	state: <state> · source: <source> · <detail>
export interface CrewState {
	state: string;
	source: string;
	detail: string;
	runId: string;
}

const crewSep = ' · ';
const runIdPattern = /\brun: ([0-9A-Z]{26})\b/;

export function parseCrewState(out: string): CrewState {
	const line = out.trim().split('\n')[0] ?? '';
	const first = line.indexOf(crewSep);
	const state = first < 0 ? line : line.slice(0, first);
	if (first < 0 || !state.startsWith('state: ')) {
		throw new Error(`crew-state: unrecognised line ${JSON.stringify(line)}`);
	}
	const rest = line.slice(first + crewSep.length);
	const second = rest.indexOf(crewSep);
	const source = second < 0 ? rest : rest.slice(0, second);
	if (!source.startsWith('source: ')) {
		throw new Error(`crew-state: missing source in ${JSON.stringify(line)}`);
	}
	const detail = second < 0 ? '' : rest.slice(second + crewSep.length);
	return {
		state: state.slice('state: '.length),
		source: source.slice('source: '.length),
		detail,
		runId: runIdPattern.exec(detail)?.[1] ?? '',
	};
}

// Meta is the subset of state/<task>.meta fleetwatch reads.
export interface Meta {
	worktree: string;
	project: string;
	harness: string;
	kind: string;
	mode: string;
	branch: string;
	baseBranch: string;
	model: string;
	effort: string;
	pr: string;
	backend: string;
	window: string;
	herdrSession: string;
	herdrPane: string;
	home: string; // a secondmate's own firstmate home
	remoteHost: string; // set for a secondmate that lives on another host
	decisionKeys: string[];
}

export function parseMeta(text: string): Meta {
	const kv = new Map<string, string>();
	for (const line of text.split('\n')) {
		const eq = line.indexOf('=');
		if (eq >= 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	const get = (k: string) => kv.get(k) ?? '';
	return {
		worktree: get('worktree'),
		project: get('project'),
		harness: get('harness'),
		kind: get('kind'),
		mode: get('mode'),
		branch: get('branch'),
		baseBranch: get('base_branch'),
		model: get('model'),
		effort: get('effort'),
		pr: get('pr'),
		backend: get('backend'),
		window: get('window'),
		herdrSession: get('herdr_session'),
		herdrPane: get('herdr_pane_id'),
		home: get('home'),
		remoteHost: get('remote_host'),
		decisionKeys: get('decision_keys')
			.split(',')
			.map((k) => k.trim())
			.filter((k) => k !== ''),
	};
}

// StatusEntry is one event from the append-only state/<task>.status log:
//
//	<state> [at=<epoch>] [key=<slug>]: <text>
//
// Tags are optional and may come in any order. Lines that do not open an
// entry continue the previous one. at is epoch milliseconds, or undefined
// when the line carried no usable stamp.
export interface StatusEntry {
	state: string;
	at?: number;
	key: string;
	text: string;
}

const statusLine = /^([a-z][a-z-]*)((?: \[[a-z]+=[^\]]*\])*): ?(.*)$/;
const statusTag = /\[([a-z]+)=([^\]]*)\]/g;
const statusStates = new Set(['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'resolved']);

export function parseStatusLog(text: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	for (const line of text.split('\n')) {
		const m = statusLine.exec(line);
		if (m && statusStates.has(m[1]!)) {
			const e: StatusEntry = {state: m[1]!, key: '', text: m[3]!};
			for (const tag of m[2]!.matchAll(statusTag)) {
				if (tag[1] === 'at' && /^\d+$/.test(tag[2]!)) e.at = Number(tag[2]) * 1000;
				if (tag[1] === 'key') e.key = tag[2]!;
			}
			entries.push(e);
			continue;
		}
		const last = entries.at(-1);
		if (line.trim() !== '' && last) last.text += '\n' + line;
	}
	return entries;
}

// openDecisions returns needs-decision entries no later resolved line closed.
// A keyed decision closes only on a resolved line with the same key; a keyless
// one closes on a later keyless resolved line.
export function openDecisions(entries: StatusEntry[]): StatusEntry[] {
	return entries.filter(
		(e, i) => e.state === 'needs-decision' && !entries.slice(i + 1).some((later) => later.state === 'resolved' && later.key === e.key),
	);
}

// lastStamped returns the time of the newest entry that carries a stamp.
export function lastStamped(entries: StatusEntry[]): number | undefined {
	let t: number | undefined;
	for (const e of entries) {
		if (e.at !== undefined && (t === undefined || e.at > t)) t = e.at;
	}
	return t;
}

// Busy is state/<task>.busy-state: the harness's last busy/idle event.
//
//	v1 gen=<gen> seq=<n> state=<busy|idle> source=<src> event=<event> ts=<epoch>
export interface Busy {
	state: string;
	source: string;
	event: string;
	at?: number;
}

export function parseBusy(text: string): Busy {
	const fields = text.trim().split(/\s+/);
	if (fields[0] !== 'v1') {
		throw new Error(`busy-state: unsupported record ${JSON.stringify(text.trim())}`);
	}
	const b: Busy = {state: '', source: '', event: ''};
	for (const f of fields.slice(1)) {
		const eq = f.indexOf('=');
		const k = eq < 0 ? f : f.slice(0, eq);
		const v = eq < 0 ? '' : f.slice(eq + 1);
		if (k === 'state') b.state = v;
		if (k === 'source') b.source = v;
		if (k === 'event') b.event = v;
		if (k === 'ts' && /^\d+$/.test(v)) b.at = Number(v) * 1000;
	}
	return b;
}
