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
//   5. Fix -- only when verify=='bug' AND diagnose.confidence=='high'.
//      Writes the change, runs the reproduce test, runs the broader
//      package tests, typecheck, lint, format. Stages but does not
//      commit -- the YAML orchestrator does that.
//
// Every stage uses session.skill() with a valibot result schema. The
// orchestrator (the GH Actions workflow) reads the final JSON via jq
// and decides which label to apply and what to comment.
//
// The agent uses local() so its bash tool has real pnpm/git/gh/node/
// agent-browser on $PATH. AGENT_GH_TOKEN (read-only) is the only token
// passed into the sandbox env. The orchestrator's app token lives in
// the workflow YAML and never crosses into this agent process.

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
}

const reproduceResultSchema = v.object({
	reproduced: v.boolean(),
	skipped: v.boolean(),
	approach: v.picklist([
		"failing-test",
		"repro-script",
		"pnpm-command",
		"playwright-test",
		"agent-browser-only",
		"none",
	]),
	notes: v.pipe(v.string(), v.minLength(10), v.maxLength(6000)),
	screenshots: v.array(
		v.object({
			filename: v.string(),
			description: v.string(),
		}),
	),
});
type ReproduceResult = v.InferOutput<typeof reproduceResultSchema>;

const diagnoseResultSchema = v.object({
	rootCause: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)),
	confidence: v.picklist(["high", "medium", "low"]),
	hypothesisNotes: v.pipe(v.string(), v.maxLength(2000)),
});
type DiagnoseResult = v.InferOutput<typeof diagnoseResultSchema>;

const verifyResultSchema = v.object({
	verdict: v.picklist(["bug", "intended-behavior", "unclear"]),
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

// Classifier: cheap, no sandbox needed.
const classifierAgent = createAgent(() => ({
	model: "cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
	instructions:
		"You classify GitHub issues for the EmDash CMS investigation bot. Output strictly matches the requested schema.",
}));

// Investigator: opus + local() sandbox + the six stage skills registered.
// The sandbox cwd is pinned to GITHUB_WORKSPACE so skill resolution and
// shell commands land in the EmDash checkout, not in .flue/.
const investigatorAgent = createAgent(() => {
	const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
	return {
		model: process.env.FLUE_INVESTIGATE_MODEL ?? "cloudflare-ai-gateway/claude-opus-4-7",
		cwd,
		sandbox: local({
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
		}),
		instructions: [
			"You are EmDash's investigation bot.",
			"You walk a four-stage pipeline (reproduce -> diagnose -> verify -> fix) on one GitHub issue at a time.",
			"You return read-only on GitHub: no comments, no labels, no branch pushes. The orchestrator does all writes after you finish.",
			"At every stage you obey the skill's hard prohibitions and produce strictly schema-conformant output.",
			"When you guess, say you guessed; when you skip, say why.",
		].join(" "),
		skills: [reproApi, reproAdmin, reproPublic, diagnose, verify, fix],
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

export async function run({
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

	if (classification.kind !== "bug") {
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

	if (verifyOut.verdict === "intended-behavior") {
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

	// --- Stage 4: fix (gated on bug verdict + high diagnose confidence) ---

	const shouldFix = verifyOut.verdict === "bug" && diagnoseOut.confidence === "high";

	if (!shouldFix) {
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
				diagnoseOut.confidence === "high"
					? ""
					: `**Hypotheses considered:** ${diagnoseOut.hypothesisNotes}`,
				"",
				`**Verdict:** \`${verifyOut.verdict}\` — ${verifyOut.reasoning}`,
				"",
				"The bot reproduced the bug but did not attempt a fix. The fix stage requires `verdict: bug` AND `confidence: high`.",
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

	const { data: fixOut } = await investigatorSession.skill(fix, {
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
