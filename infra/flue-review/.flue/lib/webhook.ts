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
	const provided = hexToBytes(signatureHeader.slice("sha256=".length));
	if (!provided) return false;
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
	if (provided.length !== mac.length) return false;
	// Workers' built-in constant-time comparison over the raw MAC bytes.
	return crypto.subtle.timingSafeEqual(provided, mac);
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
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

// Actions that warrant an auto-review. Deliberately NOT `synchronize`: we don't
// re-review on every pushed commit (noisy and costly). Re-review after changes
// is an explicit action via the bot:review label below.
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
	const pr = event.pull_request;
	if (!pr) return { review: false, reason: "no pull_request in payload" };

	// Bot-author guard applies to BOTH auto and manual triggers, so labeling a
	// bot-authored PR (or emdashbot's own PR) can't kick off a self-review loop.
	const author = pr.user?.login ?? "";
	if (author.endsWith("[bot]")) {
		return { review: false, reason: `author "${author}" is a bot` };
	}

	const action = event.action ?? "";
	const isManual = action === "labeled" && event.label?.name === MANUAL_LABEL;
	if (!isManual && !REVIEWABLE_ACTIONS.has(action)) {
		return { review: false, reason: `action "${action}" is not reviewable` };
	}

	if (pr.draft && action !== "ready_for_review" && !isManual) {
		return { review: false, reason: "PR is a draft" };
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
