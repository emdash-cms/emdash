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
<<<<<<< i18n/eu
	locales: [
		{
			label: "Deutsch",
			lang: "de",
		},
		{
			label: "Français",
			lang: "fr",
		},
		{
			label: "Euskara",
			lang: "eu",
		},
	],
=======
	locales: TARGET_LOCALES.map((l) => ({
		label: l.label,
		lang: l.code,
	})) as [{ label: string; lang: string }, ...{ label: string; lang: string }[]],
>>>>>>> main
	files: [
		{
			include: ["packages/admin/src/locales/en/messages.po"],
			pattern: "packages/admin/src/locales/@lang/messages.po",
			type: "dictionary",
		},
	],
});
