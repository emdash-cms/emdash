/**
 * Generated halftone art for plugins, ported from emdashcms.com's post covers.
 *
 * A seed picks one motif and seeds every motif parameter, so a plugin always
 * gets the same art. The motif is a field sampled on a dot grid: each sample's
 * intensity sets the dot size, and exactly one part of each motif is drawn in
 * the accent colour. Dots of one size and tone are drawn as a single path of
 * zero-length round-capped segments, so a tile is a handful of short path
 * strings rather than a hundred elements.
 */

/** Grid pitch in SVG user units. Small, so relative moves stay one or two digits. */
export const ART_CELL = 2;

export interface ArtGrid {
	columns: number;
	rows: number;
	/** Dot diameter for each of the six size levels, as a share of the cell. */
	levels: readonly number[];
	/** Samples below this intensity draw no dot. */
	threshold: number;
}

/**
 * The tile replaces a missing icon at 44–56px, so its grid is coarse and its
 * smallest dots are larger than a cover's and its faintest samples are dropped:
 * anything under a pixel turns to grey fuzz at that size.
 */
export const ART_GRIDS = {
	tile: { columns: 13, rows: 13, levels: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8], threshold: 0.14 },
	feature: {
		columns: 64,
		rows: 40,
		levels: [0.14, 0.24, 0.34, 0.45, 0.57, 0.7],
		threshold: 0.07,
	},
} as const satisfies Record<string, ArtGrid>;

export type ArtVariant = keyof typeof ART_GRIDS;

export type ArtMotif =
	| "ripple"
	| "dash"
	| "sphere"
	| "lines"
	| "waveform"
	| "stack"
	| "horizon"
	| "blocks";

export const MOTIFS: readonly ArtMotif[] = [
	"ripple",
	"dash",
	"sphere",
	"lines",
	"waveform",
	"stack",
	"horizon",
	"blocks",
];

/** Motifs that read in one direction, so they are never mirrored. */
const UPRIGHT = new Set<ArtMotif>(["lines"]);

export interface ArtLayer {
	/** Size level, 1 (smallest) to 6 (largest). */
	level: number;
	accent: boolean;
	/** Stroke width that draws each segment as a dot of this level's size. */
	width: number;
	d: string;
}

export interface HalftoneArt {
	/** A short, ID-safe key derived from the seed. */
	key: string;
	motif: ArtMotif;
	width: number;
	height: number;
	layers: ArtLayer[];
	dotCount: number;
}

/** FNV-1a: a small, stable string hash. */
function hash(input: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Mulberry32: a seeded generator returning floats in [0, 1). */
function random(seed: number) {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const between = (rand: () => number, min: number, max: number) => min + rand() * (max - min);
const smoothstep = (edge0: number, edge1: number, value: number) => {
	const t = clamp((value - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

interface Sample {
	intensity: number;
	accent: boolean;
}

const BLANK: Sample = { intensity: 0, accent: false };

type Field = (x: number, y: number) => Sample;

/**
 * Each motif returns a field over x in [0, aspect] and y in [0, 1], so
 * distances are isotropic whatever the canvas's shape. `pitch` is the distance
 * between samples, which motifs use to put edges between rows of dots.
 */
function motifField(motif: ArtMotif, rand: () => number, aspect: number, pitch: number): Field {
	// Snap a coordinate to the centre of the nearest dot.
	const snap = (value: number) => (Math.floor(value / pitch) + 0.5) * pitch;
	switch (motif) {
		case "ripple": {
			const square = aspect < 1.3;
			const cx = snap(
				square
					? aspect * between(rand, 0.42, 0.58)
					: aspect * (rand() < 0.5 ? between(rand, 0.18, 0.32) : between(rand, 0.68, 0.82)),
			);
			const cy = snap(between(rand, 0.42, 0.58));
			const frequency = between(rand, 4.2, 5.4);
			const phase = between(rand, 0, 0.3);
			// At least two dots and a bit in radius, so the drop is round on a coarse grid too.
			const drop = Math.max(0.5 / frequency, 1.6 * pitch);
			return (x, y) => {
				const r = Math.hypot(x - cx, y - cy);
				// A ring of paper keeps the solid drop apart from the first ripple.
				if (r < drop) return { intensity: 1, accent: true };
				if (r < drop + pitch) return BLANK;
				const ring = 0.5 + 0.5 * Math.cos(TAU * (r * frequency - phase));
				const envelope = Math.exp(-r * 1.25);
				return { intensity: ring * (0.12 + 0.88 * envelope), accent: false };
			};
		}
		case "dash": {
			// An em dash in whole rows, so its edges are crisp, with a glow whose dots shrink away from it.
			const cx = aspect / 2;
			const cy = snap(between(rand, 0.48, 0.52));
			const half = aspect * between(rand, 0.2, 0.23);
			const halfRows = Math.max(0, Math.round(between(rand, 0.095, 0.1) / pitch - 0.5));
			const radius = (halfRows + 0.5) * pitch;
			const glow = between(rand, 3, 4) * pitch;
			return (x, y) => {
				const dx = Math.max(Math.abs(x - cx) - half, 0);
				const edge = Math.hypot(dx, y - cy) - radius;
				if (edge <= 0) return { intensity: 1, accent: true };
				if (edge >= glow) return BLANK;
				// Only the glow beside the dash is orange; the rest stays ink, so the dash is the one focal shape.
				return { intensity: 0.62 * (1 - edge / glow) ** 1.5, accent: false };
			};
		}
		case "sphere": {
			const radius = between(rand, 0.34, 0.38);
			const cx = aspect * between(rand, 0.46, 0.52);
			const cy = between(rand, 0.42, 0.48);
			const light = { x: -0.55, y: -0.6, z: 0.58 };
			return (x, y) => {
				const nx = (x - cx) / radius;
				const ny = (y - cy) / radius;
				const r2 = nx * nx + ny * ny;
				if (r2 > 1) {
					// A shadow cast to the lower right.
					const sx = (x - cx - radius * 0.45) / (radius * 1.2);
					const sy = (y - cy - radius * 0.8) / (radius * 0.42);
					return { intensity: Math.exp(-(sx * sx + sy * sy) * 1.4) * 0.42, accent: false };
				}
				const nz = Math.sqrt(1 - r2);
				// Dark where lit, like ink on paper: the highlight, where the light hits head on, has no dots.
				const lambert = clamp(nx * light.x + ny * light.y + nz * light.z);
				if (lambert > 0.97) return BLANK;
				return { intensity: 0.2 + 0.8 * (1 - lambert), accent: r2 > 0.66 && lambert < 0.3 };
			};
		}
		case "lines": {
			// Lines of text in an editor, a heading and a paragraph, with the caret after the last line.
			const rowOf = (value: number) => Math.round(value / pitch);
			const left = aspect * between(rand, 0.1, 0.16);
			const top = between(rand, 0.2, 0.26);
			const count = 4;
			const headingRows = Math.max(1, rowOf(0.075));
			const headingTop = rowOf(top) - Math.floor(headingRows / 2);
			const bodyTop = headingTop + headingRows + Math.max(1, rowOf(0.07));
			const leading = Math.max(2, rowOf(0.13));
			const lines = Array.from({ length: count }, (_, i) => {
				const heading = i === 0;
				const last = i === count - 1;
				const reach = heading
					? between(rand, 0.34, 0.48)
					: last
						? between(rand, 0.3, 0.46)
						: between(rand, 0.6, 0.78);
				const first = heading ? headingTop : bodyTop + (i - 1) * leading;
				return {
					first,
					last: heading ? first + headingRows - 1 : first,
					end: left + aspect * reach,
				};
			});
			const caretLine = lines[count - 1];
			const caretColumn = Math.floor((caretLine.end + aspect * 0.035) / pitch) + 1;
			return (x, y) => {
				const row = Math.floor(y / pitch);
				if (
					Math.floor(x / pitch) === caretColumn &&
					row >= caretLine.first - 1 &&
					row <= caretLine.last + 1
				) {
					return { intensity: 1, accent: true };
				}
				for (const line of lines) {
					if (row >= line.first && row <= line.last && x >= left && x <= line.end) {
						const progress = (x - left) / (line.end - left);
						return { intensity: 1 - 0.55 * smoothstep(0.35, 1, progress), accent: false };
					}
				}
				return BLANK;
			};
		}
		case "waveform": {
			// A waveform mirrored about the middle row; the centre bar is the accent.
			const totalColumns = Math.round(aspect / pitch);
			const step = Math.max(2, Math.round(0.09 / pitch));
			const count = Math.floor((totalColumns * 0.9 + 1) / step);
			const left = Math.round((totalColumns - (count * step - 1)) / 2);
			const middleRow = Math.round(0.5 / pitch - 0.5);
			const centreBar = Math.floor(count / 2);
			const swells = [0, 1].map(() => ({ frequency: between(rand, 7, 13), phase: rand() * TAU }));
			const loudness = (x: number) => {
				const t = (x - aspect / 2) / (aspect * 0.42);
				const wobble =
					0.5 +
					0.3 * Math.sin(swells[0].frequency * x + swells[0].phase) +
					0.2 * Math.sin(swells[1].frequency * x + swells[1].phase);
				return Math.exp(-((t / 0.62) ** 2)) * (0.55 + 0.45 * wobble);
			};
			return (x, y) => {
				const row = Math.floor(y / pitch);
				const column = Math.floor(x / pitch) - left;
				const inBar = column >= 0 && column < count * step - 1 && column % step !== step - 1;
				if (inBar) {
					const bar = Math.floor(column / step);
					const barX = (left + bar * step + (step - 1) / 2) * pitch;
					const accent = bar === centreBar;
					const reach = Math.round((0.04 + (accent ? 0.36 : 0.32 * loudness(barX))) / pitch);
					const offset = Math.abs(row - middleRow);
					if (offset <= reach) {
						return { intensity: 0.95 - 0.4 * (offset / Math.max(1, reach)), accent };
					}
				}
				if (row !== middleRow) return BLANK;
				return {
					intensity: 0.32 * smoothstep(aspect * 0.5, aspect * 0.3, Math.abs(x - aspect / 2)),
					accent: false,
				};
			};
		}
		case "stack": {
			// Three isometric layers; the middle one, slotted in, is the accent.
			const tones = [0.66, 0.9, 0.44];
			const slope = Math.tan(Math.PI / 6);
			const halfWidth = Math.min(aspect * 0.46, between(rand, 0.46, 0.5));
			const halfHeight = halfWidth * slope;
			const spacing = between(rand, 0.15, 0.17);
			const cx = aspect / 2;
			const top = 0.5 - spacing * ((tones.length - 1) / 2);
			const inside = (x: number, y: number, i: number) =>
				1 - Math.abs(x - cx) / halfWidth - Math.abs(y - (top + i * spacing)) / halfHeight;
			const gap = pitch / halfHeight;
			return (x, y) => {
				for (let i = 0; i < tones.length; i++) {
					const depth = inside(x, y, i);
					if (depth >= 0) {
						const front = clamp((y - (top + i * spacing)) / halfHeight / 2 + 0.5);
						return { intensity: tones[i] * (0.82 + 0.18 * front), accent: i === 1 };
					}
					if (depth > -gap) return BLANK;
				}
				return BLANK;
			};
		}
		case "horizon": {
			// A sun on the horizon in the accent colour above a rippled sea.
			const horizonRow = Math.round(between(rand, 0.6, 0.64) / pitch);
			const horizon = horizonRow * pitch;
			const radius = between(rand, 0.3, 0.34);
			const cx = aspect / 2;
			const cy = horizon + radius * between(rand, 0.05, 0.12);
			const sunHeight = radius - (cy - horizon);
			const glowWidth = 1.5 * pitch;
			const cuts = new Set([1, 3, 6].filter((above) => above * pitch < sunHeight * 0.55));
			const swell = rand() * TAU;
			const ripple = between(rand, 14, 20);
			return (x, y) => {
				const row = Math.floor(y / pitch);
				const r = Math.hypot(x - cx, y - cy);
				if (row < horizonRow) {
					if (r < radius + glowWidth) {
						if (cuts.has(horizonRow - row)) return BLANK;
						const inside = (radius - r) / pitch;
						if (inside >= -0.5) {
							return { intensity: 0.55 + 0.45 * clamp(inside + 0.5), accent: true };
						}
						return { intensity: 0.5 * (1 - (r - radius) / glowWidth) ** 1.4, accent: true };
					}
					const sky =
						0.32 * smoothstep(radius * 1.12, radius * 2.4, r) * (0.55 + 0.45 * (1 - y / horizon));
					return { intensity: sky, accent: false };
				}
				if (row === horizonRow) return { intensity: 0.72, accent: false };
				const below = row - horizonRow;
				const depth = clamp((y - horizon) / (1 - horizon));
				const strength = below % 2 === 0 ? 1 : 0.55;
				const wave = 0.55 + 0.45 * Math.sin(ripple * x + below * 2.39 + swell);
				return { intensity: (0.2 + 0.5 * depth) * strength * wave, accent: false };
			};
		}
		case "blocks": {
			// A two-by-two grid of modules, the way plugins slot into a site; one module is the accent.
			const totalColumns = Math.round(aspect / pitch);
			const totalRows = Math.round(1 / pitch);
			const tile = Math.max(
				2,
				Math.round(Math.min(totalColumns, totalRows) * between(rand, 0.3, 0.34)),
			);
			const gapCells = Math.max(1, Math.round(tile / 4));
			const span = 2 * tile + gapCells;
			const left = Math.floor((totalColumns - span) / 2);
			const top = Math.floor((totalRows - span) / 2);
			const accentTile = Math.floor(rand() * 4);
			const tones = Array.from({ length: 4 }, () => between(rand, 0.4, 0.8));
			return (x, y) => {
				const column = Math.floor(x / pitch) - left;
				const row = Math.floor(y / pitch) - top;
				if (column < 0 || row < 0 || column >= span || row >= span) return BLANK;
				const inX = column < tile ? column : column - tile - gapCells;
				const inY = row < tile ? row : row - tile - gapCells;
				if (inX < 0 || inY < 0) return BLANK;
				const index = (row < tile ? 0 : 2) + (column < tile ? 0 : 1);
				if (index === accentTile) return { intensity: 1, accent: true };
				// Each grey module shades toward one corner, like a lit tile.
				const shade = 0.75 + 0.25 * ((inX + inY) / Math.max(1, 2 * (tile - 1)));
				const corner =
					tile > 3 && (inX === 0 || inX === tile - 1) && (inY === 0 || inY === tile - 1);
				return { intensity: tones[index] * shade * (corner ? 0.55 : 1), accent: false };
			};
		}
	}
}

/** Builds halftone art for a seed on a grid. Empty size and tone combinations are omitted. */
export function halftoneArt(seed: string, grid: ArtGrid): HalftoneArt {
	const { columns, rows, levels: diameters, threshold } = grid;
	const seedHash = hash(seed);
	const rand = random(seedHash);
	// The hash's low bits depend only on the low bits of each character, so the
	// motif comes from the generator rather than `seedHash % count`.
	const motif = MOTIFS[Math.floor(rand() * MOTIFS.length)];
	const aspect = columns / rows;
	const field = motifField(motif, rand, aspect, aspect / columns);
	const mirror = !UPRIGHT.has(motif) && rand() < 0.5;

	const levels = diameters.length;
	const paths: string[] = Array.from<string>({ length: levels * 2 }).fill("");
	// Each path's pen position, so every dot after the first is a short relative move.
	const pens: ({ x: number; y: number } | undefined)[] = Array.from({ length: levels * 2 });
	let dotCount = 0;
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const u = (column + 0.5) / columns;
			const x = (mirror ? 1 - u : u) * aspect;
			const y = (row + 0.5) / rows;
			const { intensity, accent } = field(x, y);
			const value = clamp(intensity);
			if (value < threshold) continue;
			const level = Math.min(
				levels - 1,
				Math.floor(((value - threshold) / (1 - threshold)) * levels),
			);
			const index = (accent ? levels : 0) + level;
			const cx = column * ART_CELL + ART_CELL / 2;
			const cy = row * ART_CELL + ART_CELL / 2;
			const pen = pens[index];
			paths[index] += pen ? `m${cx - pen.x} ${cy - pen.y}h0` : `M${cx} ${cy}h0`;
			pens[index] = { x: cx, y: cy };
			dotCount++;
		}
	}

	return {
		key: seedHash.toString(36),
		motif,
		width: columns * ART_CELL,
		height: rows * ART_CELL,
		layers: paths.flatMap((d, index) =>
			d
				? [
						{
							level: (index % levels) + 1,
							accent: index >= levels,
							width: Math.round(diameters[index % levels] * ART_CELL * 100) / 100,
							d,
						},
					]
				: [],
		),
		dotCount,
	};
}

export function pluginArt(seed: string, variant: ArtVariant): HalftoneArt {
	return halftoneArt(seed, ART_GRIDS[variant]);
}

/** The seed for a plugin's art: stable across handle changes, unique per package. */
export function pluginArtSeed(plugin: { did: string; slug: string }): string {
	return `${plugin.did}/${plugin.slug}`;
}
