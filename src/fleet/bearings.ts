// BEARINGS_SCHEMA is the output contract fleetwatch reads from
// `bin/fm-bearings-snapshot.sh --json`.
export const BEARINGS_SCHEMA = 'fm-bearings.v1';

// MAIN_OWNER is the decisions_open owner value for the supervising home.
export const MAIN_OWNER = '(main)';

// InFlight is one underway task. Secondmate children carry "<home>/<task>" ids.
export interface InFlight {
	id: string;
	kind: string;
	state: string;
	repo: string;
	name: string;
	doing: string;
}

export interface SecondmateRow {
	id: string;
	state: string;
	doing: string;
}

export interface SecondmateHost {
	id: string;
	host: string;
}

// Decision is an open captain decision. owner is MAIN_OWNER or a secondmate id.
export interface Decision {
	id: string;
	key: string;
	verb: string;
	summary: string;
	owner: string;
}

// Bearings is the part of the bearings snapshot fleetwatch shows.
export interface Bearings {
	schema: string;
	home: string;
	generated: string;
	inFlight: InFlight[];
	secondmates: SecondmateRow[];
	reconcile: SecondmateHost[];
	decisions: Decision[];
}

export function emptyBearings(): Bearings {
	return {schema: BEARINGS_SCHEMA, home: '', generated: '', inFlight: [], secondmates: [], reconcile: [], decisions: []};
}

type Raw = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function rows(v: unknown): Raw[] {
	return Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : [];
}

// parseBearings decodes the bearings JSON projection and checks its schema.
export function parseBearings(text: string): Bearings {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`bearings: ${(error as Error).message}`);
	}
	if (typeof raw !== 'object' || raw === null) throw new Error('bearings: not a JSON object');
	const b = raw as Raw;
	if (b['schema'] !== BEARINGS_SCHEMA) {
		throw new Error(`bearings: schema ${JSON.stringify(b['schema'])}, want ${JSON.stringify(BEARINGS_SCHEMA)}`);
	}
	return {
		schema: BEARINGS_SCHEMA,
		home: str(b['home']),
		generated: str(b['generated']),
		inFlight: rows(b['in_flight']).map((r) => ({
			id: str(r['id']),
			kind: str(r['kind']),
			state: str(r['state']),
			repo: str(r['repo']),
			name: str(r['name']),
			doing: str(r['doing']),
		})),
		secondmates: rows(b['secondmates']).map((r) => ({id: str(r['id']), state: str(r['state']), doing: str(r['doing'])})),
		reconcile: rows(b['secondmate_reconcile']).map((r) => ({id: str(r['id']), host: str(r['host'])})),
		decisions: rows(b['decisions_open']).map((r) => ({
			id: str(r['id']),
			key: str(r['key']),
			verb: str(r['verb']),
			summary: str(r['summary']),
			owner: str(r['owner']),
		})),
	};
}

// secondmateHost returns the host a secondmate home lives on, if recorded.
export function secondmateHost(b: Bearings, id: string): string {
	return b.reconcile.find((r) => r.id === id)?.host ?? '';
}
