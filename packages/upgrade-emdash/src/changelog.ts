import { posix } from "node:path";

import semver from "semver";

import type {
	ChangeCategory,
	ChangelogEntry,
	ChangelogOccurrence,
	GitHubRepository,
} from "./types.js";

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm;
const CATEGORY_HEADING = /^### (Major|Minor|Patch) Changes\s*$/gm;
const ENTRY_START = /^- /gm;
const ARCHIVE_MARKER = /<!--\s*emdash-changelog-archive:\s*(.+?)\s*-->/;
const CHANGESET_WRAPPER =
	/^- (?:(\[#\d+\]\((https:\/\/github\.com\/[^)]+)\)) )?(\[`[^`]+`\]\((https:\/\/github\.com\/[^)]+)\)) Thanks .+?! - /;

interface ParsedEntry {
	version: string;
	category: ChangeCategory;
	body: string;
	source?: string;
}

function category(value: string): ChangeCategory {
	switch (value) {
		case "Major":
			return "major";
		case "Minor":
			return "minor";
		default:
			return "patch";
	}
}

function splitEntries(content: string): string[] {
	const starts = [...content.matchAll(ENTRY_START)];
	return starts.map((start, index) => {
		const from = start.index ?? 0;
		const to = starts[index + 1]?.index ?? content.length;
		return content.slice(from, to).trim();
	});
}

function normalizeEntry(entry: string): { body: string; source?: string } | null {
	if (entry.startsWith("- Updated dependencies [")) return null;
	const wrapper = entry.match(CHANGESET_WRAPPER);
	if (wrapper) {
		return {
			body: entry.slice(wrapper[0].length).trim(),
			source: wrapper[1] ?? wrapper[3],
		};
	}
	return { body: entry.slice(2).trim() };
}

export function parseChangelog(changelog: string): ParsedEntry[] {
	const releases = [...changelog.matchAll(RELEASE_HEADING)];
	return releases.flatMap((release, releaseIndex) => {
		const releaseStart = (release.index ?? 0) + release[0].length;
		const releaseEnd = releases[releaseIndex + 1]?.index ?? changelog.length;
		const releaseContent = changelog.slice(releaseStart, releaseEnd);
		const categories = [...releaseContent.matchAll(CATEGORY_HEADING)];
		return categories.flatMap((heading, categoryIndex) => {
			const start = (heading.index ?? 0) + heading[0].length;
			const end = categories[categoryIndex + 1]?.index ?? releaseContent.length;
			return splitEntries(releaseContent.slice(start, end)).flatMap((entry) => {
				const normalized = normalizeEntry(entry);
				return normalized
					? [{ version: release[1], category: category(heading[1]), ...normalized }]
					: [];
			});
		});
	});
}

function releaseVersions(changelog: string): string[] {
	return Array.from(changelog.matchAll(RELEASE_HEADING), (release) => release[1]);
}

export function entriesBetween(
	changelog: string,
	currentVersion: string,
	targetVersion: string,
): ParsedEntry[] {
	const includePrereleases = semver.prerelease(targetVersion) !== null;
	return parseChangelog(changelog).filter(
		(entry) =>
			(includePrereleases || semver.prerelease(entry.version) === null) &&
			semver.gt(entry.version, currentVersion) &&
			semver.lte(entry.version, targetVersion),
	);
}

function githubHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "upgrade-emdash",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	return headers;
}

function githubContentsUrl(repository: GitHubRepository, path: string, tag: string): string {
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(tag)}`;
}

async function fetchGitHubFile(
	repository: GitHubRepository,
	path: string,
	tag: string,
	fetcher: typeof fetch,
): Promise<string> {
	const response = await fetcher(githubContentsUrl(repository, path, tag), {
		headers: githubHeaders(),
	});
	if (!response.ok) {
		throw new Error(
			`GitHub could not fetch ${repository.owner}/${repository.repo}/${path} at ${tag} (${response.status} ${response.statusText}).`,
		);
	}
	const result: unknown = await response.json();
	const encoding =
		typeof result === "object" && result !== null ? Reflect.get(result, "encoding") : null;
	const content =
		typeof result === "object" && result !== null ? Reflect.get(result, "content") : null;
	if (encoding !== "base64" || typeof content !== "string") {
		throw new Error(`GitHub returned invalid changelog data for ${path} at ${tag}.`);
	}
	return Buffer.from(content.split("\n").join(""), "base64").toString("utf8");
}

function archivePath(
	currentPath: string,
	changelog: string,
	packageDirectory: string,
): string | null {
	const archive = changelog.match(ARCHIVE_MARKER)?.[1];
	if (!archive) return null;
	const path = posix.normalize(posix.join(posix.dirname(currentPath), archive));
	const normalizedDirectory = posix.normalize(packageDirectory);
	const directory = normalizedDirectory.endsWith("/")
		? normalizedDirectory.slice(0, -1)
		: normalizedDirectory;
	if (path !== directory && !path.startsWith(`${directory}/`)) {
		throw new Error(`Changelog archive ${archive} escapes ${packageDirectory}.`);
	}
	return path;
}

export async function fetchChangelogRange(
	repository: GitHubRepository,
	packageName: string,
	currentVersion: string,
	targetVersion: string,
	fetcher: typeof fetch = fetch,
): Promise<ChangelogEntry[]> {
	const tag = `${packageName}@${targetVersion}`;
	let path = posix.join(repository.directory, "CHANGELOG.md");
	const occurrences: Array<{ body: string; occurrence: ChangelogOccurrence }> = [];
	const visited = new Set<string>();
	for (;;) {
		if (visited.has(path)) throw new Error(`Changelog archive cycle detected at ${path}.`);
		visited.add(path);
		const changelog = await fetchGitHubFile(repository, path, tag, fetcher);
		for (const entry of entriesBetween(changelog, currentVersion, targetVersion)) {
			occurrences.push({
				body: entry.body,
				occurrence: {
					packageName,
					version: entry.version,
					category: entry.category,
					source: entry.source,
				},
			});
		}
		if (releaseVersions(changelog).some((version) => semver.lte(version, currentVersion))) {
			break;
		}
		const next = archivePath(path, changelog, repository.directory);
		if (!next) {
			throw new Error(
				`${packageName} changelog history at ${tag} does not reach the installed ${currentVersion}.`,
			);
		}
		path = next;
	}
	return deduplicateChangelog(occurrences);
}

export function deduplicateChangelog(
	entries: readonly { body: string; occurrence: ChangelogOccurrence }[],
): ChangelogEntry[] {
	const byBody = new Map<string, ChangelogEntry>();
	for (const entry of entries) {
		const existing = byBody.get(entry.body);
		if (existing) {
			existing.occurrences.push(entry.occurrence);
		} else {
			byBody.set(entry.body, { body: entry.body, occurrences: [entry.occurrence] });
		}
	}
	return [...byBody.values()];
}
