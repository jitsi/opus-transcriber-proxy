#!/usr/bin/env node
/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
 * "Copyright notice"). Checks the files git tracks, by extension or name; a shebang or the
 * Dockerfile's `# syntax=` directive may precede the notice. Exits non-zero and lists offenders.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NOTICE = 'Copyright @ 2025 - Present, 8x8 Inc';
const EXTENSIONS = ['.ts', '.mts', '.mjs', '.cjs', '.js', '.c', '.cc', '.h', '.jsonc', '.yml', '.yaml'];
const NAMES = new Set(['Dockerfile', 'Makefile', 'binding.gyp']);
// Generated or vendored; not ours to stamp.
const EXCLUDED = [/^worker-configuration\.d\.ts$/, /^src\/OpusDecoder\/opus\//, /^test\/fixtures\//];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const missing = [];
for (const file of files) {
	const base = file.split('/').pop();
	const wanted = EXTENSIONS.some((ext) => file.endsWith(ext)) || NAMES.has(base);
	if (!wanted || EXCLUDED.some((re) => re.test(file))) continue;
	const head = readFileSync(file, 'utf8').slice(0, 800);
	if (!head.includes(NOTICE)) missing.push(file);
}
if (missing.length > 0) {
	console.error(`${missing.length} file(s) lack the copyright notice (see CLAUDE.md, "Copyright notice"):`);
	for (const f of missing) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`Copyright notice present in all ${files.length} tracked files that need one.`);
