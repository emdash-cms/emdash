/**
 * Operator console mutation API (plan W9.4). The POST counterpart of
 * `console-api.ts`'s read dispatcher: `/admin/api/labels/issue` and
 * `/admin/api/labels/retract` sign and persist a reviewer-authorized label
 * through the W9.2 guard, committing the signed `issued_labels` INSERTs and the
 * `operator_actions` audit row in one atomic `db.batch` via `commitMutation`.
 *
 * Retraction is a negation (`neg: true`) issuance on the same `(src, uri, val)`
 * stream — the ATProto stream has no delete. Authorization, CSRF, idempotency,
 * and replay are entirely the guard's; this module adds the W9.4 value allow-set
 * (policy-driven, minus the override-coupled pair W9.5 owns) and the
 * server-validated typed confirmation.
 */

import type { LabelSigner } from "@emdash-cms/registry-moderation";

import type { AccessAuthConfig, AccessKeyResolver } from "./access-auth.js";
import type { LabelerIdentityConfig } from "./config.js";
import {
	commitMutation,
	guardMutation,
	MutationGuardError,
	type MutationGuardDeps,
	type MutationSpec,
} from "./mutation-guard.js";
import { ReadGuardError } from "./operator-read-guard.js";
import { getLabelDefinition } from "./policy.js";
import {
	LabelIssuanceUnavailableError,
	parseSubjectKind,
	prepareManualLabelIssuance,
	readIssuedLabelByActionKey,
	type AllowedLabelProposal,
	type AuthorizedIssuanceAction,
} from "./service.js";
import { createLabelPublisher } from "./subscribe-labels.js";

const ADMIN_API_PREFIX = /^\/admin\/api\/?/;

/** Override-coupled labels: the atomic unblock action (W9.5) is the only path
 * that issues these, so the standalone issue/retract endpoints reject them. */
const OVERRIDE_COUPLED: ReadonlySet<string> = new Set([
	"assessment-passed",
	"assessment-overridden",
]);

export type LabelMutationCode = "CONFIRMATION_MISMATCH";

/**
 * A W9.4-specific rejection kept off `MutationGuardError` so the W9.2 guard's
 * code union stays untouched. Same wire shape as the guard error; the message is
 * static (never echoes the confirmation value).
 */
export class LabelMutationError extends Error {
	override readonly name = "LabelMutationError";
	readonly code: LabelMutationCode;
	readonly status = 400;

	constructor(code: LabelMutationCode) {
		super("Typed confirmation does not match the action subject");
		this.code = code;
	}

	toResponse(): Response {
		return Response.json(
			{ error: { code: this.code, message: this.message } },
			{ status: this.status },
		);
	}
}

export interface LabelActionBody {
	uri: string;
	val: string;
	cid?: string;
	/** Server-validated typed confirmation: the exact CID for a CID-bound action,
	 * the record rkey for a URI-wide one. Participates in the request fingerprint
	 * (it is part of the parsed body), so a replay must send the same value. */
	confirmation: string;
}

export interface ConsoleMutationDeps {
	db: D1Database;
	accessConfig: AccessAuthConfig;
	keys: AccessKeyResolver;
	config: LabelerIdentityConfig;
	createSigner: () => Promise<LabelSigner>;
	now: () => Date;
	/** Broadcasts the freshly committed label off the response path (keyed on our
	 * own action id, so a concurrent-race loser finds nothing and skips). Errors
	 * are swallowed by the implementation — cursor replay backstops a missed frame. */
	afterCommit: (actionId: string) => Promise<void>;
	/** Schedules `afterCommit` without blocking the response (workerd `waitUntil`). */
	defer: (work: Promise<unknown>) => void;
}

/**
 * The deterministic idempotent result stored by `commitMutation` and returned to
 * the client. Excludes `sequence` — that is assigned by a DB trigger at INSERT
 * time and is unknowable before the batch commits, so two replays would
 * otherwise disagree. The console re-reads the sequence from the label reads.
 */
export interface IssuedLabelDescriptor {
	actionId: string;
	val: string;
	uri: string;
	cid: string | null;
	neg: boolean;
	cts: string;
	effect: string;
}

export async function handleConsoleMutation(
	request: Request,
	deps: ConsoleMutationDeps,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const segments = url.pathname.replace(ADMIN_API_PREFIX, "").split("/").filter(Boolean);
		if (segments[0] !== "labels" || segments.length !== 2) throw new ReadGuardError("NOT_FOUND");
		if (segments[1] === "issue") return await runLabelMutation(request, deps, false);
		if (segments[1] === "retract") return await runLabelMutation(request, deps, true);
		throw new ReadGuardError("NOT_FOUND");
	} catch (error) {
		if (
			error instanceof MutationGuardError ||
			error instanceof ReadGuardError ||
			error instanceof LabelMutationError
		)
			return error.toResponse();
		// Transient signing-state unavailability (issuance paused, key stale, or the
		// in-batch signing guard suppressing the label under a rotation race) is
		// retryable — surface a 503 rather than a misleading 500 or a phantom 200.
		if (error instanceof LabelIssuanceUnavailableError)
			return Response.json(
				{
					error: {
						code: "LABEL_ISSUANCE_UNAVAILABLE",
						message: "Label issuance is temporarily unavailable; retry.",
					},
				},
				{ status: 503 },
			);
		console.error("[console-mutation] unhandled error", error);
		return Response.json(
			{ error: { code: "INTERNAL", message: "Internal error" } },
			{ status: 500 },
		);
	}
}

async function runLabelMutation(
	request: Request,
	deps: ConsoleMutationDeps,
	neg: boolean,
): Promise<Response> {
	const spec = makeSpec(neg);
	const guardDeps: MutationGuardDeps = {
		db: deps.db,
		config: deps.accessConfig,
		keys: deps.keys,
		now: deps.now,
	};
	const outcome = await guardMutation(request, spec, guardDeps);
	if (outcome.outcome === "replay") {
		await assertIssuancePersisted(deps.db, outcome.actionId);
		return jsonData(outcome.result);
	}

	const { ctx } = outcome;
	const signer = await deps.createSigner();
	const action: AuthorizedIssuanceAction = {
		actor: deps.config.labelerDid,
		type: "manual-label",
		reason: ctx.reason,
		// Keying the signing-layer idempotency on the guard's unique action id
		// makes the two idempotency layers consistent: a concurrent-race loser's
		// issuance INSERTs (keyed by its own actionId) roll back with its audit row.
		idempotencyKey: ctx.actionId,
	};
	const proposal: AllowedLabelProposal = {
		uri: ctx.body.uri,
		val: ctx.body.val,
		...(ctx.body.cid === undefined ? {} : { cid: ctx.body.cid }),
		neg,
	};
	const { statements } = await prepareManualLabelIssuance(
		deps.db,
		deps.config,
		signer,
		action,
		proposal,
		ctx.now,
	);
	const descriptor: IssuedLabelDescriptor = {
		actionId: ctx.actionId,
		val: proposal.val,
		uri: proposal.uri,
		cid: proposal.cid ?? null,
		neg,
		cts: ctx.now.toISOString(),
		effect: getLabelDefinition(proposal.val)?.officialEffect ?? "",
	};
	const returned = await commitMutation(deps.db, ctx, spec, statements, descriptor);
	await assertIssuancePersisted(deps.db, returned.actionId);
	deps.defer(deps.afterCommit(ctx.actionId));
	return jsonData(returned);
}

/**
 * Rejects a phantom success. The `operator_actions` audit row commits
 * unconditionally, but the `issued_labels` INSERT is guarded by an in-batch
 * signing-state condition — a key rotation landing between the signing pre-check
 * and the commit suppresses the label as a zero-row INSERT (not an error) while
 * the audit row lands, and that audit row stores the success descriptor as its
 * result. Both the proceed path and the replay path (which the guard serves from
 * that stored descriptor) must verify the label actually persisted for the
 * committed action, or a retry would return the suppressed issuance as a 200.
 * Keying on the committed action id distinguishes a genuine suppression (no
 * label) from a concurrent-race loss (the winner's action id, whose label is
 * present).
 */
async function assertIssuancePersisted(db: D1Database, actionId: string): Promise<void> {
	if (!(await readIssuedLabelByActionKey(db, actionId)))
		throw new LabelIssuanceUnavailableError("label issuance did not persist");
}

function makeSpec(neg: boolean): MutationSpec<LabelActionBody> {
	return {
		action: neg ? "label-retract" : "label-issue",
		requiredRole: "reviewer",
		parseBody: (raw) => {
			const body = parseLabelActionBody(raw);
			assertW94Issuable(body);
			assertConfirmation(body);
			return body;
		},
		auditFields: (body) => ({
			subjectUri: body.uri,
			subjectCid: body.cid,
			labelValue: body.val,
			metadata: { neg, effect: getLabelDefinition(body.val)?.officialEffect ?? null },
		}),
	};
}

function parseLabelActionBody(raw: Record<string, unknown>): LabelActionBody {
	const uri = requireString(raw.uri);
	const val = requireString(raw.val);
	const confirmation = requireString(raw.confirmation);
	const cid = optionalString(raw.cid);
	return { uri, val, ...(cid === undefined ? {} : { cid }), confirmation };
}

/**
 * The W9.4 value allow-set, policy-driven so a fixture grant lights up a value
 * with no code change: the label's `subjectRules` must grant `reviewer` for the
 * URI's subject, the matched rule's `cidRule` must be satisfied, and the value
 * must not be one of the override-coupled pair (W9.5). The admin-only labels
 * (`!takedown`, `publisher-compromised`) are rejected here because their rules
 * carry no `reviewer` mode — they are W9.6. Enforcing `cidRule` here (not only in
 * the issuer's `validateManualProposal`) makes a scope mismatch a clean 400
 * before signing rather than a 500 mid-issuance.
 */
function assertW94Issuable(body: LabelActionBody): void {
	if (OVERRIDE_COUPLED.has(body.val)) throw new MutationGuardError("INVALID_BODY");
	const definition = getLabelDefinition(body.val);
	if (!definition) throw new MutationGuardError("INVALID_BODY");
	const subject = parseSubjectKind(body.uri);
	if (subject === null) throw new MutationGuardError("INVALID_BODY");
	const rule = definition.subjectRules.find((candidate) => candidate.subject === subject);
	if (!rule || !rule.issuanceModes.includes("reviewer"))
		throw new MutationGuardError("INVALID_BODY");
	if (rule.cidRule === "forbidden" && body.cid !== undefined)
		throw new MutationGuardError("INVALID_BODY");
	if (rule.cidRule === "required" && body.cid === undefined)
		throw new MutationGuardError("INVALID_BODY");
}

/**
 * Server-validated typed confirmation (§11.4, §20.2 "enforcement is code, not
 * prompt text"): a CID-bound action must confirm the exact CID; a URI-wide one
 * must confirm the record rkey (the final AT-URI path segment). A scripted
 * client cannot skip the ceremony.
 */
function assertConfirmation(body: LabelActionBody): void {
	const expected = body.cid !== undefined ? body.cid : rkeyOf(body.uri);
	if (body.confirmation !== expected) throw new LabelMutationError("CONFIRMATION_MISMATCH");
}

function rkeyOf(uri: string): string {
	return uri.split("/").at(-1) ?? "";
}

function requireString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new MutationGuardError("INVALID_BODY");
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new MutationGuardError("INVALID_BODY");
	return value;
}

function jsonData<T>(data: T): Response {
	return Response.json({ data }, { headers: { "cache-control": "no-store" } });
}

/**
 * Best-effort live broadcast of a freshly committed label, run off the response
 * path. Keyed on the caller's own action id: a concurrent-race loser (whose
 * batch rolled back) reads nothing and skips, so the winner alone publishes.
 * Publication needs the trigger-assigned `sequence`, which only exists
 * post-commit — this uses a plain read, not `postCommit()`, so a deliberately
 * absent row is `null` (skip) rather than a signing-state diagnosis. A missed
 * frame is recoverable: subscribers replay from their cursor on reconnect.
 */
export async function publishAfterCommit(env: Env, actionId: string): Promise<void> {
	try {
		const issued = await readIssuedLabelByActionKey(env.DB, actionId);
		if (!issued) return;
		await createLabelPublisher(env).publish(issued);
	} catch (error) {
		console.error("[console-mutation] publish failed", error);
	}
}
