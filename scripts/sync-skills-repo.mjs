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
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
	"wordpress-plugin-to-emdash",
	"wordpress-theme-to-emdash",
];

const RE_FENCED_BLOCK = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const RE_INLINE_CODE = /(`+)[\s\S]*?\1/g;
const RE_MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const RE_EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

function isInside(child, parent) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * Relative links must resolve to a file inside one of the synced skills, so
 * a skill can't reach into the monorepo or depend on an unsynced sibling.
 */
function findBrokenLinks(skillsRoot) {
	const broken = [];
	for (const skill of SKILLS) {
		for (const file of listFiles(join(skillsRoot, skill))) {
			if (!file.endsWith(".md")) continue;
			const text = readFileSync(file, "utf8")
				.replace(RE_FENCED_BLOCK, "")
				.replace(RE_INLINE_CODE, "");
			for (const [, rawTarget] of text.matchAll(RE_MARKDOWN_LINK)) {
				if (RE_EXTERNAL_TARGET.test(rawTarget)) continue;
				const target = resolve(dirname(file), decodeURIComponent(rawTarget.split("#")[0]));
				const ok =
					existsSync(target) && SKILLS.some((name) => isInside(target, join(skillsRoot, name)));
				if (!ok) broken.push(`${relative(skillsRoot, file)} -> ${rawTarget}`);
			}
		}
	}
	return broken;
}

function assertValid(skillsRoot) {
	const missing = SKILLS.filter((skill) => !existsSync(join(skillsRoot, skill, "SKILL.md")));
	if (missing.length > 0) {
		throw new Error(`Skills listed in SKILLS have no SKILL.md: ${missing.join(", ")}`);
	}
	const broken = findBrokenLinks(skillsRoot);
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
		cpSync(join(SKILLS_DIR, skill), dest, { recursive: true, dereference: true });
		console.log(`Synced ${skill}`);
	}
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

try {
	syncSkills(join(targetDir, "skills"));
	console.log("");

	git(["add", "-A", "skills"], targetDir);
	const diff = git(["diff", "--cached", "--stat"], targetDir);
	if (!diff) {
		console.log("No changes to sync.");
		process.exit(0);
	}

	console.log("Changes:");
	console.log(diff);
	console.log("");

	if (dryRun || localPath) {
		console.log("Not pushing.");
		if (tempDir) {
			console.log(`Temp dir preserved at: ${tempDir}`);
			tempDir = undefined;
		}
		process.exit(0);
	}

	const sourceSha = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"], ROOT);
	const sourceRepo = process.env.GITHUB_REPOSITORY || "emdash-cms/emdash";

	if (process.env.CI) {
		git(["config", "user.name", "github-actions[bot]"], targetDir);
		git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"], targetDir);
	}

	git(
		[
			"commit",
			"-m",
			`chore: sync skills from ${sourceRepo}@${sourceSha.slice(0, 12)}`,
			"-m",
			`Source: https://github.com/${sourceRepo}/commit/${sourceSha}`,
		],
		targetDir,
	);
	git(["push", "origin", "HEAD"], targetDir);
	console.log(`Pushed to ${REPO}`);
} finally {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
