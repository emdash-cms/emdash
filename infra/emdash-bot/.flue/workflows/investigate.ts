// Investigate workflow: runs the agent inside the Cloudflare Sandbox
// container, investigates an issue, and calls back into the OrchestratorDO
// with a structured result.
//
// Trust model: the Sandbox class (see .flue/cloudflare.ts) intercepts all
// HTTPS to github.com / api.github.com / codeload.github.com via the
// authenticatedGithub outbound handler. The handler mints a fresh
// installation token in the Worker runtime and injects Basic auth before
// forwarding upstream. The token never enters the sandbox; the agent sees a
// plain HTTPS endpoint and uses normal git. `allowedHosts` denies everything
// else.

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
import investigate from "../skills/investigate/SKILL.md" with { type: "skill" };

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
		"You are emdashbot, investigating one EmDash issue in a sandboxed Debian container.",
		"The repo is pre-cloned at /workspace/repo. git clone/fetch/push to github.com work transparently -- credentials are injected by an outbound proxy outside the sandbox. You have no tokens in your env or filesystem.",
		"Follow the investigate skill's protocol exactly and return strictly schema-conformant output.",
	].join(" "),
	skills: [investigate],
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
 * Pre-clone the repo into the sandbox before the agent starts. Clone happens
 * over plain HTTPS to github.com -- the outbound proxy injects authentication
 * outside the sandbox. The sandbox never holds a token.
 */
async function setupSandbox(
	harness: FlueHarness,
	input: v.InferOutput<typeof inputSchema>,
	log: FlueLogger,
): Promise<void> {
	const repo = readRepoContext(workerEnv);
	if (!repo) {
		log.info("setupSandbox: no repo context; skipping clone");
		return;
	}

	const cloneUrl = `https://github.com/${repo.owner}/${repo.repo}.git`;
	const branch = input.mode === "revise" ? `bot/fix-${input.issueNumber}` : "main";

	const script = [
		"set -e",
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
 * Check whether the agent pushed a fix branch. The check goes through the
 * Worker (api.github.com is also routed through the outbound proxy when the
 * agent runs, but here we're outside the sandbox -- direct API call with a
 * fresh token).
 */
async function detectPush(issueNumber: number): Promise<boolean> {
	const repo = readRepoContext(workerEnv);
	const creds = readAppCreds(workerEnv);
	if (!repo || !creds) return false;
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
		"The repo is cloned at /workspace/repo. Read AGENTS.md before making changes.",
		"",
		`# ${input.issueTitle}`,
		"",
		input.issueBody || "(no body)",
		argSection,
		"## Method",
		"",
		"- Read AGENTS.md, find the relevant code, attempt to reproduce / build / revise.",
		"- Write tests where they make sense.",
		"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
		"- When done, commit and push: `git checkout -B bot/fix-" +
			String(input.issueNumber) +
			" && git add <files> && git commit -m '<message>' && git push -u origin HEAD --force-with-lease`.",
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
