// Investigate workflow (Flue 1.0).
//
// Triggered from .github/workflows/investigate-run.yml (the executor backend)
// via `flue run investigate --input '{...}'` on a GitHub Actions runner, which
// is the only environment with the toolchain (pnpm/git/agent-browser/a real
// browser) the reproduce + fix stages need. Drives a five-stage pipeline over
// an EmDash checkout:
//
//   0. Classify -- decide kind/area/requiresBrowser. Bail early for non-bug
//      kinds (unless a maintainer directive overrides).
//   1. Reproduce -- one of three sub-skills based on area.
//   2. Diagnose -- read the code paths that explain the reproduction.
//   3. Verify -- decide whether the behaviour is actually a bug.
//   4. Fix -- runs when verify=='bug', diagnose.confidence!='low', and
//      diagnose.fixApproach!='needs-design-decision' (or a directive forces it).
//
// FLUE 1.0 MIGRATION NOTES
// A `defineWorkflow` binds exactly one agent, and `ActionContext` exposes only
// { harness, input, log } -- there is no `init()` to spin up extra agents. The
// old three-agent design (classifier / investigator / fix) collapses onto one
// workflow agent (the investigator) plus:
//   - a separate `classify` session with a per-operation model override (cheap
//     kimi) for stage 0, and
//   - a separate `fix` session with a per-operation model override (cheaper
//     coding model) for stage 4.
// Separate sessions give each stage a fresh conversation; the model override
// gives it the right model; the shared harness gives the fix stage the same
// on-disk checkout, so its staged edits are exactly what the orchestrator
// commits. The agent is still read-only on GitHub: the orchestrator does every
// write after the run.

import { writeFileSync } from "node:fs";

import { defineAgent, defineWorkflow } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { withCapacityRetry } from "../lib/capacity.js";
import { issueClassificationSchema, type IssueClassification } from "../lib/classifier.js";
import diagnose from "../skills/diagnose/SKILL.md" with { type: "skill" };
import fix from "../skills/fix/SKILL.md" with { type: "skill" };
import reproAdmin from "../skills/repro-admin/SKILL.md" with { type: "skill" };
import reproApi from "../skills/repro-api/SKILL.md" with { type: "skill" };
import reproPublic from "../skills/repro-public/SKILL.md" with { type: "skill" };
import verify from "../skills/verify/SKILL.md" with { type: "skill" };

// ---------- Models (env-overridable) ----------

const INVESTIGATE_MODEL =
	process.env.FLUE_INVESTIGATE_MODEL ?? "cloudflare-ai-gateway/claude-opus-4-7";
const CLASSIFIER_MODEL =
	process.env.FLUE_CLASSIFIER_MODEL ?? "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code";
const FIX_MODEL =
	process.env.FLUE_FIX_MODEL ?? "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code";

// ---------- Payload + result schemas ----------

const investigatePayloadSchema = v.object({
	issueNumber: v.number(),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
	owner: v.string(),
	repo: v.string(),
	/** Reporter feedback from a previous attempt, when re-triggered. */
	retryContext: v.optional(v.string()),
	/**
	 * A maintainer's authoritative implementation directive. Its presence
	 * overrides the *judgment* gates (is it a bug? worth fixing?) so the fix
	 * stage runs even on `needs-design-decision`. It does NOT override the
	 * *capability* gates (can we reproduce it? did the fix hold?).
	 */
	maintainerDirective: v.optional(v.string()),
});
type InvestigatePayload = v.InferOutput<typeof investigatePayloadSchema>;

const reproduceResultSchema = v.object({
	reproduced: v.boolean(),
	skipped: v.boolean(),
	approach: v.picklist(["failing-test", "repro-script", "pnpm-command", "agent-browser-only", "none"]),
	notes: v.pipe(v.string(), v.minLength(10), v.maxLength(6000)),
	screenshots: v.array(
		v.object({
			filename: v.pipe(
				v.string(),
				v.minLength(1),
				v.maxLength(80),
				v.regex(/^[a-zA-Z0-9._-]+$/, "filename must be [a-zA-Z0-9._-]+"),
			),
			description: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
		}),
	),
});
type ReproduceResult = v.InferOutput<typeof reproduceResultSchema>;

const diagnoseResultSchema = v.object({
	rootCause: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
	confidence: v.picklist(["high", "medium", "low"] as const),
	fixApproach: v.picklist(["mechanical", "clear-best-option", "needs-design-decision"] as const),
	proposedFix: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
	hypothesisNotes: v.pipe(v.string(), v.maxLength(2000)),
});
type DiagnoseResult = v.InferOutput<typeof diagnoseResultSchema>;

const verifyResultSchema = v.object({
	verdict: v.picklist(["bug", "intended-behavior", "unclear"] as const),
	reasoning: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
});
type VerifyResult = v.InferOutput<typeof verifyResultSchema>;

const fixResultSchema = v.object({
	fixed: v.boolean(),
	commitMessage: v.pipe(v.string(), v.minLength(10), v.maxLength(200)),
	filesChanged: v.array(v.string()),
	testStillPasses: v.boolean(),
	notes: v.pipe(v.string(), v.maxLength(2000)),
});
type FixResult = v.InferOutput<typeof fixResultSchema>;

/**
 * Flat result the orchestrator reads via `jq`. Gating fields are hoisted to the
 * top level so the GitHub Actions executor can branch on them without walking
 * nested objects; stage details remain under named keys for comment composition.
 */
interface InvestigateResult {
	skipped: boolean;
	reproduced: boolean;
	fixed: boolean;
	verdict: VerifyResult["verdict"] | "";
	reason: string;
	attempts: string;
	notes: string;
	classification: IssueClassification;
	reproduce?: ReproduceResult;
	diagnose?: DiagnoseResult;
	verify?: VerifyResult;
	fix?: FixResult;
	screenshots: ReproduceResult["screenshots"];
	commitMessage: string;
	filesChanged: string[];
}

// ---------- Agent ----------

// One workflow agent: the investigator. opus + a `local()` sandbox so its bash
// tool has real pnpm/git/gh/node/agent-browser on PATH, cwd pinned to the
// runner checkout, and a read-only GH token (the orchestrator owns every
// write). All five skills are registered; the workflow drives them explicitly
// via `session.skill(...)`. The fix skill runs on its own session with a
// cheaper model override (see run()).
const investigatorAgent = defineAgent(() => {
	const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
	return {
		model: INVESTIGATE_MODEL,
		cwd,
		sandbox: local({
			env: {
				// Read-only token: the agent can clone and read issues; it cannot
				// comment, label, or push. The orchestrator owns every write.
				GH_TOKEN: process.env.AGENT_GH_TOKEN,
				CI: "true",
				NODE_ENV: "test",
				NODE_OPTIONS: process.env.NODE_OPTIONS,
			},
		}),
		instructions: [
			"You are EmDash's investigation bot.",
			"You walk the reasoning stages (reproduce -> diagnose -> verify) on one GitHub issue at a time, and implement a fix only when explicitly directed to via the fix skill.",
			"You return read-only on GitHub: no comments, no labels, no branch pushes. The orchestrator does all writes after you finish.",
			"At every stage you obey the skill's hard prohibitions and produce strictly schema-conformant output.",
			"When you guess, say you guessed; when you skip, say why.",
		].join(" "),
		skills: [reproApi, reproAdmin, reproPublic, diagnose, verify, fix],
	};
});

// ---------- Helpers ----------

function issueContext(payload: InvestigatePayload): string {
	const parts = [
		`Issue #${payload.issueNumber}: ${payload.issueTitle}`,
		"",
		"## Body",
		"",
		payload.issueBody || "(no body)",
	];
	if (payload.retryContext) {
		parts.push(
			"",
			"## Reporter feedback from a previous attempt",
			"",
			payload.retryContext,
			"",
			"Treat the above as new information. Do not repeat the same approach that produced the failed previous attempt.",
		);
	}
	if (payload.maintainerDirective) {
		parts.push(
			"",
			"## Maintainer directive (authoritative)",
			"",
			payload.maintainerDirective,
			"",
			"A maintainer has decided how this should be fixed. Implement the directive above. It overrides any earlier suggestion that this needs a design decision -- the decision has been made. If reading the code convinces you the directive is mistaken, abandon with `fixed: false` and explain why rather than forcing a change you don't believe in.",
		);
	}
	return parts.join("\n");
}

function pickReproduceSkill(area: IssueClassification["area"]) {
	switch (area) {
		case "admin":
			return reproAdmin;
		case "public":
			return reproPublic;
		default:
			return reproApi;
	}
}

/**
 * Short EmDash primer for the classifier. In the old design this lived in a
 * dedicated classifier agent's instructions; with one workflow agent the
 * classify step runs on a separate session, so the primer moves into the
 * prompt. Without it the cheap model wastes budget guessing what EmDash is.
 */
const CLASSIFIER_PRIMER = [
	"EmDash is an Astro-native CMS that runs on Cloudflare (D1 + R2 + Workers) or Node + SQLite. Map the `area` field as follows:",
	"- admin: the React admin SPA at `/_emdash/admin/*` -- editor, dashboards, settings, authoring UI. The post/page editor (rich text, code blocks, media pickers, field inputs) is admin.",
	"- public: the rendered public site -- Astro pages outside `/_emdash`, SSR output, routing, sitemap, RSS, image rendering.",
	"- api: the `/_emdash/api/*` HTTP routes and handlers (REST, auth, content CRUD) when the bug is in the request/response, not a UI.",
	"- migration: database migrations or schema changes.",
	"- build: building, bundling, packaging, or type generation.",
	"- other: anything that does not fit the above.",
	"",
	"requiresBrowser is true for admin and public bugs (they need a real browser to reproduce) and false otherwise.",
].join("\n");

function persistResult(result: InvestigateResult): InvestigateResult {
	const path = process.env.INVESTIGATE_RESULT_PATH;
	if (path) {
		try {
			writeFileSync(path, JSON.stringify(result));
		} catch (error) {
			console.error("[investigate] failed to write result file:", error);
		}
	}
	return result;
}

// ---------- Workflow ----------

export default defineWorkflow({
	agent: investigatorAgent,
	input: investigatePayloadSchema,
	// The result is a flat, JSON-serializable object the executor reads via jq.
	// A passthrough output schema keeps Flue's run-record snapshot intact without
	// re-describing the (large, optional-heavy) InvestigateResult shape here; the
	// authoritative contract is the TypeScript interface above.
	output: v.any(),
	async run({ harness, input, log }) {
		if (!process.env.AGENT_GH_TOKEN) {
			throw new Error("AGENT_GH_TOKEN required (read-only token for the sandbox)");
		}

		// A maintainer directive overrides the bot's *judgment* gates, not its
		// *capability* gates (reproduce / fix-held), which still bail honestly.
		const directed = Boolean(input.maintainerDirective);

		// Every model-bearing stage goes through this: it bounds each attempt with
		// a hard timeout (so a stalled Workers AI call fails loudly instead of
		// hanging the run) and retries genuine capacity (429) errors with backoff.
		// The kimi-backed classify and fix stages are the most exposed to 429s.
		const withRetry = <T>(
			label: string,
			fn: (signal: AbortSignal) => PromiseLike<T>,
			perAttemptTimeoutMs: number,
		): Promise<T> =>
			withCapacityRetry(fn, {
				label: `${label}#${input.issueNumber}`,
				attempts: 3,
				perAttemptTimeoutMs,
				onRetry: ({ attempt, delayMs, error }) =>
					log.warn?.(`${label}: model over capacity, backing off`, {
						issueNumber: input.issueNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			});

		// --- Stage 0: classify (separate session + cheap model override) ---
		const classifySession = await harness.session("classify");
		const { data: classification } = await withRetry(
			"classify",
			(signal) =>
				classifySession.prompt(
					[
						CLASSIFIER_PRIMER,
						"",
						"Classify the following EmDash issue.",
						"",
						issueContext(input),
						"",
						"## Decide",
						"",
						"- kind: bug | enhancement | documentation | question",
						"- area: api | admin | public | migration | build | other",
						"- requiresBrowser: true for admin/public bugs, false otherwise",
						"- summary: one factual sentence describing the reported behaviour",
						"",
						"Return strictly the requested schema. No prose outside it.",
					].join("\n"),
					{ model: CLASSIFIER_MODEL, result: issueClassificationSchema, signal },
				),
			90_000,
		);
		log.info("classified", { issueNumber: input.issueNumber, ...classification });

		if (classification.kind !== "bug" && !directed) {
			return persistResult({
				skipped: true,
				reproduced: false,
				fixed: false,
				verdict: "",
				reason: `Issue classified as \`${classification.kind}\`, not a bug. The investigation pipeline only runs on bug reports.`,
				attempts: "",
				notes: "",
				classification,
				screenshots: [],
				commitMessage: "",
				filesChanged: [],
			});
		}

		// --- Stage 1: reproduce (default session) ---
		const session = await harness.session();
		const reproduceSkill = pickReproduceSkill(classification.area);
		const { data: reproduce } = await withRetry(
			"reproduce",
			(signal) =>
				session.skill(reproduceSkill, {
					args: { issueContext: issueContext(input), classification },
					result: reproduceResultSchema,
					signal,
				}),
			12 * 60_000,
		);
		log.info("reproduce", {
			issueNumber: input.issueNumber,
			reproduced: reproduce.reproduced,
			skipped: reproduce.skipped,
			approach: reproduce.approach,
		});

		if (reproduce.skipped) {
			return persistResult({
				skipped: true,
				reproduced: false,
				fixed: false,
				verdict: "",
				reason: reproduce.notes,
				attempts: "",
				notes: reproduce.notes,
				classification,
				reproduce,
				screenshots: reproduce.screenshots,
				commitMessage: "",
				filesChanged: [],
			});
		}

		// --- Stage 2: diagnose ---
		const { data: diagnoseOut } = await withRetry(
			"diagnose",
			(signal) =>
				session.skill(diagnose, {
					args: { issueContext: issueContext(input), classification, reproduce },
					result: diagnoseResultSchema,
					signal,
				}),
			12 * 60_000,
		);
		log.info("diagnose", { issueNumber: input.issueNumber, confidence: diagnoseOut.confidence });

		// --- Stage 3: verify ---
		const { data: verifyOut } = await withRetry(
			"verify",
			(signal) =>
				session.skill(verify, {
					args: { issueContext: issueContext(input), classification, diagnose: diagnoseOut },
					result: verifyResultSchema,
					signal,
				}),
			12 * 60_000,
		);
		log.info("verify", { issueNumber: input.issueNumber, verdict: verifyOut.verdict });

		if (verifyOut.verdict === "intended-behavior" && !directed) {
			return persistResult({
				skipped: false,
				reproduced: reproduce.reproduced,
				fixed: false,
				verdict: "intended-behavior",
				reason: "",
				attempts: "",
				notes: verifyOut.reasoning,
				classification,
				reproduce,
				diagnose: diagnoseOut,
				verify: verifyOut,
				screenshots: reproduce.screenshots,
				commitMessage: "",
				filesChanged: [],
			});
		}

		if (!reproduce.reproduced) {
			return persistResult({
				skipped: false,
				reproduced: false,
				fixed: false,
				verdict: verifyOut.verdict,
				reason: "",
				attempts: reproduce.notes,
				notes: diagnoseOut.rootCause,
				classification,
				reproduce,
				diagnose: diagnoseOut,
				verify: verifyOut,
				screenshots: reproduce.screenshots,
				commitMessage: "",
				filesChanged: [],
			});
		}

		// --- Stage 4: fix (conditional) ---
		const shouldFix =
			directed ||
			(verifyOut.verdict === "bug" &&
				diagnoseOut.confidence !== "low" &&
				diagnoseOut.fixApproach !== "needs-design-decision");

		if (!shouldFix) {
			const notAttemptedReason =
				verifyOut.verdict !== "bug"
					? "The bot could not conclusively confirm this is a bug (`unclear` verdict), so it did not attempt an automated fix."
					: diagnoseOut.confidence === "low"
						? "The root cause is not pinned down with enough confidence to write a fix against it."
						: "The fix needs a design decision a maintainer should make, so the bot did not attempt it automatically. The proposed options are above.";
			return persistResult({
				skipped: false,
				reproduced: true,
				fixed: false,
				verdict: verifyOut.verdict,
				reason: "",
				attempts: "",
				notes: [
					`**Root cause (\`${diagnoseOut.confidence}\` confidence):** ${diagnoseOut.rootCause}`,
					"",
					`**Proposed fix:** ${diagnoseOut.proposedFix}`,
					"",
					diagnoseOut.hypothesisNotes
						? `**Alternative causes considered:** ${diagnoseOut.hypothesisNotes}`
						: "",
					"",
					`**Verdict:** \`${verifyOut.verdict}\` — ${verifyOut.reasoning}`,
					"",
					notAttemptedReason,
				]
					.filter(Boolean)
					.join("\n"),
				classification,
				reproduce,
				diagnose: diagnoseOut,
				verify: verifyOut,
				screenshots: reproduce.screenshots,
				commitMessage: "",
				filesChanged: [],
			});
		}

		// Fix runs on its own session (fresh context) with a cheaper model
		// override, against the same on-disk checkout, so its staged edits are
		// what the orchestrator commits.
		const fixSession = await harness.session("fix");
		const { data: fixOut } = await withRetry(
			"fix",
			(signal) =>
				fixSession.skill(fix, {
					args: { issueContext: issueContext(input), classification, reproduce, diagnose: diagnoseOut },
					model: FIX_MODEL,
					result: fixResultSchema,
					signal,
				}),
			12 * 60_000,
		);
		log.info("fix", { issueNumber: input.issueNumber, fixed: fixOut.fixed });

		if (!fixOut.fixed) {
			return persistResult({
				skipped: false,
				reproduced: true,
				fixed: false,
				verdict: verifyOut.verdict,
				reason: "",
				attempts: "",
				notes: [`**Root cause:** ${diagnoseOut.rootCause}`, "", `**Fix attempt abandoned:** ${fixOut.notes}`].join("\n"),
				classification,
				reproduce,
				diagnose: diagnoseOut,
				verify: verifyOut,
				fix: fixOut,
				screenshots: reproduce.screenshots,
				commitMessage: "",
				filesChanged: [],
			});
		}

		return persistResult({
			skipped: false,
			reproduced: true,
			fixed: true,
			verdict: verifyOut.verdict,
			reason: "",
			attempts: "",
			notes: [`**Root cause:** ${diagnoseOut.rootCause}`, "", `**Fix applied:** ${fixOut.notes}`].join("\n"),
			classification,
			reproduce,
			diagnose: diagnoseOut,
			verify: verifyOut,
			fix: fixOut,
			screenshots: reproduce.screenshots,
			commitMessage: fixOut.commitMessage,
			filesChanged: fixOut.filesChanged,
		});
	},
});
