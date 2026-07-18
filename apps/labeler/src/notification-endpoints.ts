/**
 * Public, token-authenticated landing endpoints for publisher-notification
 * emails (spec §18/§19, plan W10.4 slice C). These back the links a recipient
 * clicks — confirm, unsubscribe, and "not me" — and are mounted OUTSIDE
 * `/admin/*` so neither the Cloudflare Access edge policy nor the in-Worker
 * operator guard applies: the capability in the link is the sole authority.
 *
 * The recipient hash (an HMAC-SHA256 digest, never plaintext email) travels in
 * the link and is the unforgeable capability — an attacker cannot compute a
 * victim's hash without the pepper. The confirm link additionally carries a
 * single-use random token whose SHA-256 digest the send path stored; the raw
 * token never touches the database.
 *
 * Safety properties:
 *   - GET renders a confirmation page with a POST form; only POST mutates. An
 *     email scanner's or link-prefetcher's automated GET therefore never
 *     confirms, unsubscribes, or suppresses. The browser POST carries the
 *     token/hash in hidden form fields; an RFC 8058 one-click unsubscribe POST
 *     carries `c` in the header URL's query instead, so the POST parser reads the
 *     body first and falls back to the query.
 *   - CSRF: a cross-site POST cannot supply a valid recipient hash (or confirm
 *     token) for a victim, so possession of the capability is the CSRF defense;
 *     a custom header (unsendable from a plain email-client form) is not used.
 *   - Uniform responses: the page a caller sees never reveals whether the token
 *     was valid, already consumed, or unknown, nor whether an address is on
 *     file. The real outcome is logged server-side only, without the token.
 *   - The confirm path always runs {@link confirmContact}'s constant-time
 *     compare (fed a non-matching sentinel for a suppressed contact), so elapsed
 *     time never reveals token validity, and a suppressed contact is never
 *     confirmed.
 */

import {
	confirmContact,
	contactExists,
	declineContact,
	hashConfirmToken,
	isSuppressed,
	suppress,
} from "./notification-contacts.js";

type NotificationAction = "confirm" | "unsubscribe" | "not-me";

const ACTION_PATHS: Record<string, NotificationAction> = {
	"/notifications/confirm": "confirm",
	"/notifications/unsubscribe": "unsubscribe",
	"/notifications/not-me": "not-me",
};

/** A well-formed recipient hash: lowercase hex of an HMAC-SHA256 digest. */
const RECIPIENT_HASH = /^[0-9a-f]{64}$/;

/** URL-safe (base64url/hex) raw confirm token, length-bounded to cap hashing. */
const CONFIRM_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * A 64-hex value no real digest collides with (2^-256). Used both as a stand-in
 * recipient hash when the supplied one is malformed — so the confirm path still
 * runs its full constant-time compare against an absent row — and as the token
 * hash fed to {@link confirmContact} for a suppressed contact, so the compare
 * runs full-length yet can never flip the row.
 */
const UNMATCHABLE_HASH = "0".repeat(64);

export function isNotificationPath(pathname: string): boolean {
	return pathname in ACTION_PATHS;
}

export async function handleNotificationRequest(
	db: D1Database,
	request: Request,
	now: () => Date = () => new Date(),
): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	const action = ACTION_PATHS[pathname];
	if (!action) return htmlResponse(notFoundPage(), 404);

	if (request.method === "GET") return htmlResponse(formPage(action, readParams(request, action)));
	if (request.method !== "POST")
		return new Response("method not allowed", {
			status: 405,
			headers: { allow: "GET, POST", "cache-control": "no-store" },
		});

	const params = await readPostParams(request, action);
	switch (action) {
		case "confirm":
			await performConfirm(db, params.recipientHash, params.token, now());
			break;
		case "unsubscribe":
			await performSuppression(db, params.recipientHash, "unsubscribe", now());
			break;
		case "not-me":
			await performSuppression(db, params.recipientHash, "not_me", now());
			break;
	}
	return htmlResponse(donePage(action));
}

interface RequestParams {
	/** The raw recipient hash, unvalidated (echoed only after escaping). */
	recipientHash: string;
	/** The raw confirm token, unvalidated; empty for non-confirm actions. */
	token: string;
}

function readParams(request: Request, action: NotificationAction): RequestParams {
	const query = new URL(request.url).searchParams;
	return {
		recipientHash: query.get("c") ?? "",
		token: action === "confirm" ? (query.get("t") ?? "") : "",
	};
}

async function readPostParams(
	request: Request,
	action: NotificationAction,
): Promise<RequestParams> {
	// The capability travels in the header URL's query string. An RFC 8058
	// one-click POST (`List-Unsubscribe=One-Click` in the body) carries `c` ONLY
	// there, so the query is the fallback when the body omits it; a browser form
	// POST supplies `c` in the body, which wins.
	const query = new URL(request.url).searchParams;
	let form: FormData | null = null;
	try {
		form = await request.formData();
	} catch {
		form = null;
	}
	const bodyHash = form?.get("c");
	const recipientHash =
		typeof bodyHash === "string" && bodyHash.length > 0 ? bodyHash : (query.get("c") ?? "");
	if (action !== "confirm") return { recipientHash, token: "" };
	const bodyToken = form?.get("t");
	const token =
		typeof bodyToken === "string" && bodyToken.length > 0 ? bodyToken : (query.get("t") ?? "");
	return { recipientHash, token };
}

/**
 * Flip `unconfirmed -> confirmed` iff the token matches, and never for a
 * suppressed contact. A malformed recipient hash routes to an absent row and a
 * suppressed contact to a non-matching sentinel token, so the constant-time
 * compare always runs full-length regardless of validity or suppression.
 *
 * This endpoint has no rate limit and the token lookup is pepper-less, so its
 * safety depends on the token's entropy — see {@link hashConfirmToken}.
 */
async function performConfirm(
	db: D1Database,
	rawRecipientHash: string,
	rawToken: string,
	now: Date,
): Promise<void> {
	const recipientHash = RECIPIENT_HASH.test(rawRecipientHash) ? rawRecipientHash : UNMATCHABLE_HASH;
	const tokenHash = CONFIRM_TOKEN.test(rawToken)
		? await hashConfirmToken(rawToken)
		: UNMATCHABLE_HASH;
	const suppressed = await isSuppressed(db, recipientHash);
	const effectiveTokenHash = suppressed ? UNMATCHABLE_HASH : tokenHash;
	const confirmed = await confirmContact(db, recipientHash, effectiveTokenHash, now.toISOString());
	logOutcome(
		"confirm",
		rawRecipientHash,
		suppressed ? "suppressed" : confirmed ? "confirmed" : "no-op",
	);
}

/**
 * Record a suppression (idempotent) and decline any pending confirmation, so a
 * suppressed address can never later confirm. A confirmed opt-in is not
 * downgraded — it keeps its state and gains a suppression row that the send path
 * honors.
 *
 * The write is gated on an existing contact row: a legitimate recipient always
 * has one (they were sent mail, which created it via `ensureContact`, and
 * contacts are never swept), so gating costs them nothing while an attacker who
 * fabricates a well-formed but unseen hash writes no orphan suppression row. A
 * malformed or unknown hash is a neutral no-op; the response is byte-identical
 * either way because the caller only ever sees {@link donePage}.
 */
async function performSuppression(
	db: D1Database,
	rawRecipientHash: string,
	reason: "unsubscribe" | "not_me",
	now: Date,
): Promise<void> {
	if (!RECIPIENT_HASH.test(rawRecipientHash)) {
		logOutcome(reason, rawRecipientHash, "ignored-malformed");
		return;
	}
	if (!(await contactExists(db, rawRecipientHash))) {
		logOutcome(reason, rawRecipientHash, "ignored-no-contact");
		return;
	}
	await suppress(db, rawRecipientHash, reason, now.toISOString(), now.getTime());
	await declineContact(db, rawRecipientHash);
	logOutcome(reason, rawRecipientHash, "suppressed");
}

/**
 * Log the real outcome for operability without leaking the capability: the raw
 * token is never logged, and only an 8-char prefix of the recipient hash is
 * recorded for correlation.
 */
function logOutcome(action: string, rawRecipientHash: string, outcome: string): void {
	console.log("[notifications]", {
		action,
		outcome,
		hashPrefix: rawRecipientHash.slice(0, 8),
	});
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY",
			"content-security-policy":
				"default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
		},
	});
}

const ACTION_COPY: Record<NotificationAction, { title: string; prompt: string; button: string }> = {
	confirm: {
		title: "Confirm notifications",
		prompt:
			"Confirm that this address should receive publisher notifications from the emdash labeler.",
		button: "Confirm",
	},
	unsubscribe: {
		title: "Unsubscribe",
		prompt: "Stop sending publisher notifications from the emdash labeler to this address.",
		button: "Unsubscribe",
	},
	"not-me": {
		title: "Not my address",
		prompt: "Report that you did not expect this message and should not be contacted again.",
		button: "Do not contact me",
	},
};

const DONE_COPY: Record<NotificationAction, string> = {
	confirm:
		"If your confirmation link was valid, this address is now confirmed. You can close this page.",
	unsubscribe:
		"This address will no longer receive publisher notifications from the emdash labeler. You can close this page.",
	"not-me":
		"Thank you. This address will not be contacted again by the emdash labeler. You can close this page.",
};

function formPage(action: NotificationAction, params: RequestParams): string {
	const copy = ACTION_COPY[action];
	const hidden = [`<input type="hidden" name="c" value="${escapeHtml(params.recipientHash)}">`];
	if (action === "confirm")
		hidden.push(`<input type="hidden" name="t" value="${escapeHtml(params.token)}">`);
	return page(
		copy.title,
		`<p>${escapeHtml(copy.prompt)}</p>
		<form method="post" action="${escapeHtml(`/notifications/${action}`)}">
			${hidden.join("\n\t\t\t")}
			<button type="submit">${escapeHtml(copy.button)}</button>
		</form>`,
	);
}

function donePage(action: NotificationAction): string {
	return page(ACTION_COPY[action].title, `<p>${escapeHtml(DONE_COPY[action])}</p>`);
}

function notFoundPage(): string {
	return page("Not found", "<p>This link is not valid.</p>");
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
