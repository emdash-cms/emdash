// Result schema for the Flue PR reviewer.
//
// The agent returns this structured shape. A separate GitHub Actions
// orchestrator reads it and posts the review with a write-scoped token; the
// agent itself never writes to GitHub. Keeping the shape flat and close to the
// GitHub review API (path/line/side + a free-form markdown body) means the
// orchestrator can map findings to review comments with almost no translation.

import * as v from "valibot";

export const reviewResultSchema = v.object({
	verdict: v.pipe(
		v.picklist(["approve", "comment", "request_changes"]),
		v.description(
			"approve: you would sign off / LGTM, no blocking issues. comment: non-blocking findings only (the default when you found things). request_changes: reserve for true blockers (security, data loss, a build/test break this PR introduces, or a backwards-incompatibility that violates the post-pre-release stability rule).",
		),
	),
	summary: v.pipe(
		v.string(),
		v.maxLength(8000),
		v.description(
			"Overall review summary in GitHub-flavored markdown, posted as the review body. State what you checked and the headline conclusion. If you found nothing to fix, say so explicitly.",
		),
	),
	findings: v.pipe(
		v.array(
			v.object({
				path: v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(400),
					v.description("Repo-relative file path the comment anchors to."),
				),
				line: v.pipe(
					v.number(),
					v.integer(),
					v.minValue(1),
					v.description("Line number to anchor on (the end line for a multi-line range)."),
				),
				startLine: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.description("Start line for a multi-line range. Omit for a single-line comment."),
					),
				),
				side: v.pipe(
					v.picklist(["LEFT", "RIGHT"]),
					v.description("RIGHT for added or changed lines, LEFT for deleted lines."),
				),
				severity: v.pipe(
					v.picklist(["needs_fixing", "suggestion"]),
					v.description(
						"needs_fixing: logic bug, regression, security issue, broken contract, missing required test, or AGENTS.md convention violation. suggestion: style, minor refactor, nice-to-have, or low-confidence observation.",
					),
				),
				body: v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(6000),
					v.description(
						"The line comment in markdown. State what the code currently does and why it is wrong, and cite the line. Use a ```suggestion block when the fix is a clean inline replacement.",
					),
				),
			}),
		),
		v.description("Line-anchored findings. Empty when the PR is clean."),
	),
});

export type ReviewResult = v.InferOutput<typeof reviewResultSchema>;
