export default {
	sourceLocale: "en",
	locales: ["en"],
	catalogs: [
		{
			path: "<rootDir>/src/admin/locales/{locale}/messages",
			include: ["<rootDir>/src/admin/**/*.{ts,tsx}"],
		},
	],
	format: "po",
};
