const MEDIA_USAGE_TRIGGER =
	/^CREATE TRIGGER(?: IF NOT EXISTS)? "emdash_mu_[0-9a-f]{32}_(?:ad|ai|au)"/i;
const MEDIA_USAGE_TRIGGER_NAME = /emdash_mu_[0-9a-f]{32}_(ad|ai|au)/gi;
const ULID_LITERAL = /'[0-7][0-9A-HJKMNP-TV-Z]{25}'/g;

// Query snapshots describe query shape. Media-usage trigger DDL embeds the
// collection ULID and a hash derived from it, so fresh fixture databases
// otherwise produce a different snapshot even when the SQL shape is unchanged.
export function normalizeSql(sql) {
	const normalized = sql
		.replace(/\s+/g, " ")
		.replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "in (...)")
		.trim();

	if (!MEDIA_USAGE_TRIGGER.test(normalized)) return normalized;

	return normalized
		.replace(MEDIA_USAGE_TRIGGER_NAME, "emdash_mu_<collection>_$1")
		.replace(ULID_LITERAL, "'<collection-id>'");
}
