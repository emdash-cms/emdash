// translation-scope.mjs -- which files a translation PR may change.

const TRANSLATION_CATALOG = /^packages\/admin\/src\/locales\/[^/]+\/messages\.po$/;
const CHANGESET = /^\.changeset\/[^/]+\.md$/;
const LOCALE_REGISTRATION = new Set([
	"packages/admin/src/locales/locales.ts",
	"packages/admin/src/locales/day-picker.ts",
]);

export function isTranslationCatalog(path) {
	return TRANSLATION_CATALOG.test(path);
}

function isTranslationFile(path) {
	return isTranslationCatalog(path) || CHANGESET.test(path) || LOCALE_REGISTRATION.has(path);
}

// The files that don't belong in a PR that changes a translation catalog, or an
// empty list when no catalog changed.
export function unexpectedTranslationFiles(paths) {
	if (!paths.some(isTranslationCatalog)) return [];
	return paths.filter((path) => !isTranslationFile(path));
}
