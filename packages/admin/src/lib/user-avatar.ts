export interface UserAvatarPalette {
	name: string;
	top: string;
	bottom: string;
}

export interface UserAvatarWave {
	base: number;
	amp: number;
	freq: number;
	phase: number;
	amp2: number;
}

// The order and length of both tables choose every user's avatar. Changing
// either gives almost every existing user a different one.
export const USER_AVATAR_PALETTES: readonly UserAvatarPalette[] = [
	{ name: "Ember", top: "#fee4b9", bottom: "#e14c33" },
	{ name: "Apricot", top: "#ffe6aa", bottom: "#dd6301" },
	{ name: "Meadow", top: "#e5efae", bottom: "#009b3c" },
	{ name: "Jade", top: "#caf7c1", bottom: "#07957c" },
	{ name: "Lagoon", top: "#a7fbea", bottom: "#058eaf" },
	{ name: "Sky", top: "#aff6fe", bottom: "#0584da" },
	{ name: "Indigo", top: "#d3ecff", bottom: "#5f74e4" },
	{ name: "Iris", top: "#ffdbfa", bottom: "#8a66d9" },
	{ name: "Orchid", top: "#fedee7", bottom: "#b156b7" },
	{ name: "Rose", top: "#fee1d4", bottom: "#d04a69" },
	{ name: "Dusk", top: "#ffe0d6", bottom: "#447be4" },
	{ name: "Twilight", top: "#fee5b0", bottom: "#9860d0" },
];

export const USER_AVATAR_WAVES: readonly UserAvatarWave[] = [
	{ base: 44, amp: 6, freq: 0.5, phase: 0.3, amp2: 0 },
	{ base: 42, amp: 7, freq: 1, phase: 0, amp2: 0 },
	{ base: 46, amp: 7, freq: 1, phase: Math.PI, amp2: 0 },
	{ base: 41, amp: 5, freq: 1.5, phase: 0.6, amp2: 0 },
	{ base: 45, amp: 8, freq: 0.75, phase: 1.2, amp2: 0 },
	{ base: 43, amp: 6, freq: 1.25, phase: 2.4, amp2: 0 },
	{ base: 47, amp: 6, freq: 1, phase: Math.PI / 2, amp2: 2.5 },
	{ base: 40, amp: 4, freq: 2, phase: 0.2, amp2: 0 },
];

export function cyrb53(str: string): [number, number] {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return [h1 >>> 0, h2 >>> 0];
}

export interface UserAvatarVariant {
	palette: number;
	wave: number;
	angle: number;
	mirrored: boolean;
}

export function userAvatarVariant(id: string): UserAvatarVariant {
	const [h1, h2] = cyrb53(id);
	return {
		palette: h1 % 12,
		wave: (h1 >>> 8) % 8,
		angle: (h2 % 25) - 12,
		mirrored: ((h2 >>> 7) & 1) === 1,
	};
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LEADING_NON_ALPHANUMERIC = /^[^\p{L}\p{N}]+/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s+/;

function firstGrapheme(word: string): string {
	for (const { segment } of graphemes.segment(word)) return segment;
	return "";
}

function isCased(ch: string): boolean {
	return ch.toUpperCase() !== ch.toLowerCase();
}

/**
 * Uppercased without a locale, so a user's initials are the same in every
 * admin language. An uncased first character (a digit, Chinese, Arabic)
 * stands alone, because two joined Arabic letters would read as a word.
 */
export function userAvatarInitials(name: string | null | undefined): string[] {
	const words = (name ?? "")
		.trim()
		.split(WHITESPACE)
		.map((word) => word.replace(LEADING_NON_ALPHANUMERIC, ""))
		.filter((word) => ALPHANUMERIC.test(word));
	const first = words[0];
	if (first === undefined) return [];
	const firstChar = firstGrapheme(first);
	const last = words.at(-1);
	if (words.length === 1 || last === undefined || !isCased(firstChar)) {
		return [firstChar.toUpperCase()];
	}
	return [firstChar.toUpperCase(), firstGrapheme(last).toUpperCase()];
}

/**
 * The wave's top edge as a Catmull-Rom curve through samples every 10 units,
 * wider than the view box so rotation never exposes its ends, closed well
 * below the circle.
 */
export function userAvatarWavePath({ base, amp, freq, phase, amp2 }: UserAvatarWave): string {
	const y = (x: number) => {
		const t = (2 * Math.PI * x) / 100;
		return base + amp * Math.sin(t * freq + phase) + amp2 * Math.sin(t * freq * 2 + phase);
	};
	const points: [number, number][] = [];
	for (let x = -40; x <= 140; x += 10) points.push([x, y(x)]);

	const [start] = points;
	if (!start) return "";
	let d = `M ${start[0]} ${start[1].toFixed(2)}`;
	for (let i = 0; i < points.length - 1; i++) {
		const p1 = points[i]!;
		const p2 = points[i + 1]!;
		const p0 = points[i - 1] ?? p1;
		const p3 = points[i + 2] ?? p2;
		const c1x = p1[0] + (p2[0] - p0[0]) / 6;
		const c1y = p1[1] + (p2[1] - p0[1]) / 6;
		const c2x = p2[0] - (p3[0] - p1[0]) / 6;
		const c2y = p2[1] - (p3[1] - p1[1]) / 6;
		d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1].toFixed(2)}`;
	}
	return `${d} L 140 160 L -40 160 Z`;
}

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes two `#rrggbb` colors in sRGB, `t` of the way from `a` to `b`. */
export function mixHex(a: string, b: string, t: number): string {
	const from = hexToRgb(a);
	const to = hexToRgb(b);
	return `#${from
		.map((v, i) =>
			Math.round(v + (to[i]! - v) * t)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
