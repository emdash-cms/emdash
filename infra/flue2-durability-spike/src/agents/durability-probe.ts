"use agent";

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
	defineTool,
	type AgentProps,
	useInitialData,
	useModel,
	useSandbox,
	useTool,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import { withDeadline } from "../deadline.js";

const probeModes = ["quick", "long", "fail", "durable-long"] as const;
const sandboxRpcDeadlineMs = 120_000;
type ProbeMode = (typeof probeModes)[number];

interface ProbeData {
	mode: ProbeMode;
}

function probeCommand(mode: ProbeMode) {
	const delay = mode === "quick" ? 2 : 90;
	const exit = mode === "fail" ? "exit 42" : "true";

	return [
		"mkdir -p /workspace/probe",
		`printf 'started mode=${mode} pid=%s time=%s\\n' "$$" "$(date -Iseconds)" >> /workspace/probe/events.log`,
		`sleep ${delay}`,
		`printf 'completed mode=${mode} pid=%s time=%s\\n' "$$" "$(date -Iseconds)" >> /workspace/probe/events.log`,
		"cat /workspace/probe/events.log",
		exit,
	].join(" && ");
}

export function DurabilityProbe({ id }: AgentProps) {
	const { mode } = useInitialData<ProbeData>();
	const sandbox = getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, id);

	useModel("cloudflare/@cf/zai-org/glm-4.7-flash");
	useSandbox(cloudflareSandbox(sandbox), { cwd: "/workspace" });

	if (mode === "durable-long") {
		useTool(
			defineTool({
				name: "run_probe",
				description: "Run the configured durability probe exactly once.",
				harness: true,
				durable: true,
				async run({ harness, step }) {
					return step.do("sandbox-command", async () => {
						const result = await withDeadline(
							harness.sandbox.exec(probeCommand(mode), { timeoutMs: 180_000 }),
							sandboxRpcDeadlineMs,
							"Sandbox exec",
						);
						return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
					});
				},
			}),
		);
	} else {
		useTool(
			defineTool({
				name: "run_probe",
				description: "Run the configured durability probe exactly once.",
				harness: true,
				async run({ harness }) {
					const result = await withDeadline(
						harness.sandbox.exec(probeCommand(mode), { timeoutMs: 180_000 }),
						sandboxRpcDeadlineMs,
						"Sandbox exec",
					);
					return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
				},
			}),
		);
	}

	return [
		`This is durability probe ${id} in mode ${mode}.`,
		"Call run_probe exactly once, then report its exit code and output.",
		"Do not run any other tools and do not retry run_probe yourself if it reports an interruption.",
	].join("\n");
}

DurabilityProbe.agentName = "durability-probe";
DurabilityProbe.initialData = v.object({ mode: v.picklist(probeModes) });
DurabilityProbe.durability = { maxAttempts: 5, timeoutMs: 10 * 60_000 };
