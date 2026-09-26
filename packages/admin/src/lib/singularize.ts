/**
 * Naive English singularization, for filling in a singular name nobody typed.
 *
 * Handles the common plural endings and nothing else; the user can overwrite a
 * wrong guess.
 */

const IES_SUFFIX = /ies$/;
const SIBILANT_ES_SUFFIX = /(ss|x|ch|sh)es$/;
const PLURAL_S_SUFFIX = /(?<!s)s$/;

export function singularize(value: string): string {
	if (IES_SUFFIX.test(value)) return value.replace(IES_SUFFIX, "y");
	if (SIBILANT_ES_SUFFIX.test(value)) return value.replace(SIBILANT_ES_SUFFIX, "$1");
	if (PLURAL_S_SUFFIX.test(value)) return value.replace(PLURAL_S_SUFFIX, "");
	return value;
}
