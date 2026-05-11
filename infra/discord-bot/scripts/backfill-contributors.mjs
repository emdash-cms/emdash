/**
 * Backfill contributor:{github_id} KV keys from merged PR history.
 *
 * Usage:
 *   node --env-file=.dev.vars scripts/backfill-contributors.mjs
 *
 * Requires: GITHUB_OWNER_LOGIN, and a GITHUB_TOKEN with repo read access
 * (or no token for public repos, but you'll hit rate limits fast).
 *
 * Uses wrangler kv:key put under the hood, so wrangler must be available.
 */

import { execSync } from "node:child_process";

const owner = "emdash-cms";
const repo = "emdash";
const ownerLogin = process.env.GITHUB_OWNER_LOGIN || "ascorbic";
const token = process.env.GITHUB_TOKEN;

const headers = {
	Accept: "application/vnd.github+json",
	"User-Agent": "emdash-discord-bot-backfill",
	"X-GitHub-Api-Version": "2022-11-28",
};
if (token) {
	headers.Authorization = `Bearer ${token}`;
}

const contributors = new Map(); // github_id -> github_login
let page = 1;
let hasMore = true;

console.log(`Fetching merged PRs from ${owner}/${repo}...`);

while (hasMore) {
	const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
	const res = await fetch(url, { headers });

	if (!res.ok) {
		console.error(`GitHub API error (${res.status}): ${await res.text()}`);
		process.exit(1);
	}

	const prs = await res.json();
	if (prs.length === 0) {
		hasMore = false;
		break;
	}

	for (const pr of prs) {
		if (!pr.merged_at) continue;

		const login = pr.user.login;
		const id = pr.user.id;

		// Skip owner and bots
		if (login === ownerLogin || login.endsWith("[bot]")) continue;

		if (!contributors.has(id)) {
			contributors.set(id, login);
		}
	}

	console.log(`  Page ${page}: ${prs.length} PRs, ${contributors.size} unique contributors so far`);
	page++;

	// Respect rate limits
	const remaining = res.headers.get("x-ratelimit-remaining");
	if (remaining === "0") {
		const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
		const wait = Math.max(0, reset - Date.now()) + 1000;
		console.log(`  Rate limited, waiting ${Math.ceil(wait / 1000)}s...`);
		await new Promise((r) => setTimeout(r, wait));
	}
}

console.log(`\nFound ${contributors.size} unique contributors. Writing to KV...\n`);

let written = 0;
for (const [id, login] of contributors) {
	const key = `contributor:${id}`;
	try {
		execSync(
			`pnpm wrangler kv key put --remote --namespace-id=2a5c0ec09f364546a10f2fa49e1ebaf4 "${key}" "${login}"`,
			{ stdio: "pipe" },
		);
		written++;
		if (written % 10 === 0) {
			console.log(`  ${written}/${contributors.size} written`);
		}
	} catch (err) {
		console.error(`  Failed to write ${key}: ${err.message}`);
	}
}

console.log(`\nDone. Wrote ${written} contributor keys to KV.`);
