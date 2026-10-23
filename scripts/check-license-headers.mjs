#!/usr/bin/env node
/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * CI guard: every source file carries the Apache 2.0 copyright notice (see CLAUDE.md,
 * "Copyright notice"). Checks the files git tracks, by extension or name. The notice must sit in
 * the file's leading comment block, which a shebang or the Dockerfile's `# syntax=` directive may
 * precede; a mention of it further down (in code or prose) does not count. Any year is accepted,
 * since a new file carries the year it was created. Exits non-zero and lists offenders.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const NOTICE = /Copyright @ \d{4} - present 8x8, Inc\./;
const EXTENSIONS = ['.ts', '.mts', '.mjs', '.cjs', '.js', '.c', '.cc', '.h', '.jsonc', '.yml', '.yaml'];
const NAMES = new Set(['Dockerfile', 'Makefile', 'binding.gyp']);
// Generated or vendored; not ours to stamp.
const EXCLUDED = [/^worker-configuration\.d\.ts$/, /^src\/OpusDecoder\/opus\//];

/** The file's leading comment block: comment lines from the top, after an optional shebang/syntax line. */
function leadingComment(text) {
	const lines = text.split('\n');
	if (lines[0]?.startsWith('#!') || lines[0]?.startsWith('# syntax=')) lines.shift();
	const block = [];
	let inBlockComment = false;
	for (const line of lines) {
		const t = line.trim();
		if (inBlockComment) {
			block.push(line);
			if (t.includes('*/')) inBlockComment = false;
			continue;
		}
		if (t.startsWith('/*')) {
			block.push(line);
			inBlockComment = !t.includes('*/');
			continue;
		}
		if (t.startsWith('//') || t.startsWith('#')) {
			block.push(line);
			continue;
		}
		break;
	}
	return block.join('\n');
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const missing = [];
let checked = 0;
for (const file of files) {
	const base = file.split('/').pop();
	const wanted = EXTENSIONS.some((ext) => file.endsWith(ext)) || NAMES.has(base);
	// A tracked path deleted in the working tree (not yet staged) has nothing to check.
	if (!wanted || EXCLUDED.some((re) => re.test(file)) || !existsSync(file)) continue;
	checked++;
	if (!NOTICE.test(leadingComment(readFileSync(file, 'utf8')))) missing.push(file);
}
if (missing.length > 0) {
	console.error(`${missing.length} of ${checked} file(s) lack the copyright notice (see CLAUDE.md, "Copyright notice"):`);
	for (const f of missing) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`Copyright notice present in all ${checked} checked files.`);
