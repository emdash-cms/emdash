// GitHub webhook helpers: signature verification, payload normalization,
// actor classification, anchor extraction.
//
// Everything here is PURE -- no I/O, no DO calls, no env access. The route
// in app.ts composes these into a request pipeline:
//
//   raw body  →  verifyWebhookSignature
//             →  JSON.parse + dispatchByEventType
//             →  normalizeWebhook → NormalizedEvent | { skip: reason }
//             →  env.Orchestrator.getByName(anchor).event(normalized)
//
// Keeping it pure makes it unit-testable against synthetic GitHub fixtures
// without booting the workers pool. The pool tests (tests/integration/) cover
// the full HTTP path end-to-end.

import type { NormalizedEvent } from "./orchestrator.js";
import { parseCommand, parseMention } from "./router.js";

// ---------------- HMAC verification ----------------

const encoder = new TextEncoder();
const NON_HEX = /[^0-9a-fA-F]/;

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body using
 * the shared webhook secret (HMAC-SHA256). Constant-time comparison via
 * `crypto.subtle.timingSafeEqual`.
 *
 * Critical: callers MUST pass the raw request body (the bytes GitHub sent),
 * not the parsed-then-restringified JSON. Round-tripping reorders keys and
 * strips whitespace, which breaks the HMAC.
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
	return crypto.subtle.timingSafeEqual(provided, mac);
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || NON_HEX.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// ---------------- Actor classification ----------------

/**
 * Author associations GitHub assigns on comment/issue payloads. Treat
 * OWNER/MEMBER/COLLABORATOR as `maintainer` -- they have push access (in
 * practice; emdash is a single-org repo so OWNER + MEMBER is the maintainer
 * set, COLLABORATOR is added explicit access).
 *
 * CONTRIBUTOR / FIRST_TIMER / FIRST_TIME_CONTRIBUTOR / NONE / MANNEQUIN are
 * not maintainers. They may still be the reporter if they opened the issue.
 */
const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Actor = "maintainer" | "reporter" | "system" | "other";

export interface ActorInput {
	/** Login of the user who sent the event (commenter / issue opener). */
	readonly senderLogin: string | undefined | null;
	/** `author_association` from the payload, if present. */
	readonly authorAssociation?: string | null;
	/** Login of the anchor issue's opener. */
	readonly issueOpenerLogin?: string | null;
}

/**
 * Resolve the actor's role for the router. Maintainer wins over reporter --
 * if the issue opener is a maintainer, their action runs with full
 * maintainer authority, not the limited reporter set.
 *
 * A bot sender (`*[bot]`) is `system` only if it's our own app; we can't
 * distinguish here without the App ID, so we treat all bot senders as
 * `system` for now. The DO already drops `agent.*` events from non-system
 * actors via the router's actor list.
 */
export function classifyActor({
	senderLogin,
	authorAssociation,
	issueOpenerLogin,
}: ActorInput): Actor {
	if (!senderLogin) return "other";
	if (senderLogin.endsWith("[bot]")) return "system";
	if (authorAssociation && MAINTAINER_ASSOCIATIONS.has(authorAssociation)) return "maintainer";
	if (issueOpenerLogin && senderLogin === issueOpenerLogin) return "reporter";
	return "other";
}

// ---------------- Payload types ----------------

// Minimal structural types over the GitHub payloads we read. NOT exhaustive;
// optional fields stay optional and unknown branches resolve to a skip. We
// avoid pulling in @octokit/webhooks-types to keep the bundle small and the
// types narrowly scoped to what we actually consume.

interface User {
	login?: string;
}

interface Label {
	name?: string;
}

interface IssueLike {
	number?: number;
	user?: User;
	labels?: Label[];
	/** Set on PR-as-issue payloads (issue_comment on a PR). */
	pull_request?: unknown;
	author_association?: string;
}

interface CommentLike {
	id?: number;
	body?: string | null;
	user?: User;
	author_association?: string;
	created_at?: string;
}

interface PullRequest {
	number?: number;
	user?: User;
	head?: { ref?: string };
	labels?: Label[];
	draft?: boolean;
	/** True when closed via merge; false when closed without merging. */
	merged?: boolean;
	author_association?: string;
}

export interface IssuesEvent {
	action?: string;
	issue?: IssueLike;
	sender?: User;
}

export interface IssueCommentEvent {
	action?: string;
	issue?: IssueLike;
	comment?: CommentLike;
	sender?: User;
}

export interface PullRequestEvent {
	action?: string;
	pull_request?: PullRequest;
	sender?: User;
}

export interface PullRequestReviewEvent {
	action?: string;
	review?: { body?: string | null; state?: string; user?: User; author_association?: string };
	pull_request?: PullRequest;
	sender?: User;
}

export interface PullRequestReviewCommentEvent {
	action?: string;
	comment?: CommentLike;
	pull_request?: PullRequest;
	sender?: User;
}

// ---------------- Normalization ----------------

export type NormalizeResult =
	| { kind: "dispatch"; anchor: string; event: NormalizedEvent }
	| {
			kind: "pull_request";
			pullRequestNumber: number;
			event: Omit<NormalizedEvent, "anchorNumber">;
	  }
	| { kind: "cleanup"; anchor: string; anchorNumber: number; deliveryId?: string }
	| { kind: "skip"; reason: string }
	| { kind: "pong" };

export interface NormalizeContext {
	/** GitHub delivery id for idempotency tracking. */
	readonly deliveryId?: string;
	/** GitHub event type from `X-GitHub-Event`. */
	readonly eventType: string;
	/** Parsed JSON payload. */
	readonly payload: unknown;
}

/**
 * Map a GitHub webhook delivery to a (anchor, NormalizedEvent) pair the
 * orchestrator DO can consume, or a skip reason. The route handler is just
 * a thin shell around this: this function decides what the bot does.
 *
 * Skips return a reason for logging; they're not errors. Examples:
 *   - issue_comment.edited                (we only act on .created)
 *   - issues.labeled                       (label changes don't drive state)
 *   - pull_request.synchronize             (every push is noisy)
 *   - comment has no @emdashbot mention    (the deterministic gate)
 *
 * Skips happen FAST: no DO dispatch, no log spam beyond a single line.
 */
export function normalizeWebhook(ctx: NormalizeContext): NormalizeResult {
	if (ctx.eventType === "ping") return { kind: "pong" };

	switch (ctx.eventType) {
		case "issues":
			return normalizeIssues(asRecord(ctx.payload), ctx.deliveryId);
		case "issue_comment":
			return normalizeIssueComment(asRecord(ctx.payload), ctx.deliveryId);
		case "pull_request":
			return normalizePullRequest(asRecord(ctx.payload), ctx.deliveryId);
		case "pull_request_review":
			return normalizePullRequestReview(asRecord(ctx.payload), ctx.deliveryId);
		case "pull_request_review_comment":
			return normalizePullRequestReviewComment(asRecord(ctx.payload), ctx.deliveryId);
		default:
			return { kind: "skip", reason: `event "${ctx.eventType}" is not handled` };
	}
}

/**
 * Issues events. We act on `opened` and `reopened` only -- both potential
 * entry points to the lifecycle, and only when the body carries an
 * `@emdashbot` mention (a pre-classification, mirrors the comment path).
 * `labeled` / `unlabeled` are skipped because the DO is the source of truth
 * for state; label drift is reconciled by the Orchestrator DO's periodic alarm
 * tick (`reconcileLabels`), not by webhooks.
 */
function normalizeIssues(
	event: Record<string, unknown> | undefined,
	deliveryId?: string,
): NormalizeResult {
	const action = readString(event?.action) ?? "";
	// A closed issue reaps its fix-loop branches.
	// PR-as-issue closes arrive as pull_request events too; skip them here.
	if (action === "closed") {
		const issue = asRecord(event?.issue);
		const number = readNumber(issue?.number);
		if (!number) return { kind: "skip", reason: "issues.closed missing issue.number" };
		if (issue?.pull_request) return { kind: "skip", reason: "issues.closed on a PR-as-issue" };
		return {
			kind: "cleanup",
			anchor: anchorForIssue(number),
			anchorNumber: number,
			...(deliveryId ? { deliveryId } : {}),
		};
	}
	if (action !== "opened" && action !== "reopened") {
		return { kind: "skip", reason: `issues.${action} not handled` };
	}
	const issue = asRecord(event?.issue);
	const number = readNumber(issue?.number);
	if (!number) return { kind: "skip", reason: "issues event missing issue.number" };
	// Issues opening currently produces no event by itself -- the bot waits
	// for a mention. This is intentional: we don't want every new issue to
	// trigger a triage label and a status comment from a bot the reporter
	// may not even know exists. Once the mention support for issue bodies
	// lands, this branch will resolve a verb from `issue.body`.
	return {
		kind: "skip",
		reason: `issues.${action} acknowledged; awaiting explicit mention`,
		...(deliveryId ? {} : {}),
	};
}

/**
 * Issue comments (and PR comments -- GitHub fires the same event type).
 * Restricted to `action === "created"` so comment edits don't re-fire the
 * verb. The DO handles deduping by deliveryId already, but a `.edited`
 * delivery has a different id than the original `.created`, so we filter
 * here.
 */
function normalizeIssueComment(
	event: Record<string, unknown> | undefined,
	deliveryId?: string,
): NormalizeResult {
	const action = readString(event?.action);
	if (action !== "created") {
		return { kind: "skip", reason: `issue_comment.${action} not handled` };
	}
	const issue = asRecord(event?.issue);
	const number = readNumber(issue?.number);
	if (!number) return { kind: "skip", reason: "issue_comment missing issue.number" };
	const comment = asRecord(event?.comment);
	const body = readString(comment?.body) ?? "";
	const mentionText = parseMention(body);
	if (mentionText === null) return { kind: "skip", reason: "no @emdashbot mention" };

	const sender = asRecord(event?.sender);
	const issueUser = asRecord(issue?.user);
	const senderLogin =
		readString(sender?.login) ?? readString(asRecord(comment?.user)?.login) ?? null;
	const authorAssociation = readString(comment?.author_association) ?? null;
	const actor = classifyActor({
		senderLogin,
		authorAssociation,
		issueOpenerLogin: readString(issueUser?.login),
	});
	const labels = collectLabels(issue?.labels);
	const triggeringComment = {
		id: readNumber(comment?.id) ?? null,
		body,
		authorLogin: senderLogin,
		authorAssociation,
		actor,
	};
	const isPullRequest = issue?.pull_request !== undefined;
	if (isPullRequest && readString(issueUser?.login) !== "emdashbot[bot]") {
		return { kind: "skip", reason: "issue_comment is not on an emdashbot pull request" };
	}
	const dispatch = (normalized: Omit<NormalizedEvent, "anchorNumber">): NormalizeResult =>
		isPullRequest
			? { kind: "pull_request", pullRequestNumber: number, event: normalized }
			: dispatchFor(number, normalized);

	// Three-way grammar (mirrors router.resolveComment):
	//   1. Bare verb (parseCommand returns a known event) -> deterministic.
	//   2. Empty mention "@emdashbot " (mention text empty) -> readonly status.
	//      The DO resolves the readonly via the resolve() path; we just hand
	//      it the `status` event.
	//   3. Free text on an issue -> classifier. On a verified bot PR it is
	//      revision feedback for the originating issue.
	const cmd = parseCommand(body);
	if (cmd) {
		return dispatch({
			event: cmd.event,
			arg: cmd.arg,
			actor,
			labels,
			needsClassify: false,
			triggeringComment,
			...(deliveryId ? { deliveryId } : {}),
		});
	}

	if (mentionText === "") {
		return dispatch({
			event: "status",
			arg: null,
			actor,
			labels,
			needsClassify: false,
			triggeringComment,
			...(deliveryId ? { deliveryId } : {}),
		});
	}

	return dispatch({
		event: isPullRequest ? "revise" : null,
		arg: isPullRequest ? mentionText : null,
		actor,
		labels,
		needsClassify: !isPullRequest,
		...(isPullRequest ? {} : { classifyText: mentionText }),
		triggeringComment,
		...(deliveryId ? { deliveryId } : {}),
	});
}

/**
 * Pull request events. We act on `opened` / `reopened` / `closed` for
 * bot-authored PRs as `pr.*` events the machine consumes (pr.opened,
 * pr.merged). For non-bot PRs we skip -- the bot doesn't manage PRs it
 * didn't open.
 *
 * The bot-owned head branch is the trusted link back to the issue lifecycle.
 */
function normalizePullRequest(
	event: Record<string, unknown> | undefined,
	deliveryId?: string,
): NormalizeResult {
	const action = readString(event?.action) ?? "";
	const pr = asRecord(event?.pull_request);
	const issueNumber = botFixIssueNumber(pr);
	if (issueNumber === null)
		return { kind: "skip", reason: "pull_request is not an emdashbot fix PR" };

	let machineEvent: NormalizedEvent["event"];
	switch (action) {
		case "opened":
		case "reopened":
			machineEvent = "pr.opened";
			break;
		case "closed":
			// Same GitHub action for merge and close-without-merge; the payload
			// field `pull_request.merged` distinguishes them.
			machineEvent = pr?.merged === true ? "pr.merged" : "pr.closed";
			break;
		default:
			return { kind: "skip", reason: `pull_request.${action} not handled` };
	}

	return dispatchFor(issueNumber, {
		event: machineEvent,
		arg: null,
		actor: "system",
		labels: collectLabels(pr?.labels),
		needsClassify: false,
		...(deliveryId ? { deliveryId } : {}),
	});
}

/**
 * PR review submissions. `pr.*` events are machine-defined as
 * actors:["system"] (they represent "GitHub reported a review state change",
 * not "system pressed approve"), so we pass actor: "system" regardless of
 * who submitted on GitHub.
 */
function normalizePullRequestReview(
	event: Record<string, unknown> | undefined,
	deliveryId?: string,
): NormalizeResult {
	const action = readString(event?.action);
	if (action !== "submitted") {
		return { kind: "skip", reason: `pull_request_review.${action} not handled` };
	}
	const pr = asRecord(event?.pull_request);
	const issueNumber = botFixIssueNumber(pr);
	if (issueNumber === null) {
		return { kind: "skip", reason: "pull_request_review is not on an emdashbot fix PR" };
	}

	const reviewState = (readString(asRecord(event?.review)?.state) ?? "").toLowerCase();
	let machineEvent: NormalizedEvent["event"];
	if (reviewState === "approved") machineEvent = "pr.approved";
	else if (reviewState === "changes_requested") machineEvent = "pr.changes_requested";
	else return { kind: "skip", reason: `review state "${reviewState}" not actionable` };

	return dispatchFor(issueNumber, {
		event: machineEvent,
		arg: null,
		actor: "system",
		labels: collectLabels(pr?.labels),
		needsClassify: false,
		...(deliveryId ? { deliveryId } : {}),
	});
}

/**
 * Inline PR review comments (review-thread comments, not top-level review
 * bodies). A bare verb remains deterministic; other mentioned text is
 * revision feedback for the originating issue.
 */
function normalizePullRequestReviewComment(
	event: Record<string, unknown> | undefined,
	deliveryId?: string,
): NormalizeResult {
	const action = readString(event?.action);
	if (action !== "created") {
		return { kind: "skip", reason: `pull_request_review_comment.${action} not handled` };
	}
	const pr = asRecord(event?.pull_request);
	const issueNumber = botFixIssueNumber(pr);
	if (issueNumber === null) {
		return { kind: "skip", reason: "pr_review_comment is not on an emdashbot fix PR" };
	}
	const comment = asRecord(event?.comment);
	const body = readString(comment?.body) ?? "";
	const mentionText = parseMention(body);
	if (mentionText === null) return { kind: "skip", reason: "no @emdashbot mention" };

	const senderLogin =
		readString(asRecord(event?.sender)?.login) ??
		readString(asRecord(comment?.user)?.login) ??
		null;
	const authorAssociation = readString(comment?.author_association) ?? null;
	const actor = classifyActor({
		senderLogin,
		authorAssociation,
		issueOpenerLogin: readString(asRecord(pr?.user)?.login),
	});
	const labels = collectLabels(pr?.labels);
	const triggeringComment = {
		id: readNumber(comment?.id) ?? null,
		body,
		authorLogin: senderLogin,
		authorAssociation,
		actor,
	};

	const cmd = parseCommand(body);
	if (cmd) {
		return dispatchFor(issueNumber, {
			event: cmd.event,
			arg: cmd.arg,
			actor,
			labels,
			needsClassify: false,
			triggeringComment,
			...(deliveryId ? { deliveryId } : {}),
		});
	}
	if (mentionText === "") {
		return dispatchFor(issueNumber, {
			event: "status",
			arg: null,
			actor,
			labels,
			needsClassify: false,
			triggeringComment,
			...(deliveryId ? { deliveryId } : {}),
		});
	}
	return dispatchFor(issueNumber, {
		event: "revise",
		arg: mentionText,
		actor,
		labels,
		needsClassify: false,
		triggeringComment,
		...(deliveryId ? { deliveryId } : {}),
	});
}

// ---------------- Helpers ----------------

const BOT_FIX_BRANCH = /^bot\/fix-([1-9]\d*)$/;

function issueNumberFromBotFixBranch(headBranch: string | null | undefined): number | null {
	if (!headBranch) return null;
	const match = BOT_FIX_BRANCH.exec(headBranch);
	if (!match?.[1]) return null;
	const issueNumber = Number(match[1]);
	return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

function botFixIssueNumber(pr: Record<string, unknown> | undefined): number | null {
	if (readString(asRecord(pr?.user)?.login) !== "emdashbot[bot]") return null;
	return issueNumberFromBotFixBranch(readString(asRecord(pr?.head)?.ref));
}

export function resolvePullRequestWebhook(
	result: Extract<NormalizeResult, { kind: "pull_request" }>,
	headBranch: string | null,
): NormalizeResult {
	const issueNumber = issueNumberFromBotFixBranch(headBranch);
	if (issueNumber === null) {
		return { kind: "skip", reason: "pull request head is not an issue-scoped bot branch" };
	}
	return dispatchFor(issueNumber, result.event);
}

/**
 * Stable DO instance name for an issue number.
 */
export function anchorForIssue(number: number): string {
	return `issue-${number}`;
}

/**
 * Wrap a NormalizedEvent in a dispatch result, injecting the anchor name and
 * the anchor number (used by the DO for GitHub API calls).
 */
function dispatchFor(
	number: number,
	event: Omit<NormalizedEvent, "anchorNumber">,
): NormalizeResult {
	return {
		kind: "dispatch",
		anchor: anchorForIssue(number),
		event: { ...event, anchorNumber: number },
	};
}

function collectLabels(labels: unknown): readonly string[] {
	if (!Array.isArray(labels)) return [];
	const out: string[] = [];
	for (const l of labels) {
		const name = readString(asRecord(l)?.name);
		if (name) out.push(name);
	}
	return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
