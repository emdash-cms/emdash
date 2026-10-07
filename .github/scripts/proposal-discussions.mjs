#!/usr/bin/env node
// proposal-discussions.mjs -- keep the Ideas Discussions linked from a proposal's
// front matter in step with its design and implementation.
//
// Usage:
//   node .github/scripts/proposal-discussions.mjs design-pr --pr <number>
//       Comment on each linked Ideas Discussion that a design PR now proposes it.
//   node .github/scripts/proposal-discussions.mjs push --before <sha> --after <sha>
//       For proposals that became `accepted` or `implemented` on main, comment on
//       each linked Ideas Discussion with the merged PR, closing it on `implemented`.
//
// Requires an authenticated `gh` CLI and GITHUB_REPOSITORY. Proposal content is
// read through the API and only parsed, never executed.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROPOSAL_PATH = /^proposals\/(?!README\.md$)(?!.*-template\.md$)[^/]+\.md$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const STATUS = /^status:\s*["']?([\w-]+)/m;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const DESIGN_TITLE = /^design:/i;
const ZERO_SHA = /^0+$/;
const IDEAS_CATEGORY = "ideas";
const ANNOUNCED_STATUSES = new Set(["accepted", "implemented"]);

export function isProposalPath(path) {
	return PROPOSAL_PATH.test(path);
}

export function isDesignPullRequest({ title, body }) {
	return (body ?? "").includes("<!-- design-pr -->") || DESIGN_TITLE.test(title ?? "");
}

export function parseProposal(text, repo) {
	const frontMatter = text.match(FRONT_MATTER)?.[1];
	if (frontMatter === undefined) return null;

	const status = frontMatter.match(STATUS)?.[1] ?? null;
	const escapedRepo = repo.replace(REGEX_SPECIAL, "\\$&");
	const linkPattern = new RegExp(`https://github\\.com/${escapedRepo}/discussions/(\\d+)`, "gi");
	const discussions = Array.from(frontMatter.matchAll(linkPattern), (match) => Number(match[1]));

	return { status, discussions: [...new Set(discussions)] };
}

// Returns the status a proposal newly reached (`accepted` or `implemented`), its
// linked discussions, and whether to close them, or null when there is nothing
// to announce.
export function statusTransition(beforeText, afterText, repo) {
	if (afterText === null) return null;
	const after = parseProposal(afterText, repo);
	if (!after || !ANNOUNCED_STATUSES.has(after.status)) return null;
	const before = beforeText === null ? null : parseProposal(beforeText, repo);
	if (before?.status === after.status) return null;
	if (before?.status === "implemented") return null;
	return {
		status: after.status,
		discussions: after.discussions,
		close: after.status === "implemented",
	};
}

function gh(args, { allowNotFound = false } = {}) {
	const result = spawnSync("gh", args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const stderr = (result.stderr || "").trim();
		if (allowNotFound && stderr.includes("HTTP 404")) return null;
		throw new Error(stderr || `gh exited with status ${result.status}`);
	}
	return result.stdout;
}

function graphql(query, variables) {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [key, value] of Object.entries(variables)) {
		args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
	}
	return JSON.parse(gh(args)).data;
}

function readFileAt(repo, path, ref) {
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	return gh(
		[
			"api",
			"-H",
			"Accept: application/vnd.github.raw",
			`repos/${repo}/contents/${encodedPath}?ref=${ref}`,
		],
		{ allowNotFound: true },
	);
}

function fileUrl(repo, ref, path) {
	return `https://github.com/${repo}/blob/${ref}/${path}`;
}

function getDiscussion(repo, number) {
	const [owner, name] = repo.split("/");
	return graphql(
		"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){id closed category{slug} comments(last:100){nodes{body}}}}}",
		{ owner, name, number },
	).repository.discussion;
}

// Posts `body` once per `marker`, and closes the discussion when `close` is set.
// Discussions outside the Ideas category are left alone.
function updateDiscussion(repo, number, { marker, body, close }) {
	const discussion = getDiscussion(repo, number);
	if (!discussion) {
		console.warn(`Discussion #${number} does not exist; skipping.`);
		return;
	}
	if (discussion.category?.slug !== IDEAS_CATEGORY) {
		console.log(`Discussion #${number} is not an Ideas Discussion; skipping.`);
		return;
	}

	const markerComment = `<!-- proposal-discussions:${marker} -->`;
	if (discussion.comments.nodes.some((comment) => comment.body.includes(markerComment))) {
		console.log(`Discussion #${number} already has this update.`);
	} else {
		graphql(
			"mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id}}}",
			{ id: discussion.id, body: `${markerComment}\n${body}` },
		);
		console.log(`Commented on discussion #${number}.`);
	}

	if (close && !discussion.closed) {
		graphql(
			"mutation($id:ID!){closeDiscussion(input:{discussionId:$id,reason:RESOLVED}){discussion{id}}}",
			{ id: discussion.id },
		);
		console.log(`Closed discussion #${number}.`);
	}
}

function announceDesignPullRequest(repo, number) {
	const pull = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
	if (!isDesignPullRequest(pull)) {
		console.log(`#${number} is not a design PR.`);
		return;
	}

	const files = JSON.parse(
		gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`]),
	).flat();
	for (const file of files) {
		if (!isProposalPath(file.filename) || file.status === "removed") continue;
		const text = readFileAt(repo, file.filename, pull.head.sha);
		const proposal = text === null ? null : parseProposal(text, repo);
		if (!proposal) continue;

		const body = `Design PR #${number} proposes [\`${file.filename}\`](${fileUrl(repo, pull.head.sha, file.filename)}) for this Idea. Review of the design continues on the pull request.`;
		for (const discussion of proposal.discussions) {
			updateDiscussion(repo, discussion, {
				marker: `design:${number}:${file.filename}`,
				body,
				close: false,
			});
		}
	}
}

function changedProposals(repo, before, after) {
	const compare = JSON.parse(gh(["api", `repos/${repo}/compare/${before}...${after}`]));
	return (compare.files ?? [])
		.filter((file) => isProposalPath(file.filename) && file.status !== "removed")
		.map((file) => ({
			path: file.filename,
			previousPath: file.status === "added" ? null : (file.previous_filename ?? file.filename),
		}));
}

function mergedPullRequest(repo, sha) {
	const pulls = JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/pulls`]));
	return pulls.find((pull) => pull.merged_at)?.number ?? null;
}

function announceStatusChanges(repo, before, after) {
	if (ZERO_SHA.test(before)) {
		console.log("No previous commit to compare against.");
		return;
	}

	const pullRequest = mergedPullRequest(repo, after);
	const source =
		pullRequest === null ? `https://github.com/${repo}/commit/${after}` : `#${pullRequest}`;
	for (const { path, previousPath } of changedProposals(repo, before, after)) {
		const beforeText = previousPath === null ? null : readFileAt(repo, previousPath, before);
		const afterText = readFileAt(repo, path, after);
		const transition = statusTransition(beforeText, afterText, repo);
		if (!transition) continue;

		const link = `[\`${path}\`](${fileUrl(repo, "main", path)})`;
		const body =
			transition.status === "accepted"
				? `Accepted in ${source}. The design for this Idea is now the plan of record in ${link}, and this Discussion closes when it is implemented.`
				: `Implemented in ${source}. The proposal ${link} is now marked implemented, so this Discussion is closed as resolved.`;
		for (const discussion of transition.discussions) {
			updateDiscussion(repo, discussion, {
				marker: `${transition.status}:${path}`,
				body,
				close: transition.close,
			});
		}
	}
}

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function main() {
	const [command, ...args] = process.argv.slice(2);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		console.error("GITHUB_REPOSITORY must be set.");
		process.exit(1);
	}

	if (command === "design-pr" && option(args, "--pr")) {
		announceDesignPullRequest(repo, Number(option(args, "--pr")));
	} else if (command === "push" && option(args, "--before") && option(args, "--after")) {
		announceStatusChanges(repo, option(args, "--before"), option(args, "--after"));
	} else {
		console.error(
			"Usage: proposal-discussions.mjs design-pr --pr <number> | push --before <sha> --after <sha>",
		);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
