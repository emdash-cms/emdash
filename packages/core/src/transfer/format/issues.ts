/**
 * Schema issues reduced to what may be reported about package content: a
 * fixed message per issue code and, at most, the top-level property the issue
 * concerns when the schema declares that property. Zod's own messages, custom
 * refinement messages, and deeper paths can quote unknown keys, record keys,
 * and values from the package.
 */

import type { z } from "zod";

export interface SchemaIssueSummary {
	/** A top-level property the schema declares, or "" */
	path: string;
	message: string;
}

const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
	invalid_type: "Wrong type",
	unrecognized_keys: "Unknown property",
	invalid_key: "Invalid key",
	invalid_element: "Invalid element",
	invalid_union: "Matches no allowed shape",
	invalid_value: "Value is not allowed",
	invalid_format: "Invalid format",
	too_big: "Too large",
	too_small: "Too small",
	not_multiple_of: "Not an allowed multiple",
};

export function summarizeSchemaIssue(
	issue: z.core.$ZodIssue,
	shape: Readonly<Record<string, unknown>>,
): SchemaIssueSummary {
	const first = issue.path[0];
	return {
		path: typeof first === "string" && Object.hasOwn(shape, first) ? first : "",
		message: ISSUE_MESSAGES[issue.code] ?? "Failed validation",
	};
}
