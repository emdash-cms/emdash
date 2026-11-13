import type { CSSProperties } from "react";

import { USER_AVATAR_PALETTES, userAvatarVariant, type UserAvatarPalette } from "./user-avatar.js";

/**
 * A person's color in co-editing and revision history, from their avatar's palette, so they look
 * the same everywhere. People whose avatars share a palette share it too.
 */
export interface UserColor {
	/** The palette's name, for `data-author-color`. */
	readonly name: string;
	/** The palette's bottom color: caret lines, selections, and revision marks. */
	readonly line: string;
	/** The gradient behind a name, from the caret's side to the far end. Both keep white text at 4.5:1. */
	readonly flag: readonly [string, string];
}

/** How much darker than the palette's bottom each end of a flag is, and the least contrast white text keeps there. */
const FLAG_START = { darken: 0.12, contrast: 5 };
const FLAG_END = { darken: 0.08, contrast: 4.6 };
/** How far the flag's far end turns toward the hue of the palette's top. */
const FLAG_END_HUE_SHIFT = 0.3;

const derived: Array<UserColor | undefined> = [];

export function userColor(id: string): UserColor {
	return userPaletteColor(userAvatarVariant(id).palette);
}

/** The color of the palette at `index` in `USER_AVATAR_PALETTES`. */
export function userPaletteColor(index: number): UserColor {
	const palette = USER_AVATAR_PALETTES[index];
	if (!palette) throw new RangeError(`No avatar palette ${index}`);
	return (derived[index] ??= derive(palette));
}

/** The custom properties that paint a person's color. Without one, an element keeps the neutral color. */
export function userColorProperties(color: UserColor | null): Record<string, string> {
	if (!color) return {};
	return {
		"--emdash-author": color.line,
		"--emdash-author-flag-start": color.flag[0],
		"--emdash-author-flag-end": color.flag[1],
	};
}

/** Props that mark an element with a person's color, or the neutral one. */
export function userColorProps(color: UserColor | null): {
	"data-author-color": string;
	style: CSSProperties;
} {
	return {
		"data-author-color": color?.name ?? "neutral",
		style: userColorProperties(color),
	};
}

function derive({ name, top, bottom }: UserAvatarPalette): UserColor {
	const [lightness, chroma, hue] = hexToOklch(bottom);
	const towardTop = hueArc(hue, hexToOklch(top)[2]) * FLAG_END_HUE_SHIFT;
	return {
		name: name.toLowerCase(),
		line: bottom,
		flag: [
			shade(lightness - FLAG_START.darken, chroma, hue, FLAG_START.contrast),
			shade(lightness - FLAG_END.darken, chroma, hue + towardTop, FLAG_END.contrast),
		],
	};
}

/** The lightest color up to `lightness`, at the hue, that keeps white text at `contrast` or more. */
function shade(lightness: number, chroma: number, hue: number, contrast: number): string {
	const at = (l: number) => oklchToHex(l, chroma, hue);
	if (whiteContrast(at(lightness)) >= contrast) return at(lightness);
	let low = 0;
	let high = lightness;
	for (let step = 0; step < 20; step++) {
		const middle = (low + high) / 2;
		if (whiteContrast(at(middle)) >= contrast) low = middle;
		else high = middle;
	}
	return at(low);
}

/** The signed turn from one hue to another the short way round, in degrees. */
function hueArc(from: number, to: number): number {
	return ((((to - from) % 360) + 540) % 360) - 180;
}

type Triple = [number, number, number];

function byteToLinear(byte: number): number {
	const c = byte / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex: string): Triple {
	const n = Number.parseInt(hex.slice(1), 16);
	return [byteToLinear((n >> 16) & 255), byteToLinear((n >> 8) & 255), byteToLinear(n & 255)];
}

function linearToHex(rgb: Triple): string {
	return `#${rgb
		.map((c) => {
			const v = Math.min(1, Math.max(0, c));
			const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
			return Math.round(encoded * 255)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

function hexToOklch(hex: string): Triple {
	const [r, g, b] = hexToLinear(hex);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function oklchToLinear(lightness: number, chroma: number, hue: number): Triple {
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const inGamut = (rgb: Triple) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** An OKLCH color as `#rrggbb`, losing chroma, never lightness or hue, to fit in sRGB. */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
	if (inGamut(oklchToLinear(lightness, chroma, hue))) {
		return linearToHex(oklchToLinear(lightness, chroma, hue));
	}
	let low = 0;
	let high = chroma;
	for (let step = 0; step < 20; step++) {
		const middle = (low + high) / 2;
		if (inGamut(oklchToLinear(lightness, middle, hue))) low = middle;
		else high = middle;
	}
	return linearToHex(oklchToLinear(lightness, low, hue));
}

function whiteContrast(hex: string): number {
	const [r, g, b] = hexToLinear(hex);
	return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}
