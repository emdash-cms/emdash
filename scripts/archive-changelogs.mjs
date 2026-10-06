#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_CHANGELOG_BYTES = 128 * 1024;

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm;
const ARCHIVE_MARKER = /<!--\s*emdash-changelog-archive:\s*(.+?)\s*-->/;
const ARCHIVE_MARKERS = new RegExp(ARCHIVE_MARKER.source, "g");
const ARCHIVE_HEADROOM = 512;

function bytes(value) {
	return Buffer.byteLength(value, "utf8");
}

function marker(path) {
	return `<!-- emdash-changelog-archive: ${path} -->`;
}

function releaseSections(source) {
	const releases = [...source.matchAll(RELEASE_HEADING)];
	return releases.map((release, index) => ({
		version: release[1],
		content: source.slice(release.index, releases[index + 1]?.index ?? source.length).trimEnd(),
	}));
}

function document(header, archive, sections) {
	const content = [
		header.trimEnd(),
		archive ? marker(archive) : null,
		...sections.map((section) => section.content),
	]
		.filter(Boolean)
		.join("\n\n");
	return `${content}\n`;
}

function archiveName(sections) {
	const newest = sections[0].version;
	const oldest = sections.at(-1).version;
	return `${oldest}-to-${newest}.md`;
}

function relativeMarker(fromDirectory, target) {
	const path = posix.relative(fromDirectory, target);
	return path.startsWith(".") ? path : `./${path}`;
}

export function splitChangelog(source, maxBytes = MAX_CHANGELOG_BYTES) {
	if (bytes(source) <= maxBytes) return { active: source, archives: [] };
	const existingArchive = source.match(ARCHIVE_MARKER)?.[1];
	// Changesets inserts new releases after the title line, so the marker can sit inside a release.
	const unmarked = source.replace(ARCHIVE_MARKERS, "");
	const sections = releaseSections(unmarked);
	if (sections.length < 2) return { active: source, archives: [] };
	const firstRelease = unmarked.search(RELEASE_HEADING);
	const header = unmarked.slice(0, firstRelease).trimEnd();
	const kept = [...sections];
	const moved = [];
	while (
		kept.length > 1 &&
		bytes(document(header, "./changelog/archive-placeholder.md", kept)) > maxBytes
	) {
		moved.unshift(kept.pop());
	}
	if (moved.length === 0) return { active: source, archives: [] };

	const chunks = [];
	let chunk = [];
	for (const section of moved) {
		if (
			chunk.length > 0 &&
			bytes(document("# Changelog archive", "./archive-placeholder.md", [...chunk, section])) +
				ARCHIVE_HEADROOM >
				maxBytes
		) {
			chunks.push(chunk);
			chunk = [];
		}
		chunk.push(section);
	}
	if (chunk.length > 0) chunks.push(chunk);

	const archives = chunks.map((archiveSections) => ({
		name: archiveName(archiveSections),
		sections: archiveSections,
	}));
	const existingTarget = existingArchive ? posix.normalize(posix.join(".", existingArchive)) : null;
	const rendered = archives.map((archive, index) => {
		const next = archives[index + 1];
		const nextTarget = next ? posix.join("changelog", next.name) : existingTarget;
		return {
			name: archive.name,
			content: document(
				"# Changelog archive",
				nextTarget ? relativeMarker("changelog", nextTarget) : null,
				archive.sections,
			),
		};
	});
	return {
		active: document(header, `./changelog/${rendered[0].name}`, kept),
		archives: rendered,
	};
}

async function packageChangelogs(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const changelogs = [];
	const names = new Set(entries.map((entry) => entry.name));
	if (names.has("package.json") && names.has("CHANGELOG.md")) {
		const path = join(directory, "CHANGELOG.md");
		if ((await stat(path)).isFile()) changelogs.push(path);
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || ["changelog", "dist", "node_modules"].includes(entry.name))
			continue;
		changelogs.push(...(await packageChangelogs(join(directory, entry.name))));
	}
	return changelogs;
}

export async function archiveChangelogs(root) {
	const changed = [];
	for (const changelogPath of await packageChangelogs(resolve(root, "packages"))) {
		const source = await readFile(changelogPath, "utf8");
		const result = splitChangelog(source);
		if (result.archives.length === 0) continue;
		const archiveDirectory = join(dirname(changelogPath), "changelog");
		await mkdir(archiveDirectory, { recursive: true });
		for (const archive of result.archives) {
			await writeFile(join(archiveDirectory, archive.name), archive.content);
		}
		await writeFile(changelogPath, result.active);
		changed.push(relative(root, changelogPath));
	}
	return changed;
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (scriptPath === import.meta.url) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const changed = await archiveChangelogs(root);
	if (changed.length > 0) {
		console.log(`Archived ${changed.length} changelog${changed.length === 1 ? "" : "s"}:`);
		for (const path of changed) console.log(`  ${path}`);
	}
}
