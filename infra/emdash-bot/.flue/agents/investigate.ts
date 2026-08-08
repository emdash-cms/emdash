"use agent";

import { getWorkspace, type WorkspaceStubHost } from "@cloudflare/computer";
import { getSandbox } from "@cloudflare/sandbox";
import {
	defineTool,
	type AgentProps,
	useAgentFinish,
	useAgentStart,
	useDataWriter,
	useInitialData,
	useModel,
	usePersistentState,
	useSkill,
	useTool,
} from "@flue/runtime";
import { env as workerEnv } from "cloudflare:workers";
import * as v from "valibot";

import {
	type ContainerBackend,
	ExecEnv,
	fromSandbox,
	fromWorkspaceClient,
} from "../lib/exec-env.js";
import { createPushCapability, PUSH_CAPABILITY_HEADER } from "../lib/github-proxy.js";
import {
	getBranchSha,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
} from "../lib/github.js";
import { applyInvestigationResult } from "../lib/investigation-result.js";
import diagnoseSkill from "../skills/diagnose/SKILL.md";
import fixSkill from "../skills/fix/SKILL.md";
import investigateSkill from "../skills/investigate/SKILL.md";
import reproAdminSkill from "../skills/repro-admin/SKILL.md";
import reproApiSkill from "../skills/repro-api/SKILL.md";
import reproPublicSkill from "../skills/repro-public/SKILL.md";
import verifySkill from "../skills/verify/SKILL.md";

const REPO_DIR = "/workspace/repo";
const DEFAULT_RPC_TIMEOUT_MS = 2 * 60_000;
const EXEC_GRACE_MS = 30_000;
const CLONE_DEPTH = 50;
const DEADLINES = { defaultTimeoutMs: DEFAULT_RPC_TIMEOUT_MS, execGraceMs: EXEC_GRACE_MS };

const initialDataSchema = v.object({
	runId: v.pipe(v.string(), v.minLength(1)),
	issueNumber: v.number(),
	mode: v.picklist(["repro", "implement", "revise", "diagnose", "fix"]),
	arg: v.optional(v.nullable(v.string())),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
	previousBranchSha: v.nullable(v.string()),
});

const screenshotSchema = v.object({
	filename: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
	description: v.optional(v.string()),
});

const resultSchema = v.object({
	skipped: v.optional(v.boolean()),
	reproduced: v.optional(v.boolean()),
	fixed: v.optional(v.boolean()),
	verdict: v.optional(v.picklist(["bug", "intended-behavior", "unclear"])),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(400)),
	/** Reproduction screenshots pushed to bot/artifacts-<n>, rendered in the ask comment. */
	screenshots: v.optional(v.array(screenshotSchema)),
});

const reportedResultSchema = v.object({
	result: resultSchema,
	ok: v.boolean(),
	pushed: v.boolean(),
});

type InvestigateData = v.InferOutput<typeof initialDataSchema>;
type InvestigationResult = v.InferOutput<typeof resultSchema>;

export function Investigate({ id }: AgentProps) {
	const input = useInitialData<InvestigateData>();
	const [setupComplete, setSetupComplete] = usePersistentState("setup-complete", false);
	const [reported, setReported] = usePersistentState("reported", false);
	const [reminded, setReminded] = usePersistentState("report-reminded", false);
	const writeResult = useDataWriter("investigation", { schema: reportedResultSchema });
	const env = execEnvFor(id, input);

	useModel("cloudflare/@cf/moonshotai/kimi-k2.7-code");

	useSkill(investigateSkill);
	useSkill(diagnoseSkill);
	useSkill(verifySkill);
	useSkill(reproApiSkill);
	useSkill(reproAdminSkill);
	useSkill(reproPublicSkill);
	// Every mode but diagnose may end in a fix attempt (`repro` is
	// "reproduce and attempt a fix" in machine.ts).
	if (input.mode !== "diagnose") {
		useSkill(fixSkill);
	}

	useAgentStart(async ({ log }) => {
		if (setupComplete || reported) return;
		try {
			await env.cloneRepo({
				url: cloneUrl(),
				dir: REPO_DIR,
				ref: cloneRef(input),
				depth: CLONE_DEPTH,
			});
			setSetupComplete(true);
		} catch (error) {
			const result = failedResult(
				`I couldn't prepare the investigation workspace: ${errorMessage(error)}`,
			);
			await applyInvestigationResult(input, result, false, false);
			writeResult({ result, ok: false, pushed: false });
			setReported(true);
			log.error("workspace setup failed", { error: errorMessage(error) });
		}
	});

	useTool(
		defineTool({
			name: "read_file",
			description: "Read a file from the workspace (VFS). Prefer this over shelling out to `cat`.",
			input: v.object({ path: v.string() }),
			async run({ data }) {
				return await env.readFile(data.path);
			},
		}),
	);

	useTool(
		defineTool({
			name: "write_file",
			description: "Write (create or overwrite) a file in the workspace.",
			input: v.object({ path: v.string(), content: v.string() }),
			async run({ data }) {
				await env.writeFile(data.path, data.content);
				return `wrote ${data.path}`;
			},
		}),
	);

	useTool(
		defineTool({
			name: "edit_file",
			description: "Replace an exact, unique substring in a file.",
			input: v.object({ path: v.string(), oldString: v.string(), newString: v.string() }),
			async run({ data }) {
				await env.edit(data.path, data.oldString, data.newString);
				return `edited ${data.path}`;
			},
		}),
	);

	useTool(
		defineTool({
			name: "ls",
			description: "List a directory in the workspace.",
			input: v.object({ path: v.string() }),
			async run({ data }) {
				const entries = await env.ls(data.path);
				return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n");
			},
		}),
	);

	useTool(
		defineTool({
			name: "grep",
			description: "Search the workspace for a pattern. Fast; runs in the isolate.",
			input: v.object({
				pattern: v.string(),
				path: v.string(),
				ignoreCase: v.optional(v.boolean()),
			}),
			async run({ data }) {
				const matches = await env.grep(
					data.pattern,
					data.path,
					data.ignoreCase === undefined ? undefined : { ignoreCase: data.ignoreCase },
				);
				return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "(no matches)";
			},
		}),
	);

	useTool(
		defineTool({
			name: "exec",
			description:
				"Run a shell command. target 'isolate' (default) is fast bash-in-isolate for grep/git/inspection; target 'container' attaches a Linux container for pnpm/astro/vitest/agent-browser -- slow, use only to run the project.",
			input: v.object({
				command: v.string(),
				target: v.optional(v.picklist(["isolate", "container"]), "isolate"),
				cwd: v.optional(v.string()),
				timeoutMs: v.optional(v.number()),
			}),
			async run({ data }) {
				const result = await env.exec(data.command, {
					target: data.target,
					...(data.cwd ? { cwd: data.cwd } : {}),
					...(data.timeoutMs ? { timeoutMs: data.timeoutMs } : {}),
				});
				return [`exit ${result.exitCode}`, result.stdout, result.stderr].filter(Boolean).join("\n");
			},
		}),
	);

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
				await step.do("apply-agent-result", () =>
					applyInvestigationResult(input, data, true, pushed),
				);
				const reportedResult = { result: data, ok: true, pushed };
				writeResult(reportedResult);
				setReported(true);
				log.info("investigation reported", {
					runId: input.runId,
					issueNumber: input.issueNumber,
					pushed,
				});
				return { output: reportedResult };
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
		await applyInvestigationResult(input, result, false, false);
		writeResult({ result, ok: false, pushed: false });
		setReported(true);
		log.warn("agent stopped without reporting", { runId: input.runId });
	});

	if (reported && !setupComplete) {
		return "Workspace setup failed and the failure has already been reported. Briefly acknowledge that the run could not start.";
	}

	return buildPrompt(input);
}

Investigate.agentName = "investigate";
Investigate.initialData = initialDataSchema;
Investigate.durability = { maxAttempts: 5, timeoutMs: 30 * 60_000 };

/**
 * Per-run ExecEnv, cached on `globalThis` so it survives the agent's re-renders
 * within one isolate (Vite duplicates modules across SSR chunks, so a plain
 * module `let` would not be shared). The container is attached lazily on first
 * container exec; the VFS/isolate side needs no attach.
 */
const EXEC_ENV_REGISTRY = Symbol.for("emdash-bot.execEnvs");

function execEnvRegistry(): Map<string, ExecEnv> {
	const store = globalThis as typeof globalThis & { [EXEC_ENV_REGISTRY]?: Map<string, ExecEnv> };
	return (store[EXEC_ENV_REGISTRY] ??= new Map());
}

function execEnvFor(id: string, input: InvestigateData): ExecEnv {
	const registry = execEnvRegistry();
	const existing = registry.get(id);
	if (existing) return existing;
	let clientPromise: ReturnType<typeof getWorkspace> | undefined;
	const isolate = fromWorkspaceClientLazy(async () => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer the withWorkspace stub-host type.
		const stub = workerEnv.WorkspaceDO.get(
			workerEnv.WorkspaceDO.idFromName(id),
		) as unknown as WorkspaceStubHost;
		try {
			return await (clientPromise ??= getWorkspace(stub));
		} catch (error) {
			// A rejected promise must not stay cached: the next call retries.
			clientPromise = undefined;
			throw error;
		}
	});
	const env = new ExecEnv({
		isolate,
		attachContainer: () => attachContainer(id, input),
		deadlines: DEADLINES,
		repoDir: REPO_DIR,
	});
	registry.set(id, env);
	return env;
}

/** Defer resolving the RPC client until the first fs/runtime call. */
function fromWorkspaceClientLazy(getClient: () => ReturnType<typeof getWorkspace>) {
	let backend: ReturnType<typeof fromWorkspaceClient> | undefined;
	const resolve = async () => (backend ??= fromWorkspaceClient(await getClient()));
	return {
		fs: {
			readFile: async (path: string, encoding: "utf8") =>
				(await resolve()).fs.readFile(path, encoding),
			writeFile: async (path: string, content: string) =>
				(await resolve()).fs.writeFile(path, content),
			mkdir: async (path: string, options?: { recursive?: boolean }) =>
				(await resolve()).fs.mkdir(path, options),
			readdir: async (path: string) => (await resolve()).fs.readdir(path),
			rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) =>
				(await resolve()).fs.rm(path, options),
			grep: async (pattern: string, path: string, options?: { ignoreCase?: boolean }) =>
				(await resolve()).fs.grep(pattern, path, options),
		},
		runtime: {
			exec: async (
				source: string,
				options: { backend?: string; cwd?: string; encoding: "utf8"; timeoutMs?: number },
			) => (await resolve()).runtime.exec(source, options),
		},
	};
}

/**
 * Attach the container substrate and reproduce the base checkout the toolchain
 * runs against: git identity, a clone (or fetch) at the run's ref, and the
 * issue-scoped push capability the outbound proxy verifies. pnpm install is
 * left to the repro/fix skills -- isolate-first, container work on demand.
 */
async function attachContainer(id: string, input: InvestigateData): Promise<ContainerBackend> {
	const container = fromSandbox(getSandbox(workerEnv.Sandbox, id));
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	const branch = cloneRef(input);
	// Diagnose mode is investigation-only: no push capability enters the
	// container, so a fix push is impossible rather than merely instructed against.
	const pushCapability =
		input.mode === "diagnose"
			? null
			: await createPushCapability(
					workerEnv.GITHUB_WEBHOOK_SECRET,
					repo.owner,
					repo.repo,
					input.issueNumber,
				);
	const steps: Array<{ command: string; timeoutMs?: number }> = [
		{ command: 'git config --global user.email "emdashbot[bot]@users.noreply.github.com"' },
		{ command: 'git config --global user.name "emdashbot[bot]"' },
		{ command: "mkdir -p /workspace" },
		{
			command: `if [ -d ${REPO_DIR}/.git ]; then cd ${REPO_DIR} && git fetch --all --prune; else git clone --depth ${CLONE_DEPTH} --branch '${branch}' '${cloneUrl()}' ${REPO_DIR}; fi`,
			timeoutMs: 5 * 60_000,
		},
		{
			command: `cd ${REPO_DIR} && git checkout '${branch}' && git reset --hard 'origin/${branch}'`,
		},
		...(pushCapability
			? [
					{
						command: `cd ${REPO_DIR} && git config http.https://github.com/.extraHeader '${PUSH_CAPABILITY_HEADER}: ${pushCapability}'`,
					},
				]
			: []),
	];
	for (const step of steps) {
		const result = await container.exec(step.command, {
			cwd: "/",
			...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
		});
		if (result.exitCode !== 0) {
			throw new Error(`container setup failed (${result.exitCode}): ${result.stderr.slice(-500)}`);
		}
	}
	return container;
}

function cloneUrl(): string {
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

function cloneRef(input: InvestigateData): string {
	return input.mode === "revise" ? `bot/fix-${input.issueNumber}` : "main";
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
	return text.length <= 400 ? text : `${text.slice(0, 399)}…`;
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
	const diagnose = input.mode === "diagnose";
	const method = diagnose
		? [
				"- Read AGENTS.md, find the relevant code, and attempt to reproduce the bug.",
				"- Diagnose the root cause. Do NOT write or push a fix -- this is investigation only.",
				"- Report `reproduced` and put the diagnosis in `summary`. Use verdict `unclear` only when you are blocked on information that only the reporter can supply.",
			]
		: [
				"- Read AGENTS.md, find the relevant code, attempt to reproduce, build, or revise.",
				"- Write tests where they make sense.",
				"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
				`- When done, commit and push from a container: \`exec\` with target container running \`git checkout -B bot/fix-${input.issueNumber} && git add <files> && git commit -m '<message>' && git push -u origin HEAD --force-with-lease\`.`,
				`- If you captured reproduction screenshots in \`.bot-artifacts/\`, keep them off the fix branch (\`git reset HEAD .bot-artifacts\` before committing) and push them to an orphan artifacts branch from a scratch tree: copy \`.bot-artifacts\` aside, \`git init -b bot/artifacts-${input.issueNumber}\`, add and commit only \`.bot-artifacts\`, then \`git push -u origin HEAD --force\`. Report each screenshot's basename and a one-line description in \`screenshots\`.`,
			];
	const closing = diagnose
		? "Call report_result exactly once when finished. Do not set fixed; report reproduced and your verdict with the diagnosis in summary."
		: "Call report_result exactly once when finished. fixed may only be true if a fix and test passed and the branch was pushed.";
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
		...method,
		"",
		closing,
	].join("\n");
}
