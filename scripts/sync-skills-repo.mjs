#!/usr/bin/env node

/**
 * Sync public agent skills from this monorepo to the standalone
 * emdash-cms/skills repo.
 *
 * - Copies each skill in SKILLS into the target repo's skills/ directory
 * - Removes skills from the target that are no longer in SKILLS
 * - Fails if a synced skill links to a file outside the synced set
 * - Commits and pushes straight to the target's default branch
 *
 * Runs after each release so the skills match the published packages.
 *
 * Only skills/ is managed here. Harness manifests, README, and LICENSE in the
 * target repo are maintained there.
 *
 * Usage:
 *   node scripts/sync-skills-repo.mjs            # full run: clone, sync, push
 *   node scripts/sync-skills-repo.mjs --check    # validate links only, no clone
 *   node scripts/sync-skills-repo.mjs --dry-run  # sync to temp dir, print diff, don't push
 *   node scripts/sync-skills-repo.mjs --local /path/to/repo  # sync to a local checkout
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const REPO = "emdash-cms/skills";

const SKILLS = [
	"building-emdash-site",
	"creating-plugins",
	"emdash-cli",
	"upgrading-emdash",
	"wordpress-plugin-to-emdash",
	"wordpress-theme-to-emdash",
];

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const RE_INLINE_CODE = /(`+).*?\1/g;
const RE_LINK_TARGETS = [
	/\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^\s()]*\)[^\s()]*)*))/g,
	/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm,
	/\b(?:href|src)\s*=\s*["']([^"'\n]+)["']/g,
];
const RE_EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

function listEntries(dir) {
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		entries.push({ path, isSymlink: entry.isSymbolicLink() });
		if (entry.isDirectory()) entries.push(...listEntries(path));
	}
	return entries;
}

function isWithin(child, parent) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function stripCode(markdown) {
	const kept = [];
	let fence = null;
	for (const line of markdown.split("\n")) {
		if (fence) {
			const close = line.match(RE_FENCE_CLOSE)?.[1];
			if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
			continue;
		}
		const open = line.match(RE_FENCE_OPEN)?.[1];
		if (open) {
			fence = open;
			continue;
		}
		kept.push(line.replace(RE_INLINE_CODE, ""));
	}
	return kept.join("\n");
}

function linkTargets(markdown) {
	const text = stripCode(markdown);
	return RE_LINK_TARGETS.flatMap((re) =>
		Array.from(text.matchAll(re), (match) => match.slice(1).find(Boolean)),
	);
}

/**
 * Relative links must resolve to a file inside one of the synced skills, so
 * a skill can't reach into the monorepo or depend on an unsynced sibling.
 */
function findBrokenLinks(skillsRoot, files) {
	const broken = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		for (const rawTarget of linkTargets(readFileSync(file, "utf8"))) {
			if (RE_EXTERNAL_TARGET.test(rawTarget)) continue;
			let target;
			try {
				target = resolve(dirname(file), decodeURIComponent(rawTarget.split("#")[0]));
			} catch {
				target = null;
			}
			const ok =
				target !== null &&
				existsSync(target) &&
				SKILLS.some((name) => isWithin(target, join(skillsRoot, name)));
			if (!ok) broken.push(`${relative(skillsRoot, file)} -> ${rawTarget}`);
		}
	}
	return broken;
}

function assertValid(skillsRoot) {
	const missing = SKILLS.filter((skill) => !existsSync(join(skillsRoot, skill, "SKILL.md")));
	if (missing.length > 0) {
		throw new Error(`Skills listed in SKILLS have no SKILL.md: ${missing.join(", ")}`);
	}
	const entries = SKILLS.flatMap((skill) => listEntries(join(skillsRoot, skill)));
	const symlinks = entries.filter((entry) => entry.isSymlink);
	if (symlinks.length > 0) {
		throw new Error(
			[
				"Synced skills must not contain symlinks:",
				...symlinks.map((entry) => `  ${relative(skillsRoot, entry.path)}`),
			].join("\n"),
		);
	}
	const broken = findBrokenLinks(
		skillsRoot,
		entries.map((entry) => entry.path),
	);
	if (broken.length > 0) {
		throw new Error(
			[
				"Synced skills link to files outside the synced set.",
				"Add the target skill to SKILLS in scripts/sync-skills-repo.mjs or remove the link:",
				...broken.map((link) => `  ${link}`),
			].join("\n"),
		);
	}
}

function git(args, cwd) {
	return execFileSync("git", args, { encoding: "utf8", stdio: "pipe", cwd }).trim();
}

function syncSkills(destSkillsDir) {
	if (existsSync(destSkillsDir)) {
		if (lstatSync(destSkillsDir).isSymbolicLink()) {
			throw new Error(`${destSkillsDir} is a symlink; refusing to prune through it`);
		}
		for (const entry of readdirSync(destSkillsDir, { withFileTypes: true })) {
			if (!SKILLS.includes(entry.name)) {
				rmSync(join(destSkillsDir, entry.name), { recursive: true, force: true });
				console.log(`Removed ${entry.name}`);
			}
		}
	}
	for (const skill of SKILLS) {
		const dest = join(destSkillsDir, skill);
		rmSync(dest, { recursive: true, force: true });
		cpSync(join(SKILLS_DIR, skill), dest, { recursive: true });
		console.log(`Synced ${skill}`);
	}
}

function commitAndPush(targetDir, { dryRun, localPath }) {
	git(["add", "-A", "skills"], targetDir);
	const diff = git(["diff", "--cached", "--stat"], targetDir);
	if (!diff) {
		console.log("No changes to sync.");
		return false;
	}

	console.log("Changes:");
	console.log(diff);
	console.log("");

	if (dryRun || localPath) {
		console.log("Not pushing.");
		return true;
	}

	const sourceSha = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"], ROOT);
	const sourceRepo = process.env.GITHUB_REPOSITORY || "emdash-cms/emdash";
	const { version } = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8"));

	if (process.env.CI) {
		git(["config", "user.name", "github-actions[bot]"], targetDir);
		git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"], targetDir);
	}

	git(
		[
			"commit",
			"-m",
			`chore: sync skills from emdash v${version}`,
			"-m",
			`Source: https://github.com/${sourceRepo}/commit/${sourceSha}`,
		],
		targetDir,
	);
	git(["push", "origin", "HEAD"], targetDir);
	console.log(`Pushed to ${REPO}`);
	return false;
}

// --- main ---

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const dryRun = args.includes("--dry-run");
const localIdx = args.indexOf("--local");
const localPath = localIdx !== -1 ? args[localIdx + 1] : null;
if (localIdx !== -1 && !localPath) {
	console.error("Error: --local requires a path argument");
	process.exit(1);
}

try {
	assertValid(SKILLS_DIR);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

if (checkOnly) {
	console.log(`All ${SKILLS.length} synced skills are self-contained.`);
	process.exit(0);
}

let targetDir;
let tempDir;

if (localPath) {
	targetDir = resolve(localPath);
	if (!existsSync(join(targetDir, ".git"))) {
		console.error(`Error: ${targetDir} is not a git repository`);
		process.exit(1);
	}
} else {
	tempDir = mkdtempSync(join(tmpdir(), "emdash-skills-"));
	console.log(`Cloning ${REPO} to ${tempDir}...`);
	execFileSync("gh", ["repo", "clone", REPO, tempDir, "--", "--depth", "1"], {
		stdio: "pipe",
	});
	// Configure git credential helper so push works with GH_TOKEN
	execFileSync("gh", ["auth", "setup-git"], { stdio: "pipe" });
	targetDir = tempDir;
}

let preserveTempDir = false;
try {
	syncSkills(join(targetDir, "skills"));
	console.log("");
	preserveTempDir = commitAndPush(targetDir, { dryRun, localPath });
} finally {
	if (tempDir && preserveTempDir) console.log(`Temp dir preserved at: ${tempDir}`);
	else if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
