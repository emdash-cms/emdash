import { readFile } from "node:fs/promises";

const CLI_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export async function installedCliVersion(): Promise<string> {
	const parsed: unknown = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Plugin CLI package metadata is invalid.");
	}
	const version = Reflect.get(parsed, "version");
	if (typeof version !== "string" || !CLI_VERSION_PATTERN.test(version)) {
		throw new Error("Plugin CLI package version is invalid.");
	}
	return version;
}
