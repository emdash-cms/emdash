import { defineConfig } from "@lunariajs/core/config";

import { SOURCE_LOCALE, TARGET_LOCALES } from "./packages/admin/src/locales/locales.js";

export default defineConfig({
	repository: {
		name: "emdash-cms/emdash",
		branch: "main",
	},
	sourceLocale: {
		label: SOURCE_LOCALE.label,
		lang: SOURCE_LOCALE.code,
	},
	// Lunaria requires a non-empty tuple; TARGET_LOCALES is authored with 10+ entries.
	/* eslint-disable typescript-eslint(no-unsafe-type-assertion) -- non-empty by construction (see packages/admin/src/locales/locales.ts) */
	locales: TARGET_LOCALES.map((l) => ({
		label: l.label,
		lang: l.code,
	})) as [{ label: string; lang: string }, ...{ label: string; lang: string }[]],
	/* eslint-enable typescript-eslint(no-unsafe-type-assertion) */
	files: [
		{
			include: ["packages/admin/src/locales/en/messages.po"],
			pattern: "packages/admin/src/locales/@lang/messages.po",
			type: "dictionary",
		},
	],
});
