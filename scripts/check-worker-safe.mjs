#!/usr/bin/env node
// Guards the runtime-agnostic translation core: fails if any of these files import a Node-only
// module/API, which would break the Cloudflare Worker bundle. The core must receive Node-specific
// dependencies via the injected TranslationRuntime (see src/translate/runtime.ts), never import them.
//
// Node-side adapters (src/translate/nodeRuntime.ts, src/OpusDecoder/wasmSourceNode.ts, the native
// codec, the Node server) are intentionally NOT listed here.

import fs from 'fs';

const CORE_FILES = [
	'src/translatorproxy.ts',
	'src/TranslatorConnection.ts',
	'src/usage-reporter.ts',
	'src/RtpTimestamper.ts',
	'src/translate/runtime.ts',
	'src/translate/emitter.ts',
	'src/translate/base64.ts',
	'src/translate/messages.ts',
	'src/translate/env.ts',
	'src/buildInfo.ts',
	'src/OpusDecoder/OpusDecoderWasm.ts',
	'src/OpusDecoder/opusTypes.ts',
	'src/OpusEncoder/OpusEncoderWasm.ts',
	'src/OpusEncoder/opusEncoderTypes.ts',
];

const FORBIDDEN = [
	{ re: /\bfrom\s+['"]fs['"]/, msg: "import from 'fs'" },
	{ re: /\bfrom\s+['"]node:/, msg: "import from 'node:*'" },
	{ re: /\bfrom\s+['"]ws['"]/, msg: "import from 'ws'" },
	{ re: /\bfrom\s+['"](\.\.?\/)+logger['"]/, msg: 'import ./logger (Winston) — use runtime.logger' },
	{ re: /\bfrom\s+['"](\.\.?\/)+config['"]/, msg: 'import ./config — use runtime.config' },
	{ re: /\bfrom\s+['"](\.\.?\/)+metrics['"]/, msg: 'import ./metrics — use runtime.writeMetric' },
	{ re: /\bfrom\s+['"](\.\.?\/)+MetricCache['"]/, msg: 'import ./MetricCache — use runtime.createMetricBatcher' },
	{ re: /\bBuffer\b/, msg: 'use of Buffer — use src/translate/base64' },
];

let failed = false;
for (const rel of CORE_FILES) {
	const lines = fs.readFileSync(rel, 'utf8').split('\n');
	lines.forEach((line, i) => {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
		// Strip a trailing inline comment so e.g. `const x = 1; // Buffer note` doesn't false-positive.
		// (Crude — also cuts `//` inside string literals — but that only removes potential matches, and
		// none of the forbidden patterns plausibly appear inside a legitimate string.)
		const code = line.replace(/\/\/.*$/, '');
		for (const { re, msg } of FORBIDDEN) {
			if (re.test(code)) {
				console.error(`${rel}:${i + 1}: not Worker-safe: ${msg}\n    ${line.trim()}`);
				failed = true;
			}
		}
	});
}

if (failed) {
	console.error('\nThe translation core must stay runtime-neutral (Worker-safe). Inject Node deps via TranslationRuntime.');
	process.exit(1);
}
console.log(`Worker-safe core check passed (${CORE_FILES.length} files).`);
