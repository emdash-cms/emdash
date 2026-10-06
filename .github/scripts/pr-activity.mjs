// pr-activity.mjs -- when a human last touched each open PR, for stale detection.
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
