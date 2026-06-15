// Investigate workflow.
//
// Triggered from .github/workflows/investigate.yml when a maintainer
// adds `bot:repro` to an issue (or via workflow_dispatch on retry).
// Drives a four-stage pipeline over an EmDash checkout:
//
//   1. Classify -- decide kind/area/requiresBrowser. Bail early for
//      non-bug kinds.
//   2. Reproduce -- run one of three sub-skills based on area:
//      repro-api (no browser), repro-admin (agent-browser + dev bypass),
//      or repro-public (agent-browser against the public site). Skips
//      cleanly when the bug requires external data or production-only
//      conditions.
//   3. Diagnose -- read the code paths that explain the reproduction
//      and rate confidence.
//   4. Verify -- decide whether the diagnosed behaviour is actually a
//      bug or intended. Gates the fix stage.
//   5. Fix -- runs when verify=='bug', diagnose.confidence!='low', and
//      diagnose.fixApproach!='needs-design-decision'. Runs on a cheaper
//      model in its own session (the reasoning is already done; it
//      implements diagnose's proposedFix). Writes the change, runs the
//      reproduce test, the broader package tests, typecheck, lint,
//      format. Stages but does not commit -- the YAML orchestrator does.
//
// Every stage uses session.skill() with a valibot result schema. The
// orchestrator (the GH Actions workflow) reads the final JSON via jq
// and decides which label to apply and what to comment.
//
// The agent uses local() so its bash tool has real pnpm/git/gh/node/
// agent-browser on $PATH. AGENT_GH_TOKEN (read-only) is the only token
// passed into the sandbox env. The orchestrator's app token lives in
// the workflow YAML and never crosses into this agent process.

import { writeFileSync } from "node:fs";

import { createAgent, type FlueContext } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { issueClassificationSchema, type IssueClassification } from "../lib/classifier.js";
// Skill imports. Each is bundled as a SkillReference by the Flue build
// and works the same on Node (this workflow runs on GH Actions) or
// Cloudflare (not used today, but the workflow is portable).
import diagnose from "../skills/diagnose/SKILL.md" with { type: "skill" };
import fix from "../skills/fix/SKILL.md" with { type: "skill" };
import reproAdmin from "../skills/repro-admin/SKILL.md" with { type: "skill" };
import reproApi from "../skills/repro-api/SKILL.md" with { type: "skill" };
import reproPublic from "../skills/repro-public/SKILL.md" with { type: "skill" };
import verify from "../skills/verify/SKILL.md" with { type: "skill" };

// ---------- Payload + result schemas ----------

interface InvestigatePayload {
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
	owner: string;
	repo: string;
	/** Reporter feedback from a previous attempt, when re-triggered. */
	retryContext?: string;
	/**
	 * A maintainer's authoritative implementation directive, when the run
	 * was triggered by `maintainer-reply.yml`. Its presence overrides the
	 * fix gate: the maintainer has made the design call diagnose deferred,
	 * so the fix stage runs even on a `needs-design-decision`. The produced
	 * fix then flows through the orchestrator's normal `awaiting-reporter`
	 * loop -- the directive changes whether a fix is attempted, not what
	 * happens to it afterwards.
	 */
	maintainerDirective?: string;
}

const reproduceResultSchema = v.object({
	reproduced: v.boolean(),
	skipped: v.boolean(),
	approach: v.picklist([
		"failing-test",
		"repro-script",
		"pnpm-command",
		"agent-browser-only",
		"none",
	]),
	notes: v.pipe(v.string(), v.minLength(10), v.maxLength(6000)),
	screenshots: v.array(
		v.object({
			// Filename is interpolated into a markdown image URL
			// (https://raw.githubusercontent.com/.../<filename>) and
			// must not contain characters that would break out of the
			// `![desc](url)` syntax or path-traverse on the artifacts
			// branch. The schema enforces a tight allowlist; the
			// orchestrator validates again before rendering.
			filename: v.pipe(
				v.string(),
				v.minLength(1),
				v.maxLength(80),
				v.regex(/^[a-zA-Z0-9._-]+$/, "filename must be [a-zA-Z0-9._-]+"),
			),
			// Description is interpolated as the alt text in
			// `![desc](url)`. It is rendered as text, not parsed as
			// markdown, but unescaped `]` could close the alt-text
			// span and let the rest of the description leak into the
			// surrounding comment. Cap the length and let the YAML
			// MD-escape the residual.
			description: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
		}),
	),
});
type ReproduceResult = v.InferOutput<typeof reproduceResultSchema>;

// `confidence` rates certainty in the *root cause* (have we found the
// code responsible?). `fixApproach` rates clarity of the *fix*, an
// independent axis -- a bug can have an unambiguous cause but a fix
// shape that needs a maintainer's design call, or a clearly-correct
// fix that happens to be larger than one line. The old single-axis
// `high` rating conflated the two and starved the fix stage of real,
// fixable bugs (see issues #1178, #1199). `as const` preserves the
// literal unions under valibot's inference, same reason as verify.
const diagnoseResultSchema = v.object({
	rootCause: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
	confidence: v.picklist(["high", "medium", "low"] as const),
	fixApproach: v.picklist(["mechanical", "clear-best-option", "needs-design-decision"] as const),
	// Always populated: the concrete change to make (mechanical /
	// clear-best-option) or the options a maintainer must choose
	// between (needs-design-decision). Fed into the fix stage as its
	// target, and surfaced in the maintainer comment when fix defers.
	proposedFix: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
	hypothesisNotes: v.pipe(v.string(), v.maxLength(2000)),
});
type DiagnoseResult = v.InferOutput<typeof diagnoseResultSchema>;

// `as const` on the picklist preserves the literal union under
// valibot's `InferOutput` inference. Without it, oxlint's type-aware
// pass collapses `VerifyResult["verdict"]` to `any`, which then
// poisons the union in `InvestigateResult["verdict"]`.
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
 * Flat result returned from `run()`. The orchestrator's bash uses
 * `jq` against this -- flat top-level booleans are easier to branch
 * on than nested objects, so we hoist the gating fields out of their
 * stage results. Stage details remain available under their named
 * keys for inclusion in the comment.
 */
interface InvestigateResult {
	// Gating fields the orchestrator reads to pick a label/outcome.
	skipped: boolean;
	reproduced: boolean;
	fixed: boolean;
	verdict: VerifyResult["verdict"] | "";
	// Headline strings the orchestrator may interpolate into the comment.
	reason: string;
	attempts: string;
	notes: string;
	// Detailed stage outputs, kept for comment composition + debugging.
	classification: IssueClassification;
	reproduce?: ReproduceResult;
	diagnose?: DiagnoseResult;
	verify?: VerifyResult;
	fix?: FixResult;
	// Things the YAML needs to push branches.
	screenshots: ReproduceResult["screenshots"];
	commitMessage: string;
	filesChanged: string[];
}

// ---------- Agents ----------

// Classifier: cheap kimi call on the default in-memory sandbox. It has
// no access to the EmDash checkout and so cannot read AGENTS.md for repo
// context. Inline a short primer here so it can map issues to the
// correct `area` instead of guessing. Without it, kimi spends most of
// its budget reasoning about what EmDash is and where a bug lives.
const classifierAgent = createAgent(() => ({
	model: "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
	instructions: [
		"You classify GitHub issues for the EmDash CMS investigation bot. Output strictly matches the requested schema.",
		"",
		"EmDash is an Astro-native CMS that runs on Cloudflare (D1 + R2 + Workers) or Node + SQLite. Map the `area` field as follows:",
		"- admin: the React admin SPA mounted at `/_emdash/admin/*` -- the content editor, dashboards, settings, and any authoring UI. The post/page editor (rich text, code blocks, media pickers, field inputs) is admin.",
		"- public: the rendered public site a visitor sees -- Astro pages outside `/_emdash`, SSR output, routing, sitemap, RSS, image rendering.",
		"- api: the `/_emdash/api/*` HTTP routes and their handlers (REST, auth, content CRUD) when the bug is in the request/response, not a UI.",
		"- migration: database migrations or schema changes.",
		"- build: building, bundling, packaging, or type generation.",
		"- other: anything that does not fit the above.",
		"",
		"requiresBrowser is true for admin and public bugs (they need a real browser to reproduce) and false otherwise.",
	].join("\n"),
}));

// Shared local() sandbox config. Both the investigator and the fix
// agent run shell commands against the same EmDash checkout, so they
// use identical sandbox settings -- cwd pinned to GITHUB_WORKSPACE (so
// skill resolution and bash land in the checkout, not in .flue/) and a
// read-only GH token. Because both sandboxes point at the same cwd,
// edits the fix agent stages on disk are exactly what the orchestrator
// later commits, even though fix runs in its own session.
function investigateSandbox(cwd: string) {
	return local({
		cwd,
		env: {
			// Read-only token. The agent can clone and read issues; it
			// cannot comment, label, or push. The orchestrator owns
			// every write.
			GH_TOKEN: process.env.AGENT_GH_TOKEN,
			CI: "true",
			NODE_ENV: "test",
			// Used by bgproc when the repro-admin or repro-public skill
			// boots `pnpm dev`. Standard Node convention.
			NODE_OPTIONS: process.env.NODE_OPTIONS,
		},
	});
}

// Investigator: opus + local() sandbox. Runs the reasoning-heavy
// stages -- reproduce, diagnose, verify. The fix stage runs on a
// separate, cheaper agent (below), so fix is intentionally NOT in this
// agent's skill set.
const investigatorAgent = createAgent(() => {
	const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
	return {
		model: process.env.FLUE_INVESTIGATE_MODEL ?? "cloudflare-ai-gateway/claude-opus-4-7",
		cwd,
		sandbox: investigateSandbox(cwd),
		instructions: [
			"You are EmDash's investigation bot.",
			"You walk the reasoning stages (reproduce -> diagnose -> verify) on one GitHub issue at a time.",
			"You return read-only on GitHub: no comments, no labels, no branch pushes. The orchestrator does all writes after you finish.",
			"At every stage you obey the skill's hard prohibitions and produce strictly schema-conformant output.",
			"When you guess, say you guessed; when you skip, say why.",
		].join(" "),
		skills: [reproApi, reproAdmin, reproPublic, diagnose, verify],
	};
});

// Fix implementer: a cheaper coding model (Kimi K2.7 Code) is enough here because the
// expensive reasoning is already done -- diagnose hands over a concrete
// `proposedFix`, and this stage only runs for `mechanical` /
// `clear-best-option` approaches. Its job is guided implementation:
// write the change, make the reproduce test pass, run lint / typecheck
// / format, and `git add`. It runs in its own session (fresh context,
// fed the diagnosis explicitly via args) with the same local() sandbox
// so it has real pnpm / git / gh on PATH and the EmDash checkout as cwd.
const fixAgent = createAgent(() => {
	const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
	return {
		model:
			process.env.FLUE_FIX_MODEL ??
			"cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code",
		cwd,
		sandbox: investigateSandbox(cwd),
		instructions: [
			"You are EmDash's fix implementer.",
			"Diagnose has already found the root cause and written a proposed fix; your job is to implement that plan, not to re-investigate from scratch.",
			"You return read-only on GitHub: no comments, no labels, no commits, no branch pushes. You stage changes with `git add` and stop; the orchestrator commits and pushes.",
			"Obey the fix skill's hard prohibitions and produce strictly schema-conformant output.",
			"If reading the code convinces you the proposed fix is wrong, abandon with `fixed: false` and explain why in notes rather than forcing a change you don't believe in.",
		].join(" "),
		skills: [fix],
	};
});

// ---------- Stage helpers ----------

/**
 * Build the issue context block that every stage prompt starts with.
 * Includes retry context when present so the agent knows what reporter
 * feedback motivated this re-run.
 */
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

/** Pick the reproduce skill based on classification.area. */
function pickReproduceSkill(area: IssueClassification["area"]) {
	switch (area) {
		case "admin":
			return reproAdmin;
		case "public":
			return reproPublic;
		default:
			// api, migration, build, other -- all go via repro-api (no browser).
			return reproApi;
	}
}

// ---------- run() ----------

/**
 * Persist the structured result to a file so the GitHub Actions
 * orchestrator can read it directly. `flue run` interleaves build-log
 * lines on stdout and pretty-prints the returned result, so scraping
 * the result back out of stdout is fragile. Writing the assembled
 * result object to a known path makes the handoff deterministic.
 *
 * The path comes from `INVESTIGATE_RESULT_PATH` (set by the workflow);
 * when it is unset -- local prototyping via run-local.ts -- we skip the
 * write and rely on the returned value. Only a clean completion writes
 * the file; a thrown error leaves no file, which the orchestrator
 * treats as a failed run.
 */
export async function run(ctx: FlueContext<InvestigatePayload>): Promise<InvestigateResult> {
	const result = await runImpl(ctx);
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

async function runImpl({
	init,
	payload,
	log,
}: FlueContext<InvestigatePayload>): Promise<InvestigateResult> {
	if (!payload.issueNumber || !payload.issueTitle) {
		throw new Error("payload requires issueNumber and issueTitle");
	}
	if (!process.env.AGENT_GH_TOKEN) {
		throw new Error("AGENT_GH_TOKEN required (read-only token for the sandbox)");
	}

	// A maintainer directive overrides the bot's *judgment* gates -- the
	// human has already decided this is worth fixing and how. It does NOT
	// override the *capability* gates (can we reproduce it? did the fix
	// hold?): those bail honestly so the maintainer learns the directive
	// couldn't be carried out rather than getting a silent no-op.
	const directed = Boolean(payload.maintainerDirective);

	// --- Stage 0: classify ---

	const classifierHarness = await init(classifierAgent, { name: "classify" });
	const classifierSession = await classifierHarness.session();
	const { data: classification } = await classifierSession.prompt(
		[
			"Classify the following EmDash issue.",
			"",
			issueContext(payload),
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
		{ result: issueClassificationSchema },
	);
	log.info("classified", { issueNumber: payload.issueNumber, ...classification });

	if (classification.kind !== "bug" && !directed) {
		return {
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
		};
	}

	// --- Stage 1: reproduce ---

	const investigatorHarness = await init(investigatorAgent);
	const investigatorSession = await investigatorHarness.session();

	const reproduceSkill = pickReproduceSkill(classification.area);
	const { data: reproduce } = await investigatorSession.skill(reproduceSkill, {
		args: {
			issueContext: issueContext(payload),
			classification,
		},
		result: reproduceResultSchema,
	});
	log.info("reproduce", {
		issueNumber: payload.issueNumber,
		reproduced: reproduce.reproduced,
		skipped: reproduce.skipped,
		approach: reproduce.approach,
	});

	if (reproduce.skipped) {
		return {
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
		};
	}

	// --- Stage 2: diagnose (runs even if reproduce failed; the body alone
	// is often enough to point at the code path, with lower confidence). ---

	const { data: diagnoseOut } = await investigatorSession.skill(diagnose, {
		args: {
			issueContext: issueContext(payload),
			classification,
			reproduce,
		},
		result: diagnoseResultSchema,
	});
	log.info("diagnose", {
		issueNumber: payload.issueNumber,
		confidence: diagnoseOut.confidence,
	});

	// --- Stage 3: verify ---

	const { data: verifyOut } = await investigatorSession.skill(verify, {
		args: {
			issueContext: issueContext(payload),
			classification,
			diagnose: diagnoseOut,
		},
		result: verifyResultSchema,
	});
	log.info("verify", { issueNumber: payload.issueNumber, verdict: verifyOut.verdict });

	if (verifyOut.verdict === "intended-behavior" && !directed) {
		return {
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
		};
	}

	if (!reproduce.reproduced) {
		return {
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
		};
	}

	// --- Stage 4: fix (conditional) ---
	//
	// Gate on two independent axes, not the old single `confidence ===
	// "high"`:
	//   - verify says it's a bug,
	//   - diagnose pinned the root cause with at least medium confidence
	//     (a `low` cause is too shaky to write code against), and
	//   - the fix is `mechanical` or `clear-best-option` -- i.e. there
	//     is a correct change to make that doesn't require a maintainer's
	//     design call.
	// `needs-design-decision` defers to a human even when the cause is
	// certain (e.g. the fix needs a new public API or a component that
	// doesn't exist yet).
	//
	// A maintainer directive overrides the gate entirely (see `directed`
	// above): the human has made the design call diagnose deferred, asserted
	// it's worth fixing, and asked for an implementation. We reach this point
	// only past the `!reproduce.reproduced` early return, so a directed fix is
	// always verified against a live reproduction. The fix agent abandons with
	// `fixed: false` if the directive turns out wrong.
	const shouldFix =
		directed ||
		(verifyOut.verdict === "bug" &&
			diagnoseOut.confidence !== "low" &&
			diagnoseOut.fixApproach !== "needs-design-decision");

	if (!shouldFix) {
		// Explain precisely why no fix was attempted, since the reason
		// now varies (unclear verdict / shaky cause / design decision).
		const notAttemptedReason =
			verifyOut.verdict !== "bug"
				? "The bot could not conclusively confirm this is a bug (`unclear` verdict), so it did not attempt an automated fix."
				: diagnoseOut.confidence === "low"
					? "The root cause is not pinned down with enough confidence to write a fix against it."
					: "The fix needs a design decision a maintainer should make, so the bot did not attempt it automatically. The proposed options are above.";
		return {
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
		};
	}

	// Fix runs on its own (cheaper) agent and a fresh session. It is fed
	// the diagnosis -- including the concrete `proposedFix` -- via args,
	// and operates on the same on-disk checkout, so its staged edits are
	// what the orchestrator commits.
	const fixHarness = await init(fixAgent, { name: "fix" });
	const fixSession = await fixHarness.session();
	const { data: fixOut } = await fixSession.skill(fix, {
		args: {
			issueContext: issueContext(payload),
			classification,
			reproduce,
			diagnose: diagnoseOut,
		},
		result: fixResultSchema,
	});
	log.info("fix", { issueNumber: payload.issueNumber, fixed: fixOut.fixed });

	if (!fixOut.fixed) {
		return {
			skipped: false,
			reproduced: true,
			fixed: false,
			verdict: verifyOut.verdict,
			reason: "",
			attempts: "",
			notes: [
				`**Root cause:** ${diagnoseOut.rootCause}`,
				"",
				`**Fix attempt abandoned:** ${fixOut.notes}`,
			].join("\n"),
			classification,
			reproduce,
			diagnose: diagnoseOut,
			verify: verifyOut,
			fix: fixOut,
			screenshots: reproduce.screenshots,
			commitMessage: "",
			filesChanged: [],
		};
	}

	return {
		skipped: false,
		reproduced: true,
		fixed: true,
		verdict: verifyOut.verdict,
		reason: "",
		attempts: "",
		notes: [
			`**Root cause:** ${diagnoseOut.rootCause}`,
			"",
			`**Fix applied:** ${fixOut.notes}`,
		].join("\n"),
		classification,
		reproduce,
		diagnose: diagnoseOut,
		verify: verifyOut,
		fix: fixOut,
		screenshots: reproduce.screenshots,
		commitMessage: fixOut.commitMessage,
		filesChanged: fixOut.filesChanged,
	};
}
