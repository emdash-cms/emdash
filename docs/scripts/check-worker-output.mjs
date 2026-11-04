import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dirname, "..");
const deployConfigPath = resolve(docsDirectory, ".wrangler/deploy/config.json");
const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8"));
const workerConfigPath = resolve(dirname(deployConfigPath), deployConfig.configPath);
const workerConfig = JSON.parse(readFileSync(workerConfigPath, "utf8"));
const workerDirectory = dirname(workerConfigPath);

if (
	typeof workerConfig.main !== "string" ||
	!existsSync(resolve(workerDirectory, workerConfig.main))
) {
	throw new Error("The generated Cloudflare deployment does not contain a Worker entrypoint.");
}

if (
	workerConfig.assets?.binding !== "ASSETS" ||
	typeof workerConfig.assets.directory !== "string" ||
	!existsSync(resolve(workerDirectory, workerConfig.assets.directory))
) {
	throw new Error("The generated Cloudflare Worker does not contain the static asset binding.");
}

if (!workerConfig.ai_search?.some(({ binding }) => binding === "AI_SEARCH")) {
	throw new Error("The generated Cloudflare Worker does not contain the docs search binding.");
}

console.log("Generated Cloudflare deployment contains the docs Worker and static assets.");
