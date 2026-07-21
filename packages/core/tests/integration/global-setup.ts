import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");

export default async function setupIntegrationBuild(): Promise<void> {
	console.log("[integration] Running pnpm build...");
	await execAsync("pnpm", ["build"], {
		cwd: WORKSPACE_ROOT,
		timeout: 120_000,
	});
	console.log("[integration] Build complete.");
}
