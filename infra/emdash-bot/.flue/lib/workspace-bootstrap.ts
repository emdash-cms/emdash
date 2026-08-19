import { BOOTSTRAP_TIMEOUT_MS } from "./run-policy.js";

export const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = BOOTSTRAP_TIMEOUT_MS;

export type WorkspaceBootstrapStage = "workspace_installing" | "workspace_building";

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
	},
): Promise<void> {
	const dependencies = await container.exec(
		"test -d node_modules -a -f node_modules/.modules.yaml",
		{ cwd: options.repoDir },
	);
	if (dependencies.exitCode !== 0) {
		await options.onProgress("workspace_installing");
		const install = await container.exec("pnpm install --frozen-lockfile --prefer-offline", {
			cwd: options.repoDir,
			timeoutMs: WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
		});
		assertBootstrapSuccess(install, "dependency installation");
	}

	await options.onProgress("workspace_building");
	const build = await container.exec("pnpm build", {
		cwd: options.repoDir,
		timeoutMs: WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
	});
	assertBootstrapSuccess(build, "workspace build");
}

function assertBootstrapSuccess(
	result: { exitCode: number; stdout: string; stderr: string },
	stage: string,
): void {
	if (result.exitCode === 0) return;
	const output = (result.stderr || result.stdout || "no output").trim().slice(-1_000);
	throw new Error(`${stage} failed (${result.exitCode}): ${output}`);
}
