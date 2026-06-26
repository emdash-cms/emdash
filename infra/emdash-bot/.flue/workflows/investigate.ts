// Investigate workflow: runs the agent inside the Cloudflare Sandbox
// container, investigates an issue, and calls back into the OrchestratorDO
// with a structured result.

import {
	defineAgent,
	defineWorkflow,
	type FlueHarness,
	type FlueLogger,
	type WorkflowRouteHandler,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import { env as workerEnv } from "cloudflare:workers";
import * as v from "valibot";

import {
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
} from "../lib/github.js";

const inputSchema = v.object({
	runId: v.pipe(v.string(), v.minLength(1)),
	issueNumber: v.number(),
	mode: v.picklist(["repro", "implement", "revise"]),
	arg: v.optional(v.nullable(v.string())),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
});

const resultSchema = v.object({
	skipped: v.optional(v.boolean()),
	reproduced: v.optional(v.boolean()),
	fixed: v.optional(v.boolean()),
	verdict: v.optional(v.picklist(["bug", "intended-behavior", "unclear"])),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(400)),
});

const investigator = defineAgent<Env>(({ id, env }) => ({
	model: "cloudflare/@cf/moonshotai/kimi-k2.7-code",
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
	cwd: "/workspace/repo",
	instructions: [
		"You are emdashbot, investigating one EmDash issue.",
		"The repo is cloned at /workspace/repo with a write-scoped GITHUB_TOKEN already in the shell env and git credential store.",
		"Read AGENTS.md before making changes. Reproduce, diagnose, fix, verify, push.",
		"Return strictly the requested schema.",
	].join(" "),
}));

export const route: WorkflowRouteHandler = async (_c, next) => next();

const REPO_DIR = "/workspace/repo";

export default defineWorkflow({
	agent: investigator,
	input: inputSchema,
	output: v.any(),
	async run({ harness, input, log }) {
		await setupSandbox(harness, input, log);

		const session = await harness.session();
		const prompt = buildPrompt(input);
		const { data, model, usage } = await session.prompt(prompt, { result: resultSchema });
		log.info("investigate result", {
			runId: input.runId,
			issueNumber: input.issueNumber,
			mode: input.mode,
			...data,
		});

		const pushed = await detectPush(input.issueNumber);

		try {
			const stub = workerEnv.Orchestrator.getByName(`issue-${input.issueNumber}`);
			await stub.applyAgentResult({
				runId: input.runId,
				result: data,
				ok: true,
				pushed,
			});
		} catch (err) {
			log.error("applyAgentResult callback failed", {
				error: (err as Error).message,
			});
		}

		return {
			...data,
			_meta: {
				model: model ? `${model.provider}/${model.id}` : null,
				tokens: { input: usage.input, output: usage.output, total: usage.totalTokens },
				pushed,
			},
		};
	},
});

/**
 * Pre-clone the repo and write credentials into the sandbox before the agent
 * starts. Runs in trusted workflow code; the agent then sees a ready repo at
 * /workspace/repo with $GITHUB_TOKEN already in the env (via /etc/environment
 * and a git credential store) and the right branch checked out for the mode.
 *
 * If no App creds are configured (dev), this skips silently.
 */
async function setupSandbox(
	harness: FlueHarness,
	input: v.InferOutput<typeof inputSchema>,
	log: FlueLogger,
): Promise<void> {
	const creds = readAppCreds(workerEnv);
	const repo = readRepoContext(workerEnv);
	if (!creds || !repo) {
		log.info("setupSandbox: no creds; skipping clone");
		return;
	}

	let token: string;
	try {
		token = await mintInstallationToken(creds);
	} catch (err) {
		log.error?.("setupSandbox: token mint failed", { error: (err as Error).message });
		return;
	}

	const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`;
	const branch = input.mode === "revise" ? `bot/fix-${input.issueNumber}` : "main";

	// Persistent credential store so subsequent git commands (commit, push)
	// authenticate without re-exposing the token on the command line.
	await harness.fs.writeFile(
		"/root/.git-credentials",
		`https://x-access-token:${token}@github.com\n`,
	);
	// Expose the token to the agent's bash sessions for general API use.
	await harness.fs.writeFile("/etc/environment", `GITHUB_TOKEN=${token}\n`);

	const script = [
		"set -e",
		"git config --global credential.helper store",
		'git config --global user.email "emdashbot[bot]@users.noreply.github.com"',
		'git config --global user.name "emdashbot[bot]"',
		"mkdir -p /workspace",
		`if [ -d ${REPO_DIR}/.git ]; then`,
		`  cd ${REPO_DIR} && git fetch --all --prune`,
		"else",
		`  git clone --depth 50 '${cloneUrl}' ${REPO_DIR}`,
		"fi",
		`cd ${REPO_DIR}`,
		input.mode === "revise"
			? `git fetch origin '${branch}':'refs/remotes/origin/${branch}' && git checkout '${branch}'`
			: "git checkout main && git reset --hard origin/main",
	].join(" && ");

	try {
		await harness.shell(script);
		log.info("setupSandbox: clone complete", { mode: input.mode, branch });
	} catch (err) {
		log.error?.("setupSandbox: clone failed", { error: (err as Error).message });
	}
}

/**
 * Check whether the agent pushed a fix branch. Asks GitHub for the branch
 * after the agent finished; if it exists with non-base content, returns true.
 * No-creds dev mode returns false (no way to verify).
 */
async function detectPush(issueNumber: number): Promise<boolean> {
	const creds = readAppCreds(workerEnv);
	const repo = readRepoContext(workerEnv);
	if (!creds || !repo) return false;
	let token: string;
	try {
		token = await mintInstallationToken(creds);
	} catch {
		return false;
	}
	const branch = `bot/fix-${issueNumber}`;
	try {
		const res = await fetch(
			`https://api.github.com/repos/${repo.owner}/${repo.repo}/branches/${branch}`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"user-agent": "emdash-bot",
				},
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

function buildPrompt(input: {
	mode: string;
	arg?: string | null;
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
}): string {
	const argSection = input.arg
		? ["", "## Directive", "", input.arg, ""].join("\n")
		: "";
	return [
		`Investigate issue #${input.issueNumber} in mode: ${input.mode}.`,
		"",
		"The repo is cloned at /workspace/repo. You have a write-scoped GITHUB_TOKEN in the shell env and a configured git credential store. Read AGENTS.md before making changes.",
		"",
		`# ${input.issueTitle}`,
		"",
		input.issueBody || "(no body)",
		argSection,
		"## Method",
		"",
		"- Read AGENTS.md, find the relevant code, attempt to reproduce / build / revise.",
		"- Write tests where they make sense.",
		"- On success, `git commit` your changes and `git push -u origin HEAD:bot/fix-" +
			String(input.issueNumber) +
			" --force-with-lease`.",
		"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
		"",
		"## Return",
		"",
		"- skipped: true if the issue is out of scope (no actionable content)",
		"- reproduced: true if you confirmed the bug exists (repro mode)",
		"- fixed: true if you wrote a fix AND a test for it passes AND you pushed the branch",
		"- verdict: bug | intended-behavior | unclear",
		"- summary: one or two sentences describing what you found",
		"",
		"Return strictly the requested schema. No prose outside it.",
	].join("\n");
}
