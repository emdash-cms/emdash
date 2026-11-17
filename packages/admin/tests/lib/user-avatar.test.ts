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
		["01JBQ8Z6X3K9M2N4P5R7S8T0VW", { palette: "Rose", wave: 3, angle: -5, mirrored: true }],
		["user_1", { palette: "Iris", wave: 4, angle: -6, mirrored: true }],
		["dev-admin", { palette: "Twilight", wave: 6, angle: 0, mirrored: false }],
		["01HZY3B7C9D2E4F6G8H0J1K2L3", { palette: "Twilight", wave: 5, angle: 9, mirrored: false }],
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

function luminance(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
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
});
