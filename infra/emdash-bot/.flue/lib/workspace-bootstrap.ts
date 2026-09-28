import { BOOTSTRAP_TIMEOUT_MS } from "./run-policy.js";

export const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = BOOTSTRAP_TIMEOUT_MS;

export type WorkspaceBootstrapStage = "workspace_installing" | "workspace_building";

const BACKGROUND_POLL_MS = 2_000;
const BACKGROUND_RPC_TIMEOUT_MS = 30_000;

interface BootstrapContainer {
	exec(
		command: string,
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export async function bootstrapWorkspace(
	container: BootstrapContainer,
	options: {
		repoDir: string;
		onProgress: (stage: WorkspaceBootstrapStage) => Promise<void>;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<void> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const deadlineAt = now() + WORKSPACE_BOOTSTRAP_TIMEOUT_MS;
	const dependencies = await container.exec(
		"test -d node_modules -a -f node_modules/.modules.yaml",
		{ cwd: options.repoDir },
	);
	if (dependencies.exitCode !== 0) {
		await options.onProgress("workspace_installing");
		const install = await runBackgroundCommand(container, {
			name: "emdash-workspace-install",
			command: "pnpm install --frozen-lockfile --prefer-offline",
			cwd: options.repoDir,
			timeoutMs: remainingBootstrapMs(now, deadlineAt),
			now,
			sleep,
		});
		assertBootstrapSuccess(install, "dependency installation");
	}

	await options.onProgress("workspace_building");
	const build = await runBackgroundCommand(container, {
		name: "emdash-workspace-build",
		command: "pnpm build",
		cwd: options.repoDir,
		timeoutMs: remainingBootstrapMs(now, deadlineAt),
		now,
		sleep,
	});
	assertBootstrapSuccess(build, "workspace build");
}

async function runBackgroundCommand(
	container: BootstrapContainer,
	options: {
		name: string;
		command: string;
		cwd: string;
		timeoutMs: number;
		now: () => number;
		sleep: (ms: number) => Promise<void>;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const exitFile = `/tmp/${options.name}.exit`;
	const deadlineAt = options.now() + options.timeoutMs;
	const wrappedCommand = `${options.command}; status=$?; printf '%s' "$status" > ${exitFile}; exit "$status"`;
	const start = await container.exec(
		`rm -f ${exitFile} && bgproc start -f -n ${options.name} -t ${Math.ceil(options.timeoutMs / 1_000)} -- bash -o pipefail -c ${shellQuote(wrappedCommand)}`,
		{ cwd: options.cwd, timeoutMs: BACKGROUND_RPC_TIMEOUT_MS },
	);
	if (start.exitCode !== 0) return start;

	for (;;) {
		const status = await container.exec(
			`if [ -f ${exitFile} ]; then printf 'complete:'; cat ${exitFile}; else bgproc status -n ${options.name}; fi`,
			{ cwd: options.cwd, timeoutMs: BACKGROUND_RPC_TIMEOUT_MS },
		);
		if (status.exitCode !== 0) return status;
		const output = status.stdout.trim();
		if (output.startsWith("complete:")) {
			const exitCode = Number(output.slice("complete:".length));
			if (!Number.isSafeInteger(exitCode)) {
				throw new Error(`${options.name} returned an invalid exit status: ${output}`);
			}
			const logs = await readBackgroundLogs(container, options.name, options.cwd);
			return { exitCode, stdout: logs.stdout, stderr: logs.stderr };
		}

		const processStatus = parseBackgroundStatus(output, options.name);
		if (!processStatus.running) {
			const logs = await readBackgroundLogs(container, options.name, options.cwd);
			throw new Error(
				`${options.name} stopped without recording an exit status: ${(logs.stderr || logs.stdout || output).trim().slice(-1_000)}`,
			);
		}
		const remaining = deadlineAt - options.now();
		if (remaining <= 0) {
			await container.exec(`bgproc stop -n ${options.name}`, {
				cwd: options.cwd,
				timeoutMs: BACKGROUND_RPC_TIMEOUT_MS,
			});
			throw new Error(`${options.name} exceeded ${options.timeoutMs}ms`);
		}
		await options.sleep(Math.min(BACKGROUND_POLL_MS, remaining));
	}
}

function parseBackgroundStatus(output: string, name: string): { running: boolean } {
	try {
		const parsed: unknown = JSON.parse(output);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"running" in parsed &&
			typeof parsed.running === "boolean"
		) {
			return { running: parsed.running };
		}
	} catch {}
	throw new Error(`${name} returned an invalid status: ${output.slice(-500)}`);
}

function readBackgroundLogs(container: BootstrapContainer, name: string, cwd: string) {
	return container.exec(
		`bgproc logs -n ${name} --tail 200; bgproc logs -n ${name} --tail 200 --errors`,
		{ cwd, timeoutMs: BACKGROUND_RPC_TIMEOUT_MS },
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function remainingBootstrapMs(now: () => number, deadlineAt: number): number {
	const remaining = deadlineAt - now();
	if (remaining <= 0) {
		throw new Error(`workspace bootstrap exceeded ${WORKSPACE_BOOTSTRAP_TIMEOUT_MS}ms`);
	}
	return remaining;
}

function assertBootstrapSuccess(
	result: { exitCode: number; stdout: string; stderr: string },
	stage: string,
): void {
	if (result.exitCode === 0) return;
	const output = (result.stderr || result.stdout || "no output").trim().slice(-1_000);
	throw new Error(`${stage} failed (${result.exitCode}): ${output}`);
}
