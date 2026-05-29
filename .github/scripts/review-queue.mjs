#!/usr/bin/env node
// review-queue.mjs -- maintainer CLI for the review/* label workflow.
//
// Zero external deps: only node: builtins, shelling out to `gh`.
//
// Usage:
//   node .github/scripts/review-queue.mjs [list]            List open PRs grouped by review state.
//   node .github/scripts/review-queue.mjs request <pr>...   Post `/review` on one or more PRs.
//   node .github/scripts/review-queue.mjs request --needs-review
//                                                           Post `/review` on every PR labeled
//                                                           review/needs-review.
//   node .github/scripts/review-queue.mjs --help            Show this help.
//
// Options:
//   --repo <owner/name>   Target repo (default: detected via `gh repo view`).
//
// Requires an authenticated `gh` CLI.

import { spawnSync } from "node:child_process";

// --- gh helpers -------------------------------------------------------------

// Run a gh command, returning stdout. On non-zero exit, print stderr and exit 1.
function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8" });
	if (result.error) {
		console.error(`Failed to run gh: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		const stderr = (result.stderr || "").trim();
		console.error(stderr || `gh exited with status ${result.status}`);
		process.exit(1);
	}
	return result.stdout;
}

function detectRepo() {
	const out = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	return out.trim();
}

// --- review state derivation ------------------------------------------------

const STATE_ORDER = ["needs-rereview", "needs-review", "awaiting-author", "approved", "unlabeled"];

// PR number argument: optional leading "#", then digits.
const PR_NUMBER_RE = /^#?\d+$/;
const PR_HASH_RE = /^#/;

// Derive a PR's review state from its review/* label.
function reviewState(pr) {
	const labels = new Set((pr.labels || []).map((l) => l.name));
	for (const state of STATE_ORDER) {
		if (state === "unlabeled") continue;
		if (labels.has(`review/${state}`)) return state;
	}
	return "unlabeled";
}

// Collect the size/* and area/* labels for display.
function tagLabels(pr) {
	return (pr.labels || [])
		.map((l) => l.name)
		.filter((n) => n.startsWith("size/") || n.startsWith("area/"));
}

// Derive a coarse CI status from the statusCheckRollup array.
function ciStatus(pr) {
	const rollup = pr.statusCheckRollup || [];
	if (rollup.length === 0) return "none";
	let pending = false;
	let failed = false;
	for (const check of rollup) {
		// Check runs use `status` + `conclusion`; status contexts use `state`.
		const conclusion = (check.conclusion || "").toUpperCase();
		const status = (check.status || "").toUpperCase();
		const state = (check.state || "").toUpperCase();

		if (status && status !== "COMPLETED") {
			// IN_PROGRESS, QUEUED, PENDING, WAITING, etc.
			pending = true;
			continue;
		}
		if (
			["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
				conclusion,
			)
		) {
			failed = true;
			continue;
		}
		if (["FAILURE", "ERROR"].includes(state)) {
			failed = true;
			continue;
		}
		if (["PENDING", "EXPECTED"].includes(state)) {
			pending = true;
			continue;
		}
		// SUCCESS / NEUTRAL / SKIPPED count as pass.
	}
	if (failed) return "fail";
	if (pending) return "pending";
	return "pass";
}

function ageInDays(createdAt) {
	const created = new Date(createdAt).getTime();
	if (Number.isNaN(created)) return 0;
	return Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
}

function truncate(str, max) {
	const s = str || "";
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "\u2026";
}

// --- commands ---------------------------------------------------------------

function fetchOpenPrs(repo) {
	const out = gh([
		"pr",
		"list",
		"--repo",
		repo,
		"--state",
		"open",
		"--limit",
		"200",
		"--json",
		"number,title,labels,createdAt,updatedAt,author,isDraft,mergeable,reviewDecision,statusCheckRollup",
	]);
	try {
		return JSON.parse(out);
	} catch (e) {
		console.error(`Could not parse gh output: ${e.message}`);
		process.exit(1);
	}
}

function cmdList(repo) {
	const prs = fetchOpenPrs(repo);

	// Bucket PRs by derived state.
	const groups = new Map(STATE_ORDER.map((s) => [s, []]));
	for (const pr of prs) {
		groups.get(reviewState(pr)).push(pr);
	}

	console.log(`Open PRs in ${repo}: ${prs.length}`);
	console.log("");

	for (const state of STATE_ORDER) {
		const bucket = groups.get(state);
		console.log(`== ${state} (${bucket.length}) ==`);
		if (bucket.length === 0) {
			console.log("  (none)");
			console.log("");
			continue;
		}
		// Sort oldest-first within a group so the most stale floats to the top.
		bucket.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
		for (const pr of bucket) {
			const num = `#${pr.number}`.padEnd(6);
			const title = truncate(pr.title, 60).padEnd(60);
			const author = `(${pr.author?.login || "unknown"})`.padEnd(20);
			const tags = tagLabels(pr).join(",");
			const tagCol = `[${tags}]`.padEnd(24);
			const age = `${ageInDays(pr.createdAt)}d`.padEnd(5);
			const ci = `CI:${ciStatus(pr)}`.padEnd(11);
			const mergeable = (pr.mergeable || "UNKNOWN").toLowerCase();
			console.log(`  ${num} ${title} ${author} ${tagCol} ${age} ${ci} ${mergeable}`);
		}
		console.log("");
	}
}

function postReview(repo, number) {
	gh(["pr", "comment", String(number), "--repo", repo, "--body", "/review"]);
	console.log(`Requested review on #${number}`);
}

function cmdRequest(repo, args) {
	if (args.includes("--needs-review")) {
		const prs = fetchOpenPrs(repo);
		const targets = prs.filter((pr) =>
			(pr.labels || []).some((l) => l.name === "review/needs-review"),
		);
		if (targets.length === 0) {
			console.log("No PRs labeled review/needs-review.");
			return;
		}
		console.log(
			`Requesting review on ${targets.length} PR(s): ${targets.map((p) => `#${p.number}`).join(", ")}`,
		);
		for (const pr of targets) {
			postReview(repo, pr.number);
		}
		return;
	}

	const numbers = args.filter((a) => PR_NUMBER_RE.test(a)).map((a) => a.replace(PR_HASH_RE, ""));
	if (numbers.length === 0) {
		console.error("request: provide one or more PR numbers, or --needs-review");
		process.exit(1);
	}
	for (const number of numbers) {
		postReview(repo, number);
	}
}

function printHelp() {
	console.log(
		[
			"review-queue.mjs -- maintainer CLI for the review/* label workflow",
			"",
			"Usage:",
			"  review-queue.mjs [list]                  List open PRs grouped by review state",
			"  review-queue.mjs request <pr>...         Post /review on one or more PRs",
			"  review-queue.mjs request --needs-review  Post /review on every review/needs-review PR",
			"  review-queue.mjs --help                  Show this help",
			"",
			"Options:",
			"  --repo <owner/name>   Target repo (default: detected via gh repo view)",
			"",
			"Requires an authenticated gh CLI.",
		].join("\n"),
	);
}

// --- arg parsing ------------------------------------------------------------

function main() {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		printHelp();
		return;
	}

	// Pull out --repo <value> if present; the rest are positional.
	let repoOverride;
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--repo") {
			repoOverride = argv[i + 1];
			i++;
			continue;
		}
		rest.push(argv[i]);
	}

	const repo = repoOverride || detectRepo();
	const command = rest[0] || "list";

	switch (command) {
		case "list":
			cmdList(repo);
			break;
		case "request":
			cmdRequest(repo, rest.slice(1));
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exit(1);
	}
}

main();
