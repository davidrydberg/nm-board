import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {CTRL_C, ESC, mapInput} from '../src/view/attach.js';
import {hasPython, ptyDriver} from './helpers.js';

test('a lone Esc becomes Ctrl+C, the key no-mistakes detaches on; everything else passes through', () => {
	assert.equal(mapInput(ESC), CTRL_C);
	assert.equal(mapInput('\x1b[A'), '\x1b[A', 'an arrow key');
	assert.equal(mapInput('\x1bq'), '\x1bq', 'Alt+q');
	assert.equal(mapInput('\x1b]11;rgb:0000/0000/0000\x1b\\'), '\x1b]11;rgb:0000/0000/0000\x1b\\', "the terminal's answer to a colour query");
	assert.equal(mapInput('q'), 'q');
	assert.equal(mapInput(CTRL_C), CTRL_C);
});

// The stand-in for no-mistakes prints each byte it reads, in hex, and leaves
// on Ctrl+C as no-mistakes attach does.
const fakeNoMistakes = `#!/bin/sh
stty raw -echo
printf '[nm ready %s]' "$*"
while :; do
	c=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')
	printf '[nm %s]' "$c"
	if [ "$c" = 03 ]; then printf '[nm detached]'; stty sane; exit 0; fi
done
`;

test('attachWithEsc runs no-mistakes attach on its own pty and detaches it on Esc', {skip: !hasPython && 'needs python3 for a pty'}, () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'nm-watch-test-'));
	const bin = path.join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(path.join(bin, 'no-mistakes'), fakeNoMistakes);
	chmodSync(path.join(bin, 'no-mistakes'), 0o755);
	const app = path.join(dir, 'app.mjs');
	writeFileSync(
		app,
		`import {attachWithEsc} from ${JSON.stringify(new URL('../src/view/attach.js', import.meta.url).href)};
const status = await attachWithEsc(${JSON.stringify(dir)}, '01JXB56R3S8P2RMK6RQF9R4EN9');
process.stdout.write('[exit ' + status + ']');
process.exit(0);
`,
	);
	const out = execFileSync('python3', ['-c', ptyDriver, process.execPath, app], {
		input: [
			'WAIT [nm ready attach --run 01JXB56R3S8P2RMK6RQF9R4EN9]',
			'TYPE a',
			'WAIT [nm 61]',
			'SEND \\x1b[A',
			'WAIT [nm 41]',
			'TYPE \\x1b',
			'WAIT [exit 0]',
		].join('\n'),
		encoding: 'utf8',
		env: {...process.env, PATH: `${bin}:${process.env['PATH']}`},
	});
	assert.match(out, /\[nm 61\]\[nm 1b\]\[nm 5b\]\[nm 41\]\[nm 03\]\[nm detached\]/, out);
	assert.match(out, /\[exit 0\]/, out);
});
