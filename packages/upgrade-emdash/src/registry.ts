import type { GitHubRepository } from "./types.js";

export interface RegistryRelease {
	name: string;
	version: string;
	repository?: GitHubRepository;
}

const GITHUB_REPOSITORY = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i;

function githubRepository(value: unknown): GitHubRepository | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const url = Reflect.get(value, "url");
	const directory = Reflect.get(value, "directory");
	if (typeof url !== "string" || typeof directory !== "string") return undefined;
	const match = url.match(GITHUB_REPOSITORY);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2], directory };
}

export async function resolveRegistryRelease(
	name: string,
	tag: string,
	fetcher: typeof fetch = fetch,
): Promise<RegistryRelease> {
	const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
	const response = await fetcher(url, {
		headers: { Accept: "application/json", "User-Agent": "upgrade-emdash" },
	});
	if (!response.ok) {
		throw new Error(
			`npm could not resolve ${name}@${tag} (${response.status} ${response.statusText}).`,
		);
	}
	const metadata: unknown = await response.json();
	const metadataName =
		typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "name") : null;
	const version =
		typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "version") : null;
	const repository =
		typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "repository") : null;
	if (metadataName !== name || typeof version !== "string") {
		throw new Error(`npm returned invalid metadata for ${name}@${tag}.`);
	}
	return {
		name,
		version,
		repository: githubRepository(repository),
	};
}
