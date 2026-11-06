/**
 * Whether a flag the command does not declare is on. citty hands such a flag
 * over uncoerced (`true`, or the text after `=`), so this applies the rule it
 * uses for a declared boolean: any value except `false` turns it on.
 */
export function isFlagSet(value: unknown): boolean {
	return value !== undefined && value !== false && value !== "false";
}
