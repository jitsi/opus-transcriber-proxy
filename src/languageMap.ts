/**
 * Language code mapping for transcription backends
 *
 * Accepts ISO-639-1 short codes (e.g., "en", "de", "fr") and converts
 * them to the format required by each backend.
 */

// ISO-639-1 to full language name mapping (for Gemini prompts)
const ISO_TO_NAME: Record<string, string> = {
	af: 'Afrikaans',
	ar: 'Arabic',
	be: 'Belarusian',
	bg: 'Bulgarian',
	bn: 'Bengali',
	bs: 'Bosnian',
	ca: 'Catalan',
	cs: 'Czech',
	da: 'Danish',
	de: 'German',
	el: 'Greek',
	en: 'English',
	es: 'Spanish',
	et: 'Estonian',
	fa: 'Persian',
	fi: 'Finnish',
	fr: 'French',
	he: 'Hebrew',
	hi: 'Hindi',
	hr: 'Croatian',
	hu: 'Hungarian',
	id: 'Indonesian',
	it: 'Italian',
	ja: 'Japanese',
	kn: 'Kannada',
	ko: 'Korean',
	lt: 'Lithuanian',
	lv: 'Latvian',
	mk: 'Macedonian',
	mr: 'Marathi',
	ms: 'Malay',
	nl: 'Dutch',
	no: 'Norwegian',
	pl: 'Polish',
	pt: 'Portuguese',
	ro: 'Romanian',
	ru: 'Russian',
	sk: 'Slovak',
	sl: 'Slovenian',
	sr: 'Serbian',
	sv: 'Swedish',
	ta: 'Tamil',
	te: 'Telugu',
	th: 'Thai',
	tl: 'Tagalog',
	tr: 'Turkish',
	uk: 'Ukrainian',
	ur: 'Urdu',
	vi: 'Vietnamese',
	zh: 'Chinese',
};

/**
 * Convert ISO-639-1 code to full language name (for Gemini).
 * Returns the code itself if not found in mapping.
 */
export function toLanguageName(code: string): string {
	return ISO_TO_NAME[code.toLowerCase()] || code;
}
