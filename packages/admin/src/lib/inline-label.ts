/**
 * A collection or taxonomy label as it reads inside a sentence of the admin locale.
 * German capitalizes every noun, so it keeps the label as written; other locales lowercase it.
 */
export function inlineLabel(label: string, locale: string): string {
	return locale.split("-")[0] === "de" ? label : label.toLowerCase();
}
