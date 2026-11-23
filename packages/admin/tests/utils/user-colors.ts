import { USER_AVATAR_PALETTES, userAvatarVariant } from "../../src/lib/user-avatar";

const paletteOf = (id: string) => userAvatarVariant(id).palette;

function findIds(): { perPalette: string[]; sharing: [string, string] } {
	const perPalette: string[] = [];
	let sharing: [string, string] | null = null;
	for (
		let n = 0;
		perPalette.filter(Boolean).length < USER_AVATAR_PALETTES.length || !sharing;
		n++
	) {
		const id = `person-${n}`;
		const first = perPalette[paletteOf(id)];
		if (first === undefined) perPalette[paletteOf(id)] = id;
		else sharing ??= [first, id];
	}
	return { perPalette, sharing };
}

const ids = findIds();

/** A user id whose avatar has each palette, in palette order. */
export const ONE_USER_PER_PALETTE: readonly string[] = ids.perPalette;

/** Two user ids whose avatars have the same palette. */
export const USERS_SHARING_A_PALETTE: readonly [string, string] = ids.sharing;

/** A user id whose avatar's palette differs from `id`'s. */
export function userWithAnotherPalette(id: string): string {
	return ONE_USER_PER_PALETTE.find((other) => paletteOf(other) !== paletteOf(id))!;
}

/** CSS colors painted one over another, bottom first, as 8-bit sRGB, through a canvas so any color syntax works. */
export function srgb(...layers: string[]): [number, number, number] {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d")!;
	for (const color of layers) {
		context.fillStyle = color;
		context.fillRect(0, 0, 1, 1);
	}
	const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
	return [red!, green!, blue!];
}

/** The WCAG contrast of two opaque 8-bit sRGB colors. */
export function contrast(a: readonly number[], b: readonly number[]): number {
	const luminance = (rgb: readonly number[]) => {
		const [red, green, blue] = rgb.map((value) => {
			const channel = value / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
	};
	const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return (high! + 0.05) / (low! + 0.05);
}
