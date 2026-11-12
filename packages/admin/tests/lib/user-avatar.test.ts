import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import {
	USER_AVATAR_PALETTES,
	USER_AVATAR_WAVES,
	mixHex,
	userAvatarInitials,
	userAvatarVariant,
} from "../../src/lib/user-avatar.js";

describe("userAvatarInitials", () => {
	it.each([
		["Noah Pham", ["N", "P"]],
		["María José de la Cruz", ["M", "C"]],
		["Prince", ["P"]],
		["Jean-Luc Picard", ["J", "P"]],
		["Иван Петров", ["И", "П"]],
		["陈伟", ["陈"]],
		["نوح فام", ["ن"]],
		["3M Company", ["3"]],
		["🚀 Rocket Team", ["R", "T"]],
		["Noah 陈伟", ["N", "陈"]],
		["  ada   lovelace  ", ["A", "L"]],
	])("%s", (name, expected) => {
		expect(userAvatarInitials(name)).toEqual(expected);
	});

	it.each([null, undefined, "", "   ", "!!! ---", "🚀 ✨"])("shows no letters for %j", (name) => {
		expect(userAvatarInitials(name)).toEqual([]);
	});

	it("uppercases Turkish i and ı the same in every admin language", () => {
		const previous = i18n.locale;
		i18n.loadAndActivate({ locale: "tr", messages: {} });
		try {
			expect(userAvatarInitials("ilker ışık")).toEqual(["I", "I"]);
		} finally {
			if (previous) i18n.activate(previous);
		}
	});
});

describe("userAvatarVariant", () => {
	function describeVariant(id: string) {
		const v = userAvatarVariant(id);
		return {
			palette: USER_AVATAR_PALETTES[v.palette]?.name,
			wave: v.wave + 1,
			angle: v.angle,
			mirrored: v.mirrored,
		};
	}

	it.each([
		["01JBQ8Z6X3K9M2N4P5R7S8T0VW", { palette: "Lagoon", wave: 3, angle: -5, mirrored: true }],
		["user_1", { palette: "Apricot", wave: 4, angle: -6, mirrored: true }],
		["dev-admin", { palette: "Indigo", wave: 6, angle: 0, mirrored: false }],
		["01HZY3B7C9D2E4F6G8H0J1K2L3", { palette: "Meadow", wave: 5, angle: 9, mirrored: false }],
	])("gives %s the same avatar as before", (id, expected) => {
		expect(describeVariant(id)).toEqual(expected);
	});

	it("reaches every palette and wave across 1,000 users", () => {
		const palettes = new Set<number>();
		const waves = new Set<number>();
		for (let i = 0; i < 1000; i++) {
			const v = userAvatarVariant(`user-${i}`);
			palettes.add(v.palette);
			waves.add(v.wave);
		}
		expect(palettes.size).toBe(USER_AVATAR_PALETTES.length);
		expect(waves.size).toBe(USER_AVATAR_WAVES.length);
	});
});

function linear(hex: string): number[] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
}

function luminance(hex: string): number {
	const [r, g, b] = linear(hex);
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function oklab(hex: string): number[] {
	const [r, g, b] = linear(hex) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

describe("palettes", () => {
	it.each(USER_AVATAR_PALETTES.map((p) => [p.name, p] as const))(
		"keeps white initials at 3:1 or more on %s",
		(_name, palette) => {
			const behindInitials = mixHex(palette.top, palette.bottom, 0.85);
			const ratio = 1.05 / (luminance(behindInitials) + 0.05);
			expect(ratio).toBeGreaterThanOrEqual(3);
		},
	);

	it("keeps every two palettes' colors apart, so people sharing a room rarely look alike", () => {
		const close: string[] = [];
		USER_AVATAR_PALETTES.forEach((a, i) => {
			for (const b of USER_AVATAR_PALETTES.slice(i + 1)) {
				const [x, y] = [oklab(a.bottom), oklab(b.bottom)];
				const distance = Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
				if (distance < 0.07) close.push(`${a.name}/${b.name} ${distance.toFixed(3)}`);
			}
		});
		expect(close).toEqual([]);
	});
});
