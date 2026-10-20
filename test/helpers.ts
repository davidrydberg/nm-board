import {readFileSync} from 'node:fs';
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
