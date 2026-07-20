"use agent";

import { getSandbox } from "@cloudflare/sandbox";
import {
	defineTool,
	defineSkill,
	type AgentProps,
	useAgentFinish,
	useAgentStart,
	useDataWriter,
	useInitialData,
	useModel,
	usePersistentState,
	useSandbox,
	useSkill,
	useTool,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { env as workerEnv } from "cloudflare:workers";
import * as v from "valibot";

import {
	getBranchSha,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
} from "../lib/github.js";
import type { AgentResult } from "../lib/orchestrator.js";
import { withSandboxDeadlines } from "../lib/sandbox-deadline.js";
import investigateDocument from "../skills/investigate/instructions.md?raw";

const REPO_DIR = "/workspace/repo";
const DEFAULT_SANDBOX_RPC_TIMEOUT_MS = 2 * 60_000;
const SANDBOX_EXEC_GRACE_MS = 30_000;

const initialDataSchema = v.object({
	runId: v.pipe(v.string(), v.minLength(1)),
	issueNumber: v.number(),
	mode: v.picklist(["repro", "implement", "revise"]),
	arg: v.optional(v.nullable(v.string())),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
	previousBranchSha: v.nullable(v.string()),
});

const resultSchema = v.object({
	skipped: v.optional(v.boolean()),
	reproduced: v.optional(v.boolean()),
	fixed: v.optional(v.boolean()),
	verdict: v.optional(v.picklist(["bug", "intended-behavior", "unclear"])),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(400)),
});

const reportedResultSchema = v.object({
	result: resultSchema,
	ok: v.boolean(),
	pushed: v.boolean(),
});

type InvestigateData = v.InferOutput<typeof initialDataSchema>;
type InvestigationResult = v.InferOutput<typeof resultSchema>;

const investigate = defineSkill({
	name: "investigate",
	description:
		"Investigate an EmDash issue, verify the result, and push a fix branch when appropriate.",
	instructions: investigateDocument.trim(),
});

export function Investigate({ id }: AgentProps) {
	const input = useInitialData<InvestigateData>();
	const [setupComplete, setSetupComplete] = usePersistentState("setup-complete", false);
	const [reported, setReported] = usePersistentState("reported", false);
	const [reminded, setReminded] = usePersistentState("report-reminded", false);
	const writeResult = useDataWriter("investigation", { schema: reportedResultSchema });
	const sandbox = getSandbox(workerEnv.Sandbox, id);

	useModel("cloudflare/@cf/moonshotai/kimi-k2.7-code");
	useSandbox(
		withSandboxDeadlines(cloudflareSandbox(sandbox), {
			defaultTimeoutMs: DEFAULT_SANDBOX_RPC_TIMEOUT_MS,
			execGraceMs: SANDBOX_EXEC_GRACE_MS,
		}),
		{ cwd: REPO_DIR },
	);
	useSkill(investigate);

	useAgentStart(async ({ harness, log }) => {
		if (setupComplete || reported) return;
		try {
			await setupSandbox(harness, input, log);
			setSetupComplete(true);
		} catch (error) {
			const result = failedResult(
				`I couldn't prepare the investigation sandbox: ${errorMessage(error)}`,
			);
			await applyResult(input, result, false, false);
			writeResult({ result, ok: false, pushed: false });
			setReported(true);
			log.error("sandbox setup failed", { error: errorMessage(error) });
		}
	});

	useTool(
		defineTool({
			name: "report_result",
			description: "Report the final structured investigation result to the issue orchestrator.",
			input: resultSchema,
			output: reportedResultSchema,
			durable: true,
			async run({ data, step, log }) {
				const pushed = await step.do("detect-push", () =>
					detectPush(input.issueNumber, input.previousBranchSha),
				);
				await step.do("apply-agent-result", () => applyResult(input, data, true, pushed));
				const reportedResult = { result: data, ok: true, pushed };
				writeResult(reportedResult);
				setReported(true);
				log.info("investigation reported", {
					runId: input.runId,
					issueNumber: input.issueNumber,
					pushed,
				});
				return reportedResult;
			},
		}),
	);

	useAgentFinish(async ({ response, append, log }) => {
		const reportCall = response.toolCalls.some(
			(call) => call.tool === "report_result" && !call.isError,
		);
		if (reported || reportCall) return;
		if (!reminded) {
			setReminded(true);
			append({
				kind: "signal",
				type: "investigation.report-required",
				body: "You have not reported the result. Call report_result now with your final findings. Do not do more investigation.",
			});
			return;
		}

		const result = failedResult(
			"I couldn't complete this run because the agent stopped without reporting a result.",
		);
		await applyResult(input, result, false, false);
		writeResult({ result, ok: false, pushed: false });
		setReported(true);
		log.warn("agent stopped without reporting", { runId: input.runId });
	});

	if (reported && !setupComplete) {
		return "Sandbox setup failed and the failure has already been reported. Briefly acknowledge that the run could not start.";
	}

	return buildPrompt(input);
}

Investigate.agentName = "investigate";
Investigate.initialData = initialDataSchema;
Investigate.durability = { maxAttempts: 5, timeoutMs: 30 * 60_000 };

async function setupSandbox(
	harness: Parameters<Parameters<typeof useAgentStart>[0]>[0]["harness"],
	input: InvestigateData,
	log: Parameters<Parameters<typeof useAgentStart>[0]>[0]["log"],
): Promise<void> {
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	const cloneUrl = `https://github.com/${repo.owner}/${repo.repo}.git`;
	const branch = input.mode === "revise" ? `bot/fix-${input.issueNumber}` : "main";
	const steps: Array<{ name: string; command: string; timeoutMs?: number; nonFatal?: boolean }> = [
		{
			name: "git-identity-email",
			command: 'git config --global user.email "emdashbot[bot]@users.noreply.github.com"',
		},
		{ name: "git-identity-name", command: 'git config --global user.name "emdashbot[bot]"' },
		{ name: "mkdir-workspace", command: "mkdir -p /workspace" },
		{
			name: "clone-or-fetch",
			command: `if [ -d ${REPO_DIR}/.git ]; then cd ${REPO_DIR} && git fetch --all --prune; else git clone --depth 50 '${cloneUrl}' ${REPO_DIR}; fi`,
			timeoutMs: 5 * 60_000,
		},
		input.mode === "revise"
			? {
					name: "checkout-revise",
					command: `cd ${REPO_DIR} && git fetch origin '${branch}':'refs/remotes/origin/${branch}' && git checkout '${branch}'`,
				}
			: {
					name: "checkout-main",
					command: `cd ${REPO_DIR} && git checkout main && git reset --hard origin/main`,
				},
		{
			name: "pnpm-install",
			command: `cd ${REPO_DIR} && pnpm install --frozen-lockfile --prefer-offline`,
			timeoutMs: 15 * 60_000,
			nonFatal: true,
		},
	];

	for (const setupStep of steps) {
		try {
			const result = await harness.sandbox.exec(setupStep.command, {
				cwd: "/",
				...(setupStep.timeoutMs ? { timeoutMs: setupStep.timeoutMs } : {}),
			});
			if (result.exitCode === 0) {
				log.info(`setupSandbox: ${setupStep.name} ok`);
				continue;
			}
			const message = `${setupStep.name} exited ${result.exitCode}: ${result.stderr.slice(-500)}`;
			if (setupStep.nonFatal) {
				log.warn(message);
				continue;
			}
			throw new Error(message);
		} catch (error) {
			if (setupStep.nonFatal) {
				log.warn(`setupSandbox: ${setupStep.name} failed non-fatally`, {
					error: errorMessage(error),
				});
				continue;
			}
			throw error;
		}
	}
}

async function applyResult(
	input: InvestigateData,
	result: AgentResult,
	ok: boolean,
	pushed: boolean,
): Promise<void> {
	const stub = workerEnv.Orchestrator.getByName(`issue-${input.issueNumber}`);
	await stub.applyAgentResult({ runId: input.runId, result, ok, pushed });
}

function failedResult(summary: string): InvestigationResult {
	return {
		summary: truncateSummary(summary),
		fixed: false,
		reproduced: false,
		verdict: "unclear",
	};
}

function truncateSummary(text: string): string {
	return text.length <= 400 ? text : `${text.slice(0, 399)}\u2026`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function detectPush(issueNumber: number, previousBranchSha: string | null): Promise<boolean> {
	const repo = readRepoContext(workerEnv);
	const creds = readAppCreds(workerEnv);
	if (!repo || !creds) return false;
	const token = await mintInstallationToken(creds);
	const currentBranchSha = await getBranchSha(token, repo, `bot/fix-${issueNumber}`);
	return currentBranchSha !== null && currentBranchSha !== previousBranchSha;
}

function buildPrompt(input: InvestigateData): string {
	const argSection = input.arg ? ["", "## Directive", "", input.arg, ""].join("\n") : "";
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
		"- Read AGENTS.md, find the relevant code, attempt to reproduce, build, or revise.",
		"- Write tests where they make sense.",
		"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
		`- When done, commit and push: \`git checkout -B bot/fix-${input.issueNumber} && git add <files> && git commit -m '<message>' && git push -u origin HEAD --force-with-lease\`.`,
		"",
		"Call report_result exactly once when finished. fixed may only be true if a fix and test passed and the branch was pushed.",
	].join("\n");
}
