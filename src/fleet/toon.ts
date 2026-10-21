// TOON is the token-oriented notation that `no-mistakes axi` prints. This is a
// reader for the subset that command emits: two-space indented objects,
// `key: value` scalars, `key[N]{a,b}:` tables whose rows follow one level
// deeper, and `key[N]: a,b` inline arrays. Objects decode to plain objects,
// tables to arrays of string records, inline arrays to string arrays, and
// scalars to strings.

export type ToonValue = string | string[] | Record<string, string>[] | ToonObject;
export interface ToonObject {
	[key: string]: ToonValue;
}

const arrayHeader = /^([^[\]:{}]+)\[(\d+)\](?:\{([^}]*)\})?:(.*)$/;

interface Line {
	indent: number;
	text: string;
}

export function parseToon(doc: string): ToonObject {
	const lines: Line[] = [];
	for (const raw of doc.replace(/\r\n/g, '\n').split('\n')) {
		if (raw.trim() === '') continue;
		const text = raw.replace(/^ +/, '');
		lines.push({indent: raw.length - text.length, text});
	}
	const [obj, next] = parseObject(lines, 0, 0);
	if (next !== lines.length) {
		throw new Error(`toon: unexpected indentation at ${JSON.stringify(lines[next]!.text)}`);
	}
	return obj;
}

function parseObject(lines: Line[], start: number, indent: number): [ToonObject, number] {
	const obj: ToonObject = {};
	let i = start;
	while (i < lines.length) {
		const line = lines[i]!;
		if (line.indent < indent) break;
		if (line.indent > indent) {
			throw new Error(`toon: unexpected indentation at ${JSON.stringify(line.text)}`);
		}
		const header = arrayHeader.exec(line.text);
		if (header) {
			const key = header[1]!.trim();
			const rest = header[4]!.trim();
			if (header[3]) {
				const fields = splitRow(header[3]);
				const rows: Record<string, string>[] = [];
				i++;
				while (i < lines.length && lines[i]!.indent > indent) {
					const cells = splitRow(lines[i]!.text);
					const row: Record<string, string> = {};
					fields.forEach((f, k) => {
						if (k < cells.length) row[f] = cells[k]!;
					});
					rows.push(row);
					i++;
				}
				obj[key] = rows;
				continue;
			}
			obj[key] = rest === '' ? [] : splitRow(rest);
			i++;
			continue;
		}
		const colon = line.text.indexOf(':');
		if (colon < 0) {
			throw new Error(`toon: expected key at ${JSON.stringify(line.text)}`);
		}
		const key = line.text.slice(0, colon).trim();
		const value = line.text.slice(colon + 1).trim();
		const child = lines[i + 1];
		if (value === '' && child && child.indent > indent) {
			const [nested, next] = parseObject(lines, i + 1, child.indent);
			obj[key] = nested;
			i = next;
			continue;
		}
		obj[key] = unquote(value);
		i++;
	}
	return [obj, i];
}

// splitRow splits a comma-delimited row, honouring double-quoted cells.
function splitRow(s: string): string[] {
	const cells: string[] = [];
	let cur = '';
	let inQuote = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (inQuote && c === '\\' && i + 1 < s.length) {
			cur += c + s[i + 1];
			i++;
		} else if (c === '"') {
			inQuote = !inQuote;
			cur += c;
		} else if (c === ',' && !inQuote) {
			cells.push(unquote(cur.trim()));
			cur = '';
		} else {
			cur += c;
		}
	}
	cells.push(unquote(cur.trim()));
	return cells;
}

function unquote(s: string): string {
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		try {
			const v: unknown = JSON.parse(s);
			if (typeof v === 'string') return v;
		} catch {
			// Not valid JSON escaping; fall back to stripping the quotes.
		}
		return s.slice(1, -1);
	}
	return s;
}

export function toonString(o: ToonObject | undefined, key: string): string {
	const v = o?.[key];
	return typeof v === 'string' ? v : '';
}

export function toonObject(o: ToonObject | undefined, key: string): ToonObject | undefined {
	const v = o?.[key];
	return v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
}

export function toonTable(o: ToonObject | undefined, key: string): Record<string, string>[] {
	const v = o?.[key];
	if (!Array.isArray(v)) return [];
	return v.filter((r): r is Record<string, string> => typeof r === 'object');
}
