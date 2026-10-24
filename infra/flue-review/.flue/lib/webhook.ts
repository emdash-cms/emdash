// GitHub webhook signature verification and pull_request event gating.

const encoder = new TextEncoder();
const NON_HEX = /[^0-9a-fA-F]/;
const DESIGN_PR_TITLE = /^design:/i;

export function getWebhookDeliveryId(header: string | undefined | null): string | null {
	return header?.trim() || null;
}

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
	const provided = hexToBytes(signatureHeader.slice("sha256=".length));
	if (!provided) return false;
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
	if (provided.length !== mac.length) return false;
	// Workers' built-in constant-time comparison over the raw MAC bytes.
	return crypto.subtle.timingSafeEqual(provided, mac);
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || NON_HEX.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export interface GatedPr {
	prNumber: number;
	prTitle: string;
	prBody: string;
	authorLogin?: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	baseSha: string;
	owner: string;
	repo: string;
	/** `scoped` re-reviews only what changed since `priorHeadSha`; omitted means a full review. */
	reviewMode?: "full" | "scoped";
	priorHeadSha?: string;
}

export type GateDecision =
	| { review: true; pr: GatedPr }
	| { review: false; reason: string; rereview?: GatedPr };

export function isDesignPullRequest(
	title: string | undefined,
	body: string | null | undefined,
): boolean {
	return DESIGN_PR_TITLE.test(title ?? "") || (body ?? "").includes("<!-- design-pr -->");
}

// Actions that warrant an immediate review. A `synchronize` push is instead
// scheduled for an automatic re-review once CI on the new head finishes (see
// rereview.ts), and the bot:review label below forces a full review at any
// time. The exception is a push by a bot in SYNC_REVIEWED_BOT_AUTHORS to its
// own PR: each one is a new candidate published for review, not work in
// progress, so it is reviewed straight away.
const REVIEWABLE_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);
// Manual trigger (re-review): applying this label to a PR.
const MANUAL_LABEL = "bot:review";

interface PullRequestEvent {
	action?: string;
	label?: { name?: string };
	pull_request?: {
		number?: number;
		title?: string;
		body?: string | null;
		draft?: boolean;
		head?: { ref?: string; sha?: string };
		base?: { ref?: string; sha?: string };
		user?: { login?: string };
	};
	repository?: { name?: string; owner?: { login?: string } };
	sender?: { login?: string };
}

/** Bot authors whose PRs are reviewed without a `bot:review` label. */
const REVIEWED_BOT_AUTHORS: ReadonlySet<string> = new Set([
	"emdashbot[bot]",
	"emdash-autofix[bot]",
]);
/** Bot authors whose own pushes to their PRs are reviewed too. */
const SYNC_REVIEWED_BOT_AUTHORS: ReadonlySet<string> = new Set(["emdash-autofix[bot]"]);

export function isReviewableAuthor(author: string): boolean {
	return !author.endsWith("[bot]") || REVIEWED_BOT_AUTHORS.has(author);
}

/**
 * Decide whether a `pull_request` webhook should trigger a review, and extract
 * the fields the workflow needs. Skips drafts and unsolicited bot-authored PRs,
 * except for PRs from bots that write code for review (emdashbot and
 * emdash-autofix), which always need review.
 */
export function gatePullRequestEvent(event: PullRequestEvent): GateDecision {
	const pr = event.pull_request;
	if (!pr) return { review: false, reason: "no pull_request in payload" };
	if (isDesignPullRequest(pr.title, pr.body)) {
		return { review: false, reason: "design PRs require human discussion" };
	}

	const action = event.action ?? "";
	const isManual = action === "labeled" && event.label?.name === MANUAL_LABEL;
	const author = pr.user?.login ?? "";
	const isOwnBotPush =
		action === "synchronize" &&
		SYNC_REVIEWED_BOT_AUTHORS.has(author) &&
		event.sender?.login === author;
	const isRereviewPush = action === "synchronize" && !isOwnBotPush;
	if (!isManual && !isOwnBotPush && !isRereviewPush && !REVIEWABLE_ACTIONS.has(action)) {
		return { review: false, reason: `action "${action}" is not reviewable` };
	}

	if (!isManual && !isReviewableAuthor(author)) {
		return { review: false, reason: `author "${author}" is a bot` };
	}

	if (pr.draft && action !== "ready_for_review" && !isManual) {
		return { review: false, reason: "PR is a draft" };
	}

	const owner = event.repository?.owner?.login;
	const repo = event.repository?.name;
	const prNumber = pr.number;
	const headRef = pr.head?.ref;
	const headSha = pr.head?.sha;
	const baseRef = pr.base?.ref;
	const baseSha = pr.base?.sha;
	if (!owner || !repo || !prNumber || !headRef || !headSha || !baseRef || !baseSha || !pr.title) {
		return { review: false, reason: "payload missing required PR fields" };
	}

	const gated: GatedPr = {
		prNumber,
		prTitle: pr.title,
		prBody: pr.body ?? "",
		authorLogin: author,
		headRef,
		headSha,
		baseRef,
		baseSha,
		owner,
		repo,
	};
	if (isRereviewPush && !isManual) {
		return { review: false, reason: "push scheduled for re-review after CI", rereview: gated };
	}
	return { review: true, pr: gated };
}
