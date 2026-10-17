// pr-staleness.mjs -- stale and unsigned-CLA policy for the PR sweep.
//
// `updated_at` moves on every label change and bot comment, including the stale
// sweep's own warning, so it cannot measure inactivity.

const OPEN_PULL_REQUESTS_QUERY = `
	query($owner: String!, $repo: String!, $cursor: String) {
		repository(owner: $owner, name: $repo) {
			pullRequests(states: OPEN, first: 50, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes {
					number
					createdAt
					commits(last: 1) { nodes { commit { committedDate } } }
					comments(last: 50) { nodes { createdAt author { __typename } } }
					reviews(last: 50) { nodes { submittedAt author { __typename } } }
					timelineItems(itemTypes: [REOPENED_EVENT], last: 1) {
						nodes { ... on ReopenedEvent { createdAt actor { __typename } } }
					}
				}
			}
		}
	}
`;

// A deleted account has a null author; count it as human activity.
function isHuman(author) {
	return author?.__typename !== "Bot";
}

export function lastHumanActivity(pullRequest) {
	const timestamps = [
		pullRequest.createdAt,
		...(pullRequest.commits?.nodes ?? []).map((node) => node.commit.committedDate),
		...(pullRequest.comments?.nodes ?? [])
			.filter((comment) => isHuman(comment.author))
			.map((comment) => comment.createdAt),
		...(pullRequest.reviews?.nodes ?? [])
			.filter((review) => isHuman(review.author))
			.map((review) => review.submittedAt),
		...(pullRequest.timelineItems?.nodes ?? [])
			.filter((reopened) => isHuman(reopened.actor))
			.map((reopened) => reopened.createdAt),
	];
	const latest = Math.max(...timestamps.filter(Boolean).map((timestamp) => Date.parse(timestamp)));
	return new Date(latest);
}

// Returns a Map of PR number to the Date of its last human activity.
export async function fetchHumanActivity(github, owner, repo) {
	const activity = new Map();
	let cursor = null;
	do {
		const { repository } = await github.graphql(OPEN_PULL_REQUESTS_QUERY, { owner, repo, cursor });
		const page = repository.pullRequests;
		for (const pullRequest of page.nodes) {
			activity.set(pullRequest.number, lastHumanActivity(pullRequest));
		}
		cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (cursor);
	return activity;
}

const DAY = 24 * 60 * 60 * 1000;
const CLA_REMIND_AFTER = 1 * DAY;
const CLA_CLOSE_AFTER = 7 * DAY;
const CLA_REMINDER_NOTICE = 6 * DAY;
const STALE_WARN_AFTER = 14 * DAY;
const STALE_CLOSE_AFTER_WARNING = 7 * DAY;

function waitingOnAuthor({ isDraft, labels, mergeable }) {
	if (isDraft) return "draft";
	if (labels.has("review/awaiting-author")) return "changes-requested";
	if (mergeable === false) return "conflicts";
	return null;
}

/**
 * Decides what the sweep does with one open PR.
 *
 * An unsigned CLA runs on its own clock from when the PR opened: a reminder after
 * a day, and a close at seven days once the reminder has stood for six. Otherwise
 * a PR goes stale only while it waits on its author, measured from the last human
 * activity: a warning after 14 days, then a close 7 days after a warning that no
 * human activity has answered.
 *
 * @returns {{ action: "none" | "cla-remind" | "cla-close" | "stale-warn" | "stale-close",
 *   stale: boolean, reason: "draft" | "changes-requested" | "conflicts" | null }}
 */
export function sweepAction({
	now,
	createdAt,
	isBotAuthor,
	isDraft,
	isDesign = false,
	labels,
	mergeable,
	lastActivity,
	claReminderAt,
	staleWarningAt,
}) {
	const none = { action: "none", stale: false, reason: null };
	if (isBotAuthor) return none;

	if (labels.has("cla: needed") && !labels.has("cla: signed")) {
		const age = now - createdAt;
		if (!claReminderAt) return age >= CLA_REMIND_AFTER ? { ...none, action: "cla-remind" } : none;
		if (age >= CLA_CLOSE_AFTER && now - claReminderAt >= CLA_REMINDER_NOTICE) {
			return { ...none, action: "cla-close" };
		}
		return none;
	}

	if (labels.has("blocked")) return none;
	const reason = waitingOnAuthor({ isDraft, labels, mergeable });
	if (!reason) return none;

	if (staleWarningAt && staleWarningAt > lastActivity) {
		const action =
			!isDesign && now - staleWarningAt >= STALE_CLOSE_AFTER_WARNING ? "stale-close" : "none";
		return { action, stale: true, reason };
	}
	if (now - lastActivity >= STALE_WARN_AFTER) return { action: "stale-warn", stale: true, reason };
	return { action: "none", stale: false, reason };
}
