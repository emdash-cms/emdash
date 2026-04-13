import { defineConfig } from "@lunariajs/core/config";

export default defineConfig({
	repository: {
		name: "emdash-cms/emdash",
		branch: "main",
	},
	sourceLocale: {
		label: "English",
		lang: "en",
	},
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
	files: [
		{
			include: ["packages/admin/src/locales/en/messages.po"],
			pattern: "packages/admin/src/locales/@lang/messages.po",
			type: "dictionary",
		},
	],
});
