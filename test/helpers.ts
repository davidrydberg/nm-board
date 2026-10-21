import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';

// Rendered text is compared without colour.
chalk.level = 0;

// Fixtures under test/fixtures are synthetic data in the shapes of real
// command output and state files; see test/fixtures/README.md. Compiled
// tests run from build-test/test, so the path climbs back to the sources.
const fixtures = new URL('../../test/fixtures/', import.meta.url);

export function fixture(name: string): string {
	return readFileSync(new URL(name, fixtures), 'utf8');
}

export const fixturePath = (name: string) => new URL(name, fixtures).pathname;

// ptyDriver runs a command on a new pty. It answers each "WAIT text" line by
// waiting for the text in the output, each "TYPE keys" line by typing the keys
// one at a time, and each "SEND keys" line by sending the keys at once, as a
// terminal sends an escape sequence; keys may hold \xNN escapes. Then it
// prints all the output.
export const ptyDriver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = b''
def wait(text):
    global out
    end = time.time() + 5
    while text not in out and time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                out += os.read(fd, 4096)
            except OSError:
                return
for line in sys.stdin.read().splitlines():
    verb, arg = line.split(' ', 1)
    if verb == 'WAIT':
        wait(arg.encode())
    keys = arg.encode().decode('unicode_escape').encode('latin-1')
    if verb == 'SEND':
        os.write(fd, keys)
        time.sleep(0.05)
    for key in keys if verb == 'TYPE' else b'':
        os.write(fd, bytes([key]))
        time.sleep(0.05)
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.write(out.decode(errors='replace'))
`;

export const hasPython = (() => {
	try {
		execFileSync('python3', ['-c', 'import pty']);
		return true;
	} catch {
		return false;
	}
})();

// FakeHerdr is a herdr API socket that answers each request line with answer,
// or hangs up without answering when answer is null, and records requests.
export interface FakeHerdr {
	socket: string;
	requests: Record<string, unknown>[];
	close(): Promise<void>;
}

export async function fakeHerdr(answer: object | null): Promise<FakeHerdr> {
	const socket = path.join(mkdtempSync(path.join(os.tmpdir(), 'fw-herdr-')), 'herdr.sock');
	const requests: Record<string, unknown>[] = [];
	const server = createServer((conn) => {
		let buf = '';
		conn.setEncoding('utf8').on('data', (s: string) => {
			buf += s;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
			requests.push(req);
			if (answer === null) conn.destroy();
			else conn.end(JSON.stringify({id: req['id'], ...answer}) + '\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	return {socket, requests, close: () => new Promise((resolve) => server.close(() => resolve()))};
}
