/**
 * Publisher-notification triggers (spec §18/§19, plan W10.5 slice 2). The glue
 * between a committed label action and the gated send core
 * (`notification-send.ts`): each of the five ratified events — automated block,
 * automated warning, reviewer override, reviewer/override retraction, and
 * emergency takedown — builds a {@link NotificationRequest} and drives it through
 * {@link sendNotification}.
 *
 * These are POST-COMMIT side effects. A notification NEVER rolls back or fails a
 * label action: callers invoke them from the deferred (`waitUntil`) tail after
 * the authoritative batch has committed, and every entry point here swallows and
 * logs its own errors. Delivery retries live independently in the cron sweep.
 *
 * Two guards wrap every send:
 *   - Per-source dedup: a source (`source_type`, `source_id`) already carrying a
 *     `notifications` row is skipped, so a Workflow-step retry or a mutation
 *     replay does not re-notify. `sendNotification`'s notice claim closes the
 *     residual concurrent race atomically.
 *   - Verified-publisher skip: a publisher with an in-force verification claim
 *     bypasses double opt-in (the notice goes out directly). The verification read
 *     fails CLOSED — any error leaves the publisher on the normal confirmation
 *     path, never looser.
 *
 * All notice copy is public-safe: subject line, label effect, the assessment's
 * public summary, and the public assessment + reconsideration URLs. No findings,
 * evidence, or private detail — the {@link NoticeContent} shape is the enforcement.
 */

import { NSID } from "@emdash-cms/registry-lexicons";

import moderationPolicy from "../fixtures/moderation-policy.json";
import { AggregatorClient } from "./aggregator-client.js";
import { getAssessment, type Assessment } from "./assessment-store.js";
import { getNotificationHashPepper } from "./notification-contacts.js";
import { CloudflareEmailSender } from "./notification-email.js";
import type {
	NoticeContent,
	NotificationRequest,
	NotificationSender,
	NotificationSource,
	SendContext,
} from "./notification-send.js";
import { sendNotification } from "./notification-send.js";
import { getOperatorActionById } from "./operator-actions.js";
import { getLabelDefinition } from "./policy.js";
import type { ContactTarget } from "./publisher-contact.js";

/**
 * Everything a trigger needs to resolve, gate, and send a notification. Built
 * from the Worker `env` in production (real {@link CloudflareEmailSender} +
 * {@link AggregatorClient}); tests inject a fake sender and aggregator.
 */
export interface NotifyDeps {
	db: D1Database;
	aggregator: AggregatorClient;
	sender: NotificationSender;
	pepper: string;
	/** Public origin of the labeler service (`LABELER_SERVICE_URL`) — the base for
	 * the confirm/unsubscribe landing links AND the public assessment URL. */
	serviceUrl: string;
	/** The monitored reconsideration URL from the moderation policy. */
	reconsiderationUrl: string;
	now?: () => Date;
}

/**
 * Build the production {@link NotifyDeps} from the Worker env: the real Cloudflare
 * Email Sending adapter over the `EMAIL` binding, the aggregator client over the
 * `AGGREGATOR` service binding, and the peppered recipient hash. The reconsideration
 * URL and reply-to inbox come from the ratified moderation-policy fixture.
 */
export async function createNotifyDeps(env: Env): Promise<NotifyDeps> {
	const pepper = await getNotificationHashPepper(env).get();
	return {
		db: env.DB,
		aggregator: new AggregatorClient(env.AGGREGATOR),
		sender: new CloudflareEmailSender(env.EMAIL, {
			fromAddress: env.NOTIFICATION_FROM_ADDRESS,
			fromName: "emdash plugin labeler",
			replyTo: moderationPolicy.contact.reconsiderationEmail,
		}),
		pepper,
		serviceUrl: env.LABELER_SERVICE_URL,
		reconsiderationUrl: moderationPolicy.contact.reconsiderationUrl,
	};
}

interface OperatorLabelInput {
	actionId: string;
	uri: string;
	cid?: string;
	val: string;
	neg: boolean;
}

/** The public-safe URLs every notice carries — satisfied structurally by
 * {@link NotifyDeps}, so a content builder takes either. */
interface NoticeUrls {
	serviceUrl: string;
	reconsiderationUrl: string;
}

// ── Pure notice-content builders ────────────────────────────────────────────
// Shared by the live triggers AND the sweep's re-render-from-source. Keeping them
// pure and shared guarantees a retried send renders byte-identical copy to the
// original — nothing about the notice is persisted, so both paths derive it from
// the same source fields.

/** Automated block/warning notice for a finalized run — null for any other
 * outcome (so the sweep abandons a notice whose run is no longer blocked/warned). */
function assessmentNoticeContent(urls: NoticeUrls, assessment: Assessment): NoticeContent | null {
	if (assessment.state !== "blocked" && assessment.state !== "warned") return null;
	const blocked = assessment.state === "blocked";
	return {
		subject: blocked
			? "Your plugin release was blocked by the emdash labeler"
			: "Your plugin release was flagged by the emdash labeler",
		publicSummary:
			assessment.publicSummary && assessment.publicSummary.length > 0
				? assessment.publicSummary
				: blocked
					? "A security assessment blocked this release."
					: "A security assessment flagged this release with a warning.",
		effect: blocked
			? "The release is blocked and hidden from install surfaces pending reconsideration."
			: "The release is flagged with a warning.",
		assessmentUrl: assessmentUrl(urls.serviceUrl, assessment.uri, assessment.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
}

function operatorLabelNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; cid?: string; val: string; neg: boolean },
): NoticeContent {
	const shared = {
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri, input.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
	return input.neg
		? {
				subject: "A label on your plugin was retracted",
				publicSummary: `The "${input.val}" label was retracted from this subject.`,
				effect: "The label no longer applies.",
				...shared,
			}
		: {
				subject: "A label was applied to your plugin",
				publicSummary: `The "${input.val}" label was applied to this subject.`,
				effect: getLabelDefinition(input.val)?.officialEffect ?? "",
				...shared,
			};
}

function overrideNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; cid?: string },
): NoticeContent {
	return {
		subject: "Your plugin release was unblocked",
		publicSummary: "A reviewer overrode the automated block for this release.",
		effect: "The release is no longer blocked.",
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri, input.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
}

function overrideRetractNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; cid?: string },
): NoticeContent {
	return {
		subject: "An override on your plugin release was retracted",
		publicSummary: "The reviewer override for this release was retracted.",
		effect: "The automated block applies again.",
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri, input.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
}

function emergencyNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; neg: boolean },
): NoticeContent {
	const shared = {
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
	return input.neg
		? {
				subject: "The takedown on your plugin was lifted",
				publicSummary: "An emergency takedown affecting this subject was retracted.",
				effect: "The takedown no longer applies.",
				...shared,
			}
		: {
				subject: "Your plugin was taken down by the emdash labeler",
				publicSummary: "An operator issued an emergency takedown affecting this subject.",
				effect: getLabelDefinition("!takedown")?.officialEffect ?? "The subject is taken down.",
				...shared,
			};
}

/** The two reconsideration outcomes that notify. `withdrawn` fires nothing, so
 * it is deliberately absent from this union. */
export type ReconsiderationNoticeOutcome = "granted" | "denied";

function reconsiderationOutcomeNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; cid?: string; outcome: ReconsiderationNoticeOutcome },
): NoticeContent {
	const granted = input.outcome === "granted";
	const shared = {
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri, input.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
	return granted
		? {
				subject: "Your reconsideration request was granted",
				publicSummary:
					"After reviewing your reconsideration request, the labeler revised its assessment of this release.",
				effect: "Any resulting label changes are reflected in the current assessment.",
				...shared,
			}
		: {
				subject: "Your reconsideration request was reviewed",
				publicSummary:
					"After reviewing your reconsideration request, the labeler upheld its assessment of this release.",
				effect: "The assessment stands unchanged.",
				...shared,
			};
}

/** Prolonged-error notice for an assessment stuck in `error` past the 72h
 * threshold (plan W10.5 follow-up). Neutral and actionable: it states the
 * labeler could not complete its own assessment, that no label change is
 * implied, and gives the publisher the one thing they can act on — checking the
 * release's artifact URL is reachable. Carries NO findings or private detail. */
function prolongedErrorNoticeContent(
	urls: NoticeUrls,
	input: { uri: string; cid: string },
): NoticeContent {
	return {
		subject: "We couldn't complete the security assessment of your plugin release",
		publicSummary:
			"The automated security assessment of this release repeatedly failed to complete.",
		effect:
			"No label change is implied by this failure. If the release's artifact URL is unavailable or has changed, please verify it is reachable so the assessment can complete.",
		assessmentUrl: assessmentUrl(urls.serviceUrl, input.uri, input.cid),
		reconsiderationUrl: urls.reconsiderationUrl,
	};
}

// ── Live trigger entry points ───────────────────────────────────────────────

/** Automated block/warning notice from a finalized assessment run. Source is the
 * assessment id: a Workflow-step retry of the same run dedups on it, and repeated
 * discovery of the same release dedups onto the same run (same runKey). */
export async function notifyAssessmentOutcome(
	deps: NotifyDeps,
	assessment: Assessment,
): Promise<void> {
	const notice = assessmentNoticeContent(deps, assessment);
	if (!notice) return;
	const target = contactTargetFromUri(assessment.uri);
	if (!target) return;
	await runTrigger(deps, { type: "issuance", id: assessment.id }, target, notice);
}

/** Reviewer label issue / retract (console `labels/issue` + `labels/retract`). */
export async function notifyOperatorLabel(
	deps: NotifyDeps,
	input: OperatorLabelInput,
): Promise<void> {
	const target = contactTargetFromUri(input.uri);
	if (!target) return;
	await runTrigger(
		deps,
		{ type: "operator", id: input.actionId },
		target,
		operatorLabelNoticeContent(deps, input),
	);
}

/** Reviewer false-positive override (console `assessments/:id/override`). */
export async function notifyOverride(
	deps: NotifyDeps,
	input: { actionId: string; uri: string; cid: string },
): Promise<void> {
	const target = contactTargetFromUri(input.uri);
	if (!target) return;
	await runTrigger(
		deps,
		{ type: "operator", id: input.actionId },
		target,
		overrideNoticeContent(deps, input),
	);
}

/** Retraction of a reviewer override (console `assessments/:id/override-retract`). */
export async function notifyOverrideRetract(
	deps: NotifyDeps,
	input: { actionId: string; uri: string; cid: string },
): Promise<void> {
	const target = contactTargetFromUri(input.uri);
	if (!target) return;
	await runTrigger(
		deps,
		{ type: "operator", id: input.actionId },
		target,
		overrideRetractNoticeContent(deps, input),
	);
}

/** Emergency takedown or its retraction (console `emergency/takedown[-retract]`).
 * The subject may be redacted; the aggregator read is unfiltered (blank
 * accept-labelers), so contact resolution still works. */
export async function notifyEmergencyTakedown(
	deps: NotifyDeps,
	input: { actionId: string; uri: string; neg: boolean },
): Promise<void> {
	const target = contactTargetFromUri(input.uri);
	if (!target) return;
	await runTrigger(
		deps,
		{ type: "operator", id: input.actionId },
		target,
		emergencyNoticeContent(deps, input),
	);
}

/** Reconsideration outcome notice (console `reconsiderations/:id/resolve`). Fired
 * only for `granted`/`denied`; the caller never invokes it for `withdrawn`. Source
 * is the resolve operator action, so a mutation replay dedups on it. */
export async function notifyReconsiderationOutcome(
	deps: NotifyDeps,
	input: { actionId: string; uri: string; cid?: string; outcome: ReconsiderationNoticeOutcome },
): Promise<void> {
	const target = contactTargetFromUri(input.uri);
	if (!target) return;
	await runTrigger(
		deps,
		{ type: "operator", id: input.actionId },
		target,
		reconsiderationOutcomeNoticeContent(deps, input),
	);
}

/**
 * Prolonged-error publisher notice, fired by the reconciliation cron's 72h stage
 * (plan W10.5 follow-up) — never at finalization (`assessmentNoticeContent`
 * stays null for `error`, so `notifyAssessmentOutcome` no-ops on it). Source is
 * the errored assessment id: an errored run never produces a block/warn notice,
 * so the `(issuance, id)` key never collides with a finalization notice, and the
 * claim dedups a crash-retry between the send and the escalation-row mark.
 */
export async function notifyProlongedError(
	deps: NotifyDeps,
	assessment: Assessment,
): Promise<boolean> {
	const target = contactTargetFromUri(assessment.uri);
	// An unparseable URI is terminal, not transient (the URI never changes), so it
	// counts as processed — the cron marks it rather than re-attempting forever.
	if (!target) return true;
	return runTrigger(
		deps,
		{ type: "issuance", id: assessment.id },
		target,
		prolongedErrorNoticeContent(deps, { uri: assessment.uri, cid: assessment.cid }),
	);
}

/**
 * Rebuild a NOTICE's public content from its source row, for the retry sweep.
 * Nothing about the notice is persisted (plaintext minimization), so a retry
 * re-derives it from the assessment (`issuance`) or operator action (`operator`)
 * exactly as the live trigger did. Returns null when the source is gone or no
 * longer warrants a notice (e.g. a run that is no longer blocked/warned, or an
 * operator action whose type does not notify) — the sweep then abandons the row.
 */
export async function resolveNoticeForSource(
	deps: NotifyDeps,
	sourceType: string,
	sourceId: string,
): Promise<NoticeContent | null> {
	if (sourceType === "issuance") {
		const assessment = await loadAssessmentSafe(deps.db, sourceId);
		if (!assessment) return null;
		if (assessment.state === "error")
			return prolongedErrorNoticeContent(deps, { uri: assessment.uri, cid: assessment.cid });
		return assessmentNoticeContent(deps, assessment);
	}
	const action = await getOperatorActionById(deps.db, sourceId);
	if (!action || action.subjectUri === null) return null;
	const uri = action.subjectUri;
	const cid = action.subjectCid ?? undefined;
	switch (action.action) {
		case "label-issue":
			return operatorLabelNoticeContent(deps, {
				uri,
				cid,
				val: action.labelValue ?? "",
				neg: false,
			});
		case "label-retract":
			return operatorLabelNoticeContent(deps, {
				uri,
				cid,
				val: action.labelValue ?? "",
				neg: true,
			});
		case "unblock-override":
			return overrideNoticeContent(deps, { uri, cid });
		case "override-retract":
			return overrideRetractNoticeContent(deps, { uri, cid });
		case "takedown":
			return emergencyNoticeContent(deps, { uri, neg: operatorActionNeg(action.metadataJson) });
		case "reconsideration-resolve": {
			const outcome = reconsiderationNoticeOutcome(action.metadataJson);
			return outcome ? reconsiderationOutcomeNoticeContent(deps, { uri, cid, outcome }) : null;
		}
		default:
			return null;
	}
}

/** The notifying outcome a resolve action stored in its metadata, or null when it
 * is `withdrawn` (no notice) or unreadable — the sweep then abandons the row. */
function reconsiderationNoticeOutcome(metadataJson: string): ReconsiderationNoticeOutcome | null {
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		if (typeof parsed === "object" && parsed !== null) {
			const outcome = (parsed as { outcome?: unknown }).outcome;
			if (outcome === "granted" || outcome === "denied") return outcome;
		}
	} catch {
		return null;
	}
	return null;
}

/** `getAssessment` throws `TypeError` only for a malformed id — which a stored
 * `source_id` never is — so that maps to "no notice" (null). Any OTHER error is a
 * transient read failure: it must PROPAGATE, not abandon the row, so the sweep
 * leaves the claimed row `pending` to self-heal on a later pass (matching the
 * operator path's unwrapped read). Swallowing it would permanently drop a
 * legitimate block/warning notice on a single flaky D1 read. */
async function loadAssessmentSafe(db: D1Database, id: string): Promise<Assessment | null> {
	try {
		return await getAssessment(db, id);
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
}

/** The `neg` flag an emergency action stored in its metadata (issue vs retract). */
function operatorActionNeg(metadataJson: string): boolean {
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		return (
			typeof parsed === "object" && parsed !== null && (parsed as { neg?: unknown }).neg === true
		);
	} catch {
		return false;
	}
}

/**
 * Dedup, resolve verification (fail-closed), send, swallow+log. Shared by every
 * trigger so the dedup and verified-skip policy is applied uniformly and a
 * notification failure can never escape into the label path.
 *
 * Returns whether the trigger reached a TERMINAL outcome — a dedup hit or a
 * normal `sendNotification` return (sent, confirmation-sent, undeliverable, or a
 * claimed-then-failed row the sweep now owns) — versus a thrown TRANSIENT error
 * (an aggregator read or a pre-claim D1 write that failed before any row was
 * claimed). The prolonged-error cron uses this to decide whether to stamp its
 * fire-once mark: a transient failure returns `false` so the next tick retries
 * instead of being silently swallowed. Fire-and-forget callers ignore it.
 */
async function runTrigger(
	deps: NotifyDeps,
	source: NotificationSource,
	target: ContactTarget,
	notice: NoticeContent,
): Promise<boolean> {
	const now = deps.now ?? (() => new Date());
	try {
		if (await sourceAlreadyProcessed(deps.db, source)) {
			logTrigger(source, target.did, "deduped");
			return true;
		}
		const verifiedPublisher = await isVerifiedPublisher(deps.aggregator, target.did, now());
		const ctx: SendContext = {
			db: deps.db,
			aggregator: deps.aggregator,
			pepper: deps.pepper,
			sender: deps.sender,
			origin: deps.serviceUrl,
			verifiedPublisher,
			now,
		};
		const request: NotificationRequest = { source, target, notice };
		const outcome = await sendNotification(ctx, request);
		logTrigger(source, target.did, outcome.status);
		return true;
	} catch (error) {
		console.error("[notifications] trigger failed", {
			sourceType: source.type,
			sourceId: source.id,
			did: target.did,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/** Whether any `notifications` row already exists for this source — the primary
 * dedup, so a retried Workflow step or a replayed operator mutation does not
 * re-notify. */
async function sourceAlreadyProcessed(
	db: D1Database,
	source: NotificationSource,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 FROM notifications WHERE source_type = ? AND source_id = ? LIMIT 1`)
		.bind(source.type, source.id)
		.first<{ 1: number }>();
	return row !== null;
}

/**
 * Whether the publisher holds an IN-FORCE verification claim — reuses the
 * history-context notion of "in force" (a claim whose `expiresAt` is absent or in
 * the future). FAILS CLOSED: a `null` view (redacted / unverified), an empty
 * claim set, or ANY read error returns `false`, so the address stays on the
 * stricter double-opt-in path.
 */
export async function isVerifiedPublisher(
	aggregator: Pick<AggregatorClient, "getPublisherVerification">,
	did: string,
	now: Date,
): Promise<boolean> {
	try {
		const state = await aggregator.getPublisherVerification(did);
		if (!state || state.verifications.length === 0) return false;
		return state.verifications.some((claim) => isInForce(claim.expiresAt, now));
	} catch (error) {
		console.error("[notifications] verification read failed, using double opt-in", {
			did,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/** A claim is in force when it has no expiry or its expiry is still in the future
 * (mirrors `history-context`'s `isExpired`). */
function isInForce(expiresAt: string | undefined, now: Date): boolean {
	if (expiresAt === undefined) return true;
	const expiry = Date.parse(expiresAt);
	if (Number.isNaN(expiry)) return true;
	return expiry > now.getTime();
}

/** Public assessment URL for a subject — the `getCurrentAssessment` XRPC view,
 * which resolves the subject's current assessment (the run this notice concerns).
 * `cid` narrows it to the exact release when known. */
function assessmentUrl(serviceUrl: string, uri: string, cid?: string): string {
	const url = new URL(`/xrpc/${NSID.labelerGetCurrentAssessment}`, serviceUrl);
	url.searchParams.set("uri", uri);
	if (cid !== undefined && cid.length > 0) url.searchParams.set("cid", cid);
	return url.toString();
}

/**
 * The `{ did, slug }` a notice's contact resolution needs, parsed from the
 * subject URI. A record URI (`at://did/collection/rkey`) yields the DID and the
 * rkey as the slug — for a package record the rkey IS the package slug (tier-1/2
 * resolve); for a release the rkey misses the package tiers and resolution falls
 * through to the DID-keyed publisher-profile contact (tier 3), which is the
 * reliable channel. A bare DID subject (publisher-level action) resolves by DID
 * alone. Anything unparseable returns null and the notice is skipped.
 */
export function contactTargetFromUri(uri: string): ContactTarget | null {
	if (uri.startsWith("at://")) {
		const [did, , rkey] = uri.slice("at://".length).split("/");
		if (did === undefined || did.length === 0) return null;
		return { did, slug: rkey ?? "" };
	}
	if (uri.startsWith("did:")) {
		return { did: uri, slug: uri.split(":").at(-1) ?? uri };
	}
	return null;
}

function logTrigger(source: NotificationSource, did: string, outcome: string): void {
	console.log("[notifications]", {
		action: "trigger",
		sourceType: source.type,
		sourceId: source.id,
		did,
		outcome,
	});
}
