// GitHub webhook signature verification and pull_request event gating.

const encoder = new TextEncoder();

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body using
 * the shared webhook secret (HMAC-SHA256). Constant-time comparison.
 */
export async function verifyWebhookSignature(
	secret: string,
	rawBody: string,
	signatureHeader: string | undefined | null,
): Promise<boolean> {
	if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
	const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export interface GatedPr {
	prNumber: number;
	prTitle: string;
	prBody: string;
	headRef: string;
	baseRef: string;
	owner: string;
	repo: string;
}

export type GateDecision = { review: true; pr: GatedPr } | { review: false; reason: string };

// Actions that warrant a (re-)review. `synchronize` = new commits pushed.
const REVIEWABLE_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
// Manual trigger: applying this label to a PR.
const MANUAL_LABEL = "bot:review";

interface PullRequestEvent {
	action?: string;
	label?: { name?: string };
	pull_request?: {
		number?: number;
		title?: string;
		body?: string | null;
		draft?: boolean;
		head?: { ref?: string };
		base?: { ref?: string };
		user?: { login?: string };
	};
	repository?: { name?: string; owner?: { login?: string } };
}

/**
 * Decide whether a `pull_request` webhook should trigger a review, and extract
 * the fields the workflow needs. Skips drafts, bot-authored PRs, and our own
 * account to avoid self-review loops.
 */
export function gatePullRequestEvent(event: PullRequestEvent): GateDecision {
	const action = event.action ?? "";
	const isManual = action === "labeled" && event.label?.name === MANUAL_LABEL;
	if (!isManual && !REVIEWABLE_ACTIONS.has(action)) {
		return { review: false, reason: `action "${action}" is not reviewable` };
	}

	const pr = event.pull_request;
	if (!pr) return { review: false, reason: "no pull_request in payload" };
	if (pr.draft && action !== "ready_for_review" && !isManual) {
		return { review: false, reason: "PR is a draft" };
	}

	const author = pr.user?.login ?? "";
	if (author.endsWith("[bot]")) {
		return { review: false, reason: `author "${author}" is a bot` };
	}

	const owner = event.repository?.owner?.login;
	const repo = event.repository?.name;
	const prNumber = pr.number;
	const headRef = pr.head?.ref;
	const baseRef = pr.base?.ref;
	if (!owner || !repo || !prNumber || !headRef || !baseRef || !pr.title) {
		return { review: false, reason: "payload missing required PR fields" };
	}

	return {
		review: true,
		pr: {
			prNumber,
			prTitle: pr.title,
			prBody: pr.body ?? "",
			headRef,
			baseRef,
			owner,
			repo,
		},
	};
}
