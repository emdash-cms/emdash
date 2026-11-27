import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LINE_BREAK = /\r?\n/;
const WHITESPACE = /\s+/;
const REDIRECT_STATUS = /^30[12378]!?$/;

export function readDocsBuildOutput(docsDirectory = resolve(import.meta.dirname, "../..")) {
	const deployConfigPath = resolve(docsDirectory, ".wrangler/deploy/config.json");
	const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8"));
	const workerConfigPath = resolve(dirname(deployConfigPath), deployConfig.configPath);
	const workerConfig = JSON.parse(readFileSync(workerConfigPath, "utf8"));
	const workerDirectory = dirname(workerConfigPath);
	const assetsDirectory =
		typeof workerConfig.assets?.directory === "string"
			? resolve(workerDirectory, workerConfig.assets.directory)
			: undefined;
	const redirects = {};
	const redirectsPath = assetsDirectory && resolve(assetsDirectory, "_redirects");
	if (redirectsPath && existsSync(redirectsPath)) {
		for (const line of readFileSync(redirectsPath, "utf8").split(LINE_BREAK)) {
			const [from, destination, status] = line.trim().split(WHITESPACE);
			if (
				!from?.startsWith("/") ||
				from.includes("*") ||
				from.includes(":") ||
				!destination ||
				!REDIRECT_STATUS.test(status ?? "302")
			)
				continue;
			redirects[from] ??= destination;
		}
	}
	return { assetsDirectory, redirects };
}
