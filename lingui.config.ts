import type { LinguiConfig } from "@lingui/conf";

const config: LinguiConfig = {
	sourceLocale: "en",
	locales: ["en", "de", "fr", "pt-BR"],
	catalogs: [
		{
			path: "<rootDir>/packages/admin/src/locales/{locale}/messages",
			include: ["<rootDir>/packages/admin/src/**/*.{ts,tsx}"],
		},
	],
	format: "po",
};

export default config;
