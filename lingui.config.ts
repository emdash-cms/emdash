import type { LinguiConfig } from "@lingui/conf";

import { LOCALE_CODES, SOURCE_LOCALE } from "./packages/admin/src/locales/locales.js";

const config: LinguiConfig = {
	sourceLocale: SOURCE_LOCALE.code,
	locales: LOCALE_CODES,
	// Compile the "pseudo" locale catalog with garbled characters so unwrapped
	// strings are immediately visible when EMDASH_PSEUDO_LOCALE=1 is set in dev.
	pseudoLocale: "pseudo",
	catalogs: [
		{
			path: "<rootDir>/packages/admin/src/locales/{locale}/messages",
			include: ["<rootDir>/packages/admin/src/**/*.{ts,tsx}"],
		},
	],
	format: "po",
};

export default config;
