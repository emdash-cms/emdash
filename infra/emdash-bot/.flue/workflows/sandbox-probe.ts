// Phase 0 stretch: prove the toolchain runs INSIDE the Sandbox container.
//
// Invokes a sequence of shell commands through the agent's sandbox to verify
// node, pnpm, git, bgproc, and agent-browser are present and runnable. Returns
// each command's stdout/exit code. No model calls -- this is a pure shell
// integration test.
//
// Delete this file once Phase 1 starts; it exists only for the spike.

import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";

const inputSchema = v.object({});

const prober = defineAgent<Env>(({ id, env }) => ({
	// `model: false` -> no model is auto-bound; we won't make any prompt calls.
	model: false as const,
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
	cwd: "/workspace",
}));

export const route: WorkflowRouteHandler = async (_c, next) => next();

export default defineWorkflow({
	agent: prober,
	input: inputSchema,
	output: v.any(),
	async run({ harness, log }) {
		const session = await harness.session();
		const commands: Array<{ cmd: string; timeoutMs: number }> = [
			{ cmd: "node --version", timeoutMs: 10_000 },
			{ cmd: "pnpm --version", timeoutMs: 10_000 },
			{ cmd: "git --version", timeoutMs: 10_000 },
			{ cmd: "bgproc --version", timeoutMs: 10_000 },
			{ cmd: "agent-browser --version", timeoutMs: 10_000 },
			// Install Chromium via agent-browser. First run downloads ~150MB.
			// Subsequent runs in the same Sandbox DO instance reuse the cache.
			{ cmd: "agent-browser install 2>&1 | tail -20", timeoutMs: 180_000 },
			// Confirm Chromium is on PATH (or in agent-browser's cache).
			{
				cmd: "ls -la $HOME/.cache/agent-browser 2>/dev/null | head -20; ls -la $HOME/.cache/puppeteer 2>/dev/null | head -20",
				timeoutMs: 10_000,
			},
			// Real smoke: open a static page and read its content.
			{
				cmd: "agent-browser open https://example.com 2>&1 | head -30",
				timeoutMs: 60_000,
			},
			{
				cmd: "agent-browser read 2>&1 | head -30",
				timeoutMs: 30_000,
			},
		];
		const results: Array<{
			cmd: string;
			exit: number;
			stdout: string;
			stderr: string;
			ms: number;
		}> = [];
		for (const { cmd, timeoutMs } of commands) {
			const t0 = Date.now();
			const r = await session.shell(cmd, { timeoutMs });
			const ms = Date.now() - t0;
			results.push({
				cmd,
				exit: r.exitCode,
				stdout: r.stdout.slice(0, 1000),
				stderr: r.stderr.slice(0, 1000),
				ms,
			});
			log.info("probe", { cmd, exit: r.exitCode, ms });
		}
		return { results };
	},
});
