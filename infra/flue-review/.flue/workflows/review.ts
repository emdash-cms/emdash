// Review workflow (Cloudflare target) -- cf-shell (Cloudflare Shell) variant.
//
// Reviews one pull request and returns structured findings plus a verdict. No
// firecracker container: the PR is hydrated into a durable cf-shell Workspace
// (DO SQLite + R2 for large files) via JS git, and the agent inspects it with a
// Worker-Loader-backed `code` tool. It does NOT post to GitHub: the workflow's
// trusted Action code posts with a write-scoped installation token, so no
// secret is ever reachable by the model.
//
// @flue 1.0 workflow model: the agent (execution policy + sandbox) is defined
// with `defineAgent`, and the finite behavior is an inline Action bound with
// `defineWorkflow`. The Action's `run` receives `{ harness, log, input }` --
// deliberately NOT platform bindings -- so env-scoped work (repo hydration,
// GitHub auth) reads the bindings back through `getCloudflareContext()`. The
// Workspace is keyed by the Durable Object identity so the sandbox built in the
// agent initializer and the clone performed in the Action target the exact same
// DO SQLite + R2 namespace.

import {
	defineAgent,
	defineWorkflow,
	type ActionContext,
	type WorkflowRouteHandler,
} from "@flue/runtime";
import { getCloudflareContext, getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import * as v from "valibot";

import { withCapacityRetry } from "../lib/capacity.js";
import {
	readAppCreds,
	mintInstallationToken,
	fetchUnifiedDiff,
	fetchPullRequestHeadSha,
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
	updateReviewCheck,
} from "../lib/github.js";
import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
import {
	getReviewWatchdog,
	type ReviewStage,
	type ReviewTerminal,
} from "../lib/review-watchdog.js";
import { getDefaultWorkspace, getShellSandbox } from "../sandboxes/cloudflare-shell.js";
import review from "../skills/review/SKILL.md" with { type: "skill" };

const reviewPayloadSchema = v.object({
	prNumber: v.number(),
	prTitle: v.string(),
	prBody: v.string(),
	headRef: v.string(),
	// Optional only so persisted pre-observability runs remain readable; run() fails closed without them.
	headSha: v.optional(v.string()),
	baseRef: v.string(),
	baseSha: v.optional(v.string()),
	owner: v.string(),
	repo: v.string(),
	attemptId: v.optional(v.string()),
	expectedRunId: v.optional(v.string()),
	deliveryId: v.optional(v.string()),
	checkRunId: v.optional(v.number()),
});

type ReviewPayload = v.InferOutput<typeof reviewPayloadSchema>;

const REPO_DIR = "/repo";
const DIFF_PATH = `${REPO_DIR}/.flue-pr.diff`;
const HYDRATED = `${REPO_DIR}/.flue-hydrated`;

const NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;
const SHA = /^[0-9a-f]{40}$/i;

function assertSafe(payload: ReviewPayload): void {
	if (!Number.isInteger(payload.prNumber) || payload.prNumber <= 0) {
		throw new Error("payload.prNumber must be a positive integer");
	}
	if (!payload.prTitle) throw new Error("payload.prTitle is required");
	for (const [key, value] of [
		["owner", payload.owner],
		["repo", payload.repo],
	] as const) {
		if (!value || !NAME.test(value)) throw new Error(`payload.${key} missing or unsafe`);
	}
	for (const [key, value] of [
		["baseRef", payload.baseRef],
		["headRef", payload.headRef],
	] as const) {
		if (!value || !REF.test(value) || value.includes("..")) {
			throw new Error(`payload.${key} missing or not a safe git ref`);
		}
	}
	for (const [key, value] of [
		["baseSha", payload.baseSha],
		["headSha", payload.headSha],
	] as const) {
		if (value !== undefined && !SHA.test(value))
			throw new Error(`payload.${key} is not a full SHA`);
	}
}

// Stable per-run Workspace name shared by the agent initializer (sandbox) and
// the Action (clone). Both run inside the same workflow-run Durable Object and
// therefore share one DO SqlStorage regardless of this name -- SQLite isolation
// comes from the per-run DO, not the name. The name only keys the R2 large-file
// spill prefix (r2://<name>/...) and observability, so the two call sites must
// derive it identically, otherwise the sandbox and the clone would look for
// spilled git objects under different prefixes. The DO id is a run-unique,
// retry-stable key (same runId -> same DO).
function workspaceName(): string {
	return `review-${getDurableObjectIdentity().id}`;
}

function workflowRunId(): string {
	return getDurableObjectIdentity().name;
}

// The agent: execution policy (model, reasoning effort) plus the cf-shell
// sandbox built from the platform bindings. Repo hydration cannot live here --
// the initializer has no access to the PR payload -- so it moves into the
// Action's `run` below, which shares this sandbox via the same Workspace name.
const reviewAgent = defineAgent<Env>(({ env }) => {
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, workspaceName());
	return {
		// Kimi K2.7 Code via the Workers AI binding: no model API key needed.
		model: "cloudflare/@cf/moonshotai/kimi-k2.7-code",
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		cwd: REPO_DIR,
		instructions: [
			"You are EmDash's automated pull request reviewer.",
			"You investigate one PR in depth and return structured, line-anchored findings plus an overall verdict.",
			"You inspect the checked-out repo with the `code` tool (JavaScript over `state.*`); there is no shell.",
			"You are read-only: no posting. The orchestrator posts your review after you finish.",
			"Follow the review skill's protocol exactly and return strictly schema-conformant output.",
		].join(" "),
		skills: [review],
	};
});

function buildPrContext(payload: ReviewPayload, priorReview?: string): string {
	const lines = [
		`PR #${payload.prNumber} in ${payload.owner}/${payload.repo}.`,
		`Head ref: ${payload.headRef}. Base branch: ${payload.baseRef}.`,
		`The repo is checked out at the PR head under ${REPO_DIR}. The unified diff is at ${DIFF_PATH}.`,
		`Title: ${payload.prTitle}`,
		"",
		"## Description",
		"",
		payload.prBody || "(no description provided)",
	];
	if (priorReview) {
		lines.push("", "## Prior review context (this is a re-review)", "", priorReview);
	}
	return lines.join("\n");
}

// Temporary hydration diagnostics (2026-08-08 review-stall incident): brackets
// every stage so a hang shows as a start line with no matching end line. R2
// operations are instrumented in the shared getDefaultWorkspace. Remove once
// the stall is diagnosed.
function hydrateStep(payload: ReviewPayload, step: string, startedAt: number): void {
	console.log(
		JSON.stringify({
			message: "hydrate step",
			step,
			ms: Date.now() - startedAt,
			attemptId: payload.attemptId,
			prNumber: payload.prNumber,
		}),
	);
}

// Untar a gzip'd GitHub tarball stream into the workspace under `destDir`,
// stripping the archive's single top-level directory. Handles ustar regular
// files, directories, symlinks, GNU longname ('L') and pax ('x') path
// overrides. Entries are processed incrementally; only one entry's content is
// buffered at a time.
async function untarInto(
	workspace: ReturnType<typeof getDefaultWorkspace>,
	stream: ReadableStream<Uint8Array>,
	destDir: string,
): Promise<{ files: number; bytes: number }> {
	const decoder = new TextDecoder();
	let buffer = new Uint8Array(0);
	let files = 0;
	let bytes = 0;
	let pendingLongName: string | undefined;
	let pendingPaxPath: string | undefined;
	const dirsMade = new Set<string>();

	const append = (chunk: Uint8Array) => {
		const next = new Uint8Array(buffer.length + chunk.length);
		next.set(buffer, 0);
		next.set(chunk, buffer.length);
		buffer = next;
	};
	const readCString = (view: Uint8Array): string => {
		const end = view.indexOf(0);
		return decoder.decode(end === -1 ? view : view.subarray(0, end));
	};
	const stripRoot = (name: string): string | undefined => {
		const slash = name.indexOf("/");
		if (slash === -1) return undefined;
		const rest = name.slice(slash + 1);
		return rest.length > 0 ? rest : undefined;
	};
	const ensureDir = async (path: string) => {
		if (dirsMade.has(path)) return;
		await workspace.mkdir(path, { recursive: true });
		dirsMade.add(path);
	};
	const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

	const reader = stream.getReader();
	let done = false;
	const need = async (n: number): Promise<boolean> => {
		while (buffer.length < n && !done) {
			const r = await reader.read();
			if (r.done) done = true;
			else append(r.value);
		}
		return buffer.length >= n;
	};

	while (await need(512)) {
		const header = buffer.subarray(0, 512);
		buffer = buffer.subarray(512);
		// Two consecutive zero blocks terminate the archive.
		if (header.every((b) => b === 0)) break;

		const rawName = readCString(header.subarray(0, 100));
		const prefix = readCString(header.subarray(345, 500));
		const size = parseInt(readCString(header.subarray(124, 136)).trim() || "0", 8);
		// Mode bytes (100-108) are ignored: the Workspace has no chmod and the
		// reviewer never executes files.
		const type = String.fromCharCode(header[156] ?? 48);
		const linkTarget = readCString(header.subarray(157, 257));

		const padded = Math.ceil(size / 512) * 512;
		if (!(await need(padded)) && size > 0) {
			throw new Error(`tar truncated: needed ${padded} bytes for entry ${rawName}`);
		}
		const content = buffer.subarray(0, size);
		buffer = buffer.subarray(Math.min(padded, buffer.length));

		if (type === "L") {
			pendingLongName = readCString(content);
			continue;
		}
		if (type === "x" || type === "g") {
			// pax records: "<len> key=value\n"
			const text = decoder.decode(content);
			for (const line of text.split("\n")) {
				const eq = line.indexOf("=");
				if (eq > 0 && line.slice(line.indexOf(" ") + 1, eq) === "path") {
					pendingPaxPath = line.slice(eq + 1);
				}
			}
			continue;
		}

		const fullName =
			pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
		pendingLongName = undefined;
		pendingPaxPath = undefined;

		const relative = stripRoot(fullName);
		if (!relative) continue;
		const dest = `${destDir}/${relative}`;

		if (type === "5") {
			await ensureDir(dest);
		} else if (type === "2") {
			await ensureDir(parentOf(dest));
			await workspace.symlink(linkTarget, dest);
		} else if (type === "0" || type === "\0" || type === "7") {
			await ensureDir(parentOf(dest));
			// Copy out of the rolling buffer: content is a subarray view.
			await workspace.writeFileBytes(dest, new Uint8Array(content));
			files += 1;
			bytes += size;
		}
		// Hardlinks and other exotic types don't occur in GitHub tarballs; skip.
	}
	return { files, bytes };
}

// Hydrate the PR into the durable Workspace from the GitHub tarball of the PR
// head SHA (reachable in the base repo for fork PRs too). No git objects, no
// pack indexing -- pack inflation in the DO stalled past ~16MB repo size,
// which is what took reviews down on 2026-08-08. gzip decompression is the
// runtime-native DecompressionStream. Idempotent: a HYDRATED marker skips
// re-fetching on workflow re-entry.
async function hydrate(env: Env, payload: ReviewPayload): Promise<void> {
	const t0 = Date.now();
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, workspaceName());
	hydrateStep(payload, "workspace created", t0);
	if (await workspace.exists(HYDRATED)) {
		hydrateStep(payload, "already hydrated", t0);
		return;
	}
	if (!payload.headSha) throw new Error("hydrate requires the PR head SHA");

	const url = `https://api.github.com/repos/${payload.owner}/${payload.repo}/tarball/${payload.headSha}`;
	const response = await fetch(url, {
		headers: { "User-Agent": "emdash-flue-review", Accept: "application/vnd.github+json" },
	});
	if (!response.ok || !response.body) {
		throw new Error(`tarball fetch failed: ${response.status} ${await response.text()}`);
	}
	hydrateStep(payload, "tarball response", t0);

	const tarStream = response.body.pipeThrough(new DecompressionStream("gzip"));
	const { files, bytes } = await untarInto(workspace, tarStream, REPO_DIR);
	hydrateStep(payload, `untarred ${files} files ${bytes} bytes`, t0);

	await workspace.writeFile(HYDRATED, new Date().toISOString());
	hydrateStep(payload, "hydrated", t0);
}

function logReviewEvent(
	level: "log" | "error",
	payload: ReviewPayload,
	runId: string,
	message: string,
	extra: Record<string, unknown> = {},
): void {
	console[level](
		JSON.stringify({
			message,
			attemptId: payload.attemptId,
			runId,
			deliveryId: payload.deliveryId,
			prNumber: payload.prNumber,
			headSha: payload.headSha,
			checkRunId: payload.checkRunId,
			...extra,
		}),
	);
}

async function reportStage(
	env: Env,
	token: string | undefined,
	payload: ReviewPayload,
	runId: string,
	stage: ReviewStage,
	detail: string,
): Promise<boolean> {
	logReviewEvent("log", payload, runId, "review stage changed", { stage });
	if (payload.checkRunId === undefined || !payload.attemptId) return true;

	const active = await getReviewWatchdog(env, payload.attemptId).heartbeat(
		payload.attemptId,
		runId,
		stage,
	);
	if (!active) return false;
	if (token) {
		try {
			await updateReviewCheck(token, payload.owner, payload.repo, payload.checkRunId, {
				prNumber: payload.prNumber,
				runId,
				stage,
				detail,
			});
		} catch (error) {
			logReviewEvent("error", payload, runId, "review stage reporting failed", {
				stage,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return true;
}

async function finishReviewCheck(
	env: Env,
	payload: ReviewPayload,
	runId: string,
	terminal: ReviewTerminal,
): Promise<void> {
	if (payload.checkRunId === undefined || !payload.attemptId) return;
	try {
		const finished = await getReviewWatchdog(env, payload.attemptId).finish(
			payload.attemptId,
			runId,
			terminal,
		);
		if (!finished) {
			logReviewEvent("error", payload, runId, "review attempt was already terminal");
		}
	} catch (error) {
		logReviewEvent("error", payload, runId, "review completion reporting failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function run(context: ActionContext<typeof reviewPayloadSchema>): Promise<ReviewResult> {
	const payload = context.input;

	// ActionContext intentionally excludes platform bindings; read them back
	// through the Cloudflare context established for this workflow run.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const env = getCloudflareContext().env as unknown as Env;
	let runId = payload.attemptId ?? "unidentified";

	// GitHub access lives only in this trusted Action code, never in the agent's
	// workspace. Without app creds (local dev) we skip posting and return.
	const creds = readAppCreds(env);
	let token: string | undefined;
	let priorReview: string | undefined;
	let reactionId: number | undefined;
	let stage: ReviewStage = "admitted";
	try {
		assertSafe(payload);
		if (!payload.headSha || !payload.baseSha) {
			throw new Error("Review payload does not include immutable base and head SHAs");
		}
		runId = workflowRunId();
		if (
			payload.attemptId &&
			payload.checkRunId !== undefined &&
			!(await getReviewWatchdog(env, payload.attemptId).identify(
				payload.attemptId,
				payload.expectedRunId ?? payload.attemptId,
				runId,
			))
		) {
			throw new Error("Review attempt is no longer active");
		}
		if (creds) {
			token = await mintInstallationToken(creds);
			reactionId = await addEyesReaction(token, payload.owner, payload.repo, payload.prNumber);
			priorReview = await fetchPriorReview(token, payload.owner, payload.repo, payload.prNumber);
		}

		// Hydrate the Workspace (clone + checkout the PR head) into the same DO
		// SQLite + R2 namespace the agent's sandbox reads from.
		stage = "hydrating";
		if (
			!(await reportStage(env, token, payload, runId, "hydrating", "Preparing the PR workspace."))
		) {
			throw new Error("Review attempt is no longer active");
		}
		await hydrate(env, payload);

		const session = await context.harness.session();

		// Stage the canonical unified diff into the Workspace (no `git` in cf-shell).
		stage = "fetching_diff";
		if (
			!(await reportStage(
				env,
				token,
				payload,
				runId,
				"fetching_diff",
				"Fetching the canonical PR diff.",
			))
		) {
			throw new Error("Review attempt is no longer active");
		}
		const diff = await fetchUnifiedDiff(
			payload.owner,
			payload.repo,
			payload.prNumber,
			token,
			payload.baseSha,
			payload.headSha,
		);
		await context.harness.fs.writeFile(DIFF_PATH, diff);

		stage = "model_review";
		if (
			!(await reportStage(
				env,
				token,
				payload,
				runId,
				"model_review",
				"The model is reviewing the diff.",
			))
		) {
			throw new Error("Review attempt is no longer active");
		}
		const { data } = await withCapacityRetry(
			(signal) =>
				session.skill("review", {
					args: {
						prContext: buildPrContext(payload, priorReview),
						owner: payload.owner,
						repo: payload.repo,
						prNumber: payload.prNumber,
						baseRef: payload.baseRef,
						headRef: payload.headRef,
						repoDir: REPO_DIR,
						diffPath: DIFF_PATH,
					},
					result: reviewResultSchema,
					signal,
				}),
			{
				label: `review#${payload.prNumber}`,
				attempts: 3,
				perAttemptTimeoutMs: 30 * 60_000,
				onRetry: ({ attempt, delayMs, error }) =>
					context.log.warn?.("[review] model over capacity, backing off", {
						prNumber: payload.prNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			},
		);

		logReviewEvent("log", payload, runId, "review model result received", {
			hasToken: Boolean(token),
			verdict: data.verdict,
			summaryLength: data.summary.length,
			findingCount: data.findings.length,
		});

		if (token) {
			stage = "posting_review";
			if (
				!(await reportStage(
					env,
					token,
					payload,
					runId,
					"posting_review",
					"Posting the review to GitHub.",
				))
			) {
				throw new Error("Review attempt is no longer active");
			}
			if (payload.headSha) {
				const currentHeadSha = await fetchPullRequestHeadSha(
					token,
					payload.owner,
					payload.repo,
					payload.prNumber,
				);
				if (currentHeadSha.toLowerCase() !== payload.headSha.toLowerCase()) {
					throw new Error("PR head changed before the review could be posted");
				}
			}
			await postReview(
				token,
				payload.owner,
				payload.repo,
				payload.prNumber,
				data,
				payload.headSha,
				payload.attemptId,
			);
		} else {
			logReviewEvent("log", payload, runId, "GitHub App credentials unavailable; skipping post");
		}

		await finishReviewCheck(env, payload, runId, {
			conclusion: "success",
			summary: `The automated review completed with verdict \`${data.verdict}\` and ${data.findings.length} finding(s).`,
		});

		return data;
	} catch (error) {
		logReviewEvent("error", payload, runId, "review run failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		const errorName = error instanceof Error ? error.name : "Error";
		await finishReviewCheck(env, payload, runId, {
			conclusion: "failure",
			summary: `The review failed during the \`${stage}\` stage (\`${errorName}\`). Reapply the \`bot:review\` label to retry.`,
		});
		throw error;
	} finally {
		if (token && reactionId !== undefined) {
			await removeReaction(token, payload.owner, payload.repo, payload.prNumber, reactionId);
		}
	}
}

export default defineWorkflow({
	agent: reviewAgent,
	input: reviewPayloadSchema,
	output: reviewResultSchema,
	run,
});

// Enable POST /workflows/review (the internal admission route the webhook
// handler calls). Pass-through: admission control lives in the webhook handler.
export const route: WorkflowRouteHandler = async (_c, next) => next();
