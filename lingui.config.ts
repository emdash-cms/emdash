import type { LinguiConfig } from "@lingui/conf";

import { LOCALE_CODES, SOURCE_LOCALE } from "./packages/admin/src/locales/locales.js";

const config: LinguiConfig = {
<<<<<<< i18n/eu
	sourceLocale: "en",
	locales: ["en", "de", "fr", "pt-BR", "eu"],
=======
	sourceLocale: SOURCE_LOCALE.code,
	locales: LOCALE_CODES,
>>>>>>> main
	catalogs: [
		{
			path: "<rootDir>/packages/admin/src/locales/{locale}/messages",
			include: ["<rootDir>/packages/admin/src/**/*.{ts,tsx}"],
		},
	],
	format: "po",
};

export default config;
