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
import { ulid } from "ulidx";

import type { AccessAuthConfig, AccessKeyResolver } from "./access-auth.js";
import {
	automatedIdempotencyKey,
	computeRunKey,
	operatorTriggerId,
} from "./assessment-lifecycle.js";
import {
	advanceAssessmentToPending,
	buildAssessmentRunStatement,
	getAssessment,
	type Assessment,
} from "./assessment-store.js";
import type { LabelerIdentityConfig } from "./config.js";
import {
	commitMutation,
	guardMutation,
	MutationGuardError,
	type MutationGuardDeps,
	type MutationSpec,
} from "./mutation-guard.js";
import {
	buildOperationalEventInsert,
	buildOutboxInsert,
	newOperationalEventId,
	type OperationalEventType,
} from "./operational-events.js";
import { ReadGuardError } from "./operator-read-guard.js";
import { getLabelDefinition, MODERATION_POLICY } from "./policy.js";
import {
	assertNegatableBlockSet,
	LabelIssuanceUnavailableError,
	NegatableBlockSetError,
	overridePieceKey,
	parseSubjectKind,
	prepareAutomatedLabelIssuance,
	prepareManualLabelIssuance,
	prepareOverrideIssuance,
	readIssuedLabelByActionKey,
	type AllowedLabelProposal,
	type AuthorizedIssuanceAction,
} from "./service.js";
import { createLabelPublisher } from "./subscribe-labels.js";

/** Model/prompt/scanner-set run-key components for an operator rerun. Like
 * discovery's, these are stable stubs until W7/W8 wire real stage adapters; the
 * run's identity comes from the operator trigger, so these need only be
 * deterministic across replays. */
const RERUN_MODEL_ID = "unassigned";
const RERUN_PROMPT_HASH = "unassigned";
const RERUN_SCANNER_SET_VERSION = "unassigned";

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
		if (segments[0] === "labels" && segments.length === 2) {
			if (segments[1] === "issue") return await runLabelMutation(request, deps, false);
			if (segments[1] === "retract") return await runLabelMutation(request, deps, true);
		}
		if (segments[0] === "assessments" && segments.length === 3 && segments[1] !== undefined) {
			const id = segments[1];
			if (segments[2] === "rerun") return await runRerun(request, deps, id);
			if (segments[2] === "override") return await runOverride(request, deps, id);
			if (segments[2] === "override-retract") return await runOverrideRetract(request, deps, id);
		}
		if (segments[0] === "emergency" && segments.length === 2) {
			if (segments[1] === "takedown")
				return await runEmergencyAction(request, deps, "takedown", false);
			if (segments[1] === "takedown-retract")
				return await runEmergencyAction(request, deps, "takedown", true);
			if (segments[1] === "publisher-compromised")
				return await runEmergencyAction(request, deps, "publisher-compromised", false);
			if (segments[1] === "publisher-compromised-retract")
				return await runEmergencyAction(request, deps, "publisher-compromised", true);
		}
		throw new ReadGuardError("NOT_FOUND");
	} catch (error) {
		if (
			error instanceof MutationGuardError ||
			error instanceof ReadGuardError ||
			error instanceof LabelMutationError
		)
			return error.toResponse();
		// A submitted override negation set that isn't exactly the live automated
		// block set is a 400 — the reviewer acted on a stale view (a block cleared
		// or appeared since the console loaded) or a crafted set.
		if (error instanceof NegatableBlockSetError)
			return new MutationGuardError("INVALID_BODY").toResponse();
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
		await assertIssuancePersisted(deps.db, [outcome.actionId]);
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
	await assertIssuancePersisted(deps.db, [returned.actionId]);
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
 *
 * For a multi-label batch (W9.5 override: `N` negations + the eligibility pair;
 * override-retract: two negations; rerun: the pending label) every issuance key
 * must persist — a mid-batch signing-state suppression drops all of them
 * together while the audit row commits, so a single missing key is enough to
 * treat the whole action as not-persisted and 503-retry.
 */
async function assertIssuancePersisted(db: D1Database, issuanceKeys: string[]): Promise<void> {
	for (const key of issuanceKeys) {
		if (!(await readIssuedLabelByActionKey(db, key)))
			throw new LabelIssuanceUnavailableError("label issuance did not persist");
	}
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

function requireStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) throw new MutationGuardError("INVALID_BODY");
	return value.map((entry) => requireString(entry));
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

// ─── W9.5: assessment rerun + false-positive override ───────────────────────

/** The URL path's assessment id, folded into the parsed body so it joins the
 * request fingerprint — a replayed key must target the same assessment. */
interface AssessmentActionBody {
	assessmentId: string;
	/** The release CID, server-validated against the loaded assessment. */
	confirmation: string;
}

interface OverrideActionBody extends AssessmentActionBody {
	/** The active automated blocking labels the reviewer observed; validated
	 * against the live negatable set before signing. */
	negate: string[];
}

/** Idempotent rerun result (no `sequence`; assigned post-commit). */
interface RerunDescriptor {
	actionId: string;
	runId: string;
	triggerId: string;
	uri: string;
	cid: string;
	cts: string;
}

interface OverrideDescriptor {
	actionId: string;
	uri: string;
	cid: string;
	negated: string[];
	issued: string[];
	cts: string;
}

interface OverrideRetractDescriptor {
	actionId: string;
	uri: string;
	cid: string;
	negated: string[];
	cts: string;
}

const OVERRIDE_RETRACT_PAIR = ["assessment-passed", "assessment-overridden"] as const;

function guardDepsOf(deps: ConsoleMutationDeps): MutationGuardDeps {
	return { db: deps.db, config: deps.accessConfig, keys: deps.keys, now: deps.now };
}

/** Loads the assessment named in the path; a malformed id or a missing row is a
 * 404 (`getAssessment` throws `TypeError` on a bad id). */
async function loadAssessment(db: D1Database, id: string): Promise<Assessment> {
	let assessment: Assessment | null;
	try {
		assessment = await getAssessment(db, id);
	} catch (error) {
		if (error instanceof TypeError) throw new ReadGuardError("NOT_FOUND");
		throw error;
	}
	if (!assessment) throw new ReadGuardError("NOT_FOUND");
	return assessment;
}

/** CID-bound confirmation ceremony: the typed confirmation must be the exact
 * release CID from the loaded assessment (the W9.4 check, resolved server-side
 * from the assessment rather than an echoed body CID). */
function assertConfirmationCid(confirmation: string, cid: string): void {
	if (confirmation !== cid) throw new LabelMutationError("CONFIRMATION_MISMATCH");
}

/** The stored `result_json` this handler itself wrote on the original commit,
 * trusted on replay. */
function storedDescriptor<T>(result: unknown): T {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- our own stored descriptor
	return result as T;
}

function overrideIssuanceKeys(
	actionId: string,
	negated: readonly string[],
	issued: readonly string[],
): string[] {
	return [
		...negated.map((val) => overridePieceKey(actionId, val, true)),
		...issued.map((val) => overridePieceKey(actionId, val, false)),
	];
}

function rerunRunKey(uri: string, cid: string, triggerId: string): Promise<string> {
	return computeRunKey({
		uri,
		cid,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: RERUN_MODEL_ID,
		promptHash: RERUN_PROMPT_HASH,
		scannerSetVersion: RERUN_SCANNER_SET_VERSION,
		triggerId,
	});
}

/** Off-response tail (re-driven on replay, all pieces idempotent): advance the
 * fresh run `observed → pending` and publish the pending label. The label is in
 * the atomic batch, so the release re-gates to pending atomically with the audit
 * row; only this internal state advance is deferred. */
function deferRerunTail(deps: ConsoleMutationDeps, runId: string, pendingKey: string): void {
	deps.defer(
		(async () => {
			try {
				const run = await getAssessment(deps.db, runId);
				if (run) await advanceAssessmentToPending(deps.db, run, deps.now());
			} catch (error) {
				console.error("[console-mutation] rerun advance failed", error);
			}
			await deps.afterCommit(pendingKey);
		})(),
	);
}

function deferPublishAll(deps: ConsoleMutationDeps, issuanceKeys: readonly string[]): void {
	deps.defer(Promise.all(issuanceKeys.map((key) => deps.afterCommit(key))));
}

/**
 * `POST /admin/api/assessments/:id/rerun` — mints the immutable operator trigger
 * (`operator:<actionId>`), creates a fresh run for the assessment's exact URI+CID
 * anchored to that trigger, and re-issues `assessment-pending`, all in one atomic
 * batch with the audit row (spec §10/§11.2). Production wiring stops at pending
 * (as initial discovery does today), so the run sits at `pending` until W7/W8
 * supply stage adapters.
 */
async function runRerun(
	request: Request,
	deps: ConsoleMutationDeps,
	id: string,
): Promise<Response> {
	const spec: MutationSpec<AssessmentActionBody> = {
		action: "assessment-rerun",
		requiredRole: "reviewer",
		parseBody: (raw) => ({ assessmentId: id, confirmation: requireString(raw.confirmation) }),
		auditFields: () => ({}),
	};
	const outcome = await guardMutation(request, spec, guardDepsOf(deps));
	if (outcome.outcome === "replay") {
		const stored = storedDescriptor<RerunDescriptor>(outcome.result);
		const pendingKey = automatedIdempotencyKey(
			await rerunRunKey(stored.uri, stored.cid, stored.triggerId),
			"assessment-pending",
			false,
		);
		await assertIssuancePersisted(deps.db, [pendingKey]);
		deferRerunTail(deps, stored.runId, pendingKey);
		return jsonData(stored);
	}

	const { ctx } = outcome;
	const assessment = await loadAssessment(deps.db, id);
	assertConfirmationCid(ctx.body.confirmation, assessment.cid);

	const triggerId = operatorTriggerId(ctx.actionId);
	const runKey = await rerunRunKey(assessment.uri, assessment.cid, triggerId);
	const runId = `asmt_${ulid()}`;
	const pendingKey = automatedIdempotencyKey(runKey, "assessment-pending", false);

	const runStatement = buildAssessmentRunStatement(deps.db, {
		id: runId,
		runKey,
		uri: assessment.uri,
		cid: assessment.cid,
		trigger: "operator",
		triggerId,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: RERUN_MODEL_ID,
		promptHash: RERUN_PROMPT_HASH,
		coverageJson: "{}",
		now: ctx.now,
	});
	const signer = await deps.createSigner();
	const pending = await prepareAutomatedLabelIssuance(
		deps.db,
		deps.config,
		signer,
		{
			actor: deps.config.labelerDid,
			type: "automated-assessment",
			assessmentId: runId,
			reason: ctx.reason,
			idempotencyKey: pendingKey,
		},
		{ uri: assessment.uri, cid: assessment.cid, val: "assessment-pending" },
		ctx.now,
	);

	const descriptor: RerunDescriptor = {
		actionId: ctx.actionId,
		runId,
		triggerId,
		uri: assessment.uri,
		cid: assessment.cid,
		cts: ctx.now.toISOString(),
	};
	const commitSpec: MutationSpec<AssessmentActionBody> = {
		...spec,
		auditFields: () => ({
			subjectUri: assessment.uri,
			subjectCid: assessment.cid,
			labelValue: "assessment-pending",
			metadata: { runId, triggerId },
		}),
	};
	// The run row precedes the pending issuance in the batch so the
	// `issuance_actions.assessment_id → runId` FK resolves within the transaction.
	const returned = await commitMutation(
		deps.db,
		ctx,
		commitSpec,
		[runStatement, ...pending.statements],
		descriptor,
	);
	// Derive the persistence + tail keys from the committed descriptor, not the
	// locally built ones: on a concurrent-key race `commitMutation` returns the
	// winner's stored descriptor, whose run + pending label are the ones on disk.
	const committedPendingKey = automatedIdempotencyKey(
		await rerunRunKey(returned.uri, returned.cid, returned.triggerId),
		"assessment-pending",
		false,
	);
	await assertIssuancePersisted(deps.db, [committedPendingKey]);
	deferRerunTail(deps, returned.runId, committedPendingKey);
	return jsonData(returned);
}

/**
 * `POST /admin/api/assessments/:id/override` — the atomic false-positive unblock
 * (spec §7.1/§20.2). One `commitMutation` batch commits the audit row, `N`
 * negations of the live automated blocking labels for the exact URI+CID, and the
 * `assessment-passed` + `assessment-overridden` eligibility pair. The submitted
 * `negate` set must equal the live negatable automated-block set (else 400) so
 * the reviewer cannot override against a stale view.
 */
async function runOverride(
	request: Request,
	deps: ConsoleMutationDeps,
	id: string,
): Promise<Response> {
	const spec: MutationSpec<OverrideActionBody> = {
		action: "unblock-override",
		requiredRole: "reviewer",
		parseBody: (raw) => ({
			assessmentId: id,
			confirmation: requireString(raw.confirmation),
			negate: requireStringArray(raw.negate),
		}),
		auditFields: () => ({}),
	};
	const outcome = await guardMutation(request, spec, guardDepsOf(deps));
	if (outcome.outcome === "replay") {
		const stored = storedDescriptor<OverrideDescriptor>(outcome.result);
		const keys = overrideIssuanceKeys(stored.actionId, stored.negated, stored.issued);
		await assertIssuancePersisted(deps.db, keys);
		deferPublishAll(deps, keys);
		return jsonData(stored);
	}

	const { ctx } = outcome;
	const assessment = await loadAssessment(deps.db, id);
	assertConfirmationCid(ctx.body.confirmation, assessment.cid);
	// Throws NegatableBlockSetError (→ 400) unless the submitted set is exactly
	// the live automated-block set for the exact URI+CID.
	await assertNegatableBlockSet(
		deps.db,
		deps.config.labelerDid,
		{ uri: assessment.uri, cid: assessment.cid },
		ctx.body.negate,
	);

	const signer = await deps.createSigner();
	const overrideStatements = await prepareOverrideIssuance(
		deps.db,
		deps.config,
		signer,
		{
			actor: deps.config.labelerDid,
			type: "manual-label",
			reason: ctx.reason,
			idempotencyKey: ctx.actionId,
		},
		{ uri: assessment.uri, cid: assessment.cid, negate: ctx.body.negate },
		ctx.now,
	);

	const descriptor: OverrideDescriptor = {
		actionId: ctx.actionId,
		uri: assessment.uri,
		cid: assessment.cid,
		negated: [...ctx.body.negate],
		issued: [...OVERRIDE_RETRACT_PAIR],
		cts: ctx.now.toISOString(),
	};
	const commitSpec: MutationSpec<OverrideActionBody> = {
		...spec,
		auditFields: () => ({
			subjectUri: assessment.uri,
			subjectCid: assessment.cid,
			labelValue: "assessment-overridden",
			metadata: { negated: descriptor.negated, issued: descriptor.issued },
		}),
	};
	const returned = await commitMutation(deps.db, ctx, commitSpec, overrideStatements, descriptor);
	// Keys from the committed descriptor (winner's on a race), not the loser's.
	const committedKeys = overrideIssuanceKeys(returned.actionId, returned.negated, returned.issued);
	await assertIssuancePersisted(deps.db, committedKeys);
	deferPublishAll(deps, committedKeys);
	return jsonData(returned);
}

/**
 * `POST /admin/api/assessments/:id/override-retract` — negates only the
 * `assessment-passed` + `assessment-overridden` override pair in one batch. The
 * originally-negated automated blocks stay negated (retraction does not re-issue
 * them — that would mint automated findings as permanent manual labels); the
 * release returns to `blocked` / `missing-assessment-pass`. A rerun re-surfaces
 * real findings with correct automated provenance.
 */
async function runOverrideRetract(
	request: Request,
	deps: ConsoleMutationDeps,
	id: string,
): Promise<Response> {
	const spec: MutationSpec<AssessmentActionBody> = {
		action: "override-retract",
		requiredRole: "reviewer",
		parseBody: (raw) => ({ assessmentId: id, confirmation: requireString(raw.confirmation) }),
		auditFields: () => ({}),
	};
	const outcome = await guardMutation(request, spec, guardDepsOf(deps));
	if (outcome.outcome === "replay") {
		const stored = storedDescriptor<OverrideRetractDescriptor>(outcome.result);
		const keys = stored.negated.map((val) => overridePieceKey(stored.actionId, val, true));
		await assertIssuancePersisted(deps.db, keys);
		deferPublishAll(deps, keys);
		return jsonData(stored);
	}

	const { ctx } = outcome;
	const assessment = await loadAssessment(deps.db, id);
	assertConfirmationCid(ctx.body.confirmation, assessment.cid);

	const signer = await deps.createSigner();
	const statements: D1PreparedStatement[] = [];
	for (const val of OVERRIDE_RETRACT_PAIR) {
		const built = await prepareManualLabelIssuance(
			deps.db,
			deps.config,
			signer,
			{
				actor: deps.config.labelerDid,
				type: "manual-label",
				reason: ctx.reason,
				idempotencyKey: overridePieceKey(ctx.actionId, val, true),
			},
			{ uri: assessment.uri, val, cid: assessment.cid, neg: true },
			ctx.now,
		);
		statements.push(...built.statements);
	}

	const descriptor: OverrideRetractDescriptor = {
		actionId: ctx.actionId,
		uri: assessment.uri,
		cid: assessment.cid,
		negated: [...OVERRIDE_RETRACT_PAIR],
		cts: ctx.now.toISOString(),
	};
	const commitSpec: MutationSpec<AssessmentActionBody> = {
		...spec,
		auditFields: () => ({
			subjectUri: assessment.uri,
			subjectCid: assessment.cid,
			labelValue: "assessment-overridden",
			metadata: { negated: descriptor.negated },
		}),
	};
	const returned = await commitMutation(deps.db, ctx, commitSpec, statements, descriptor);
	// Keys from the committed descriptor (winner's on a race), not the loser's.
	const committedKeys = returned.negated.map((val) =>
		overridePieceKey(returned.actionId, val, true),
	);
	await assertIssuancePersisted(deps.db, committedKeys);
	deferPublishAll(deps, committedKeys);
	return jsonData(returned);
}

// ─── W9.6: admin-only emergency actions (!takedown, publisher-compromised) ───

type EmergencyAction = "takedown" | "publisher-compromised";

const EMERGENCY_VALUE: Record<EmergencyAction, string> = {
	takedown: "!takedown",
	"publisher-compromised": "publisher-compromised",
};

const EMERGENCY_EVENT_TYPE: Record<EmergencyAction, OperationalEventType> = {
	takedown: "emergency-takedown",
	"publisher-compromised": "publisher-compromised",
};

/** The second typed ceremony field: a server constant the operator must retype
 * verbatim, distinct per action and per direction so a scripted client cannot
 * skip the ceremony and a retract cannot be replayed as an issuance. */
const EMERGENCY_INTENT: Record<EmergencyAction, { issue: string; retract: string }> = {
	takedown: { issue: "CONFIRM TAKEDOWN", retract: "CONFIRM RETRACT" },
	"publisher-compromised": { issue: "CONFIRM COMPROMISE", retract: "CONFIRM RETRACT" },
};

const EMERGENCY_CHANNEL = "deployment-alert";

/**
 * The two-field emergency ceremony body (design §3). `val` and `neg` are fixed
 * by the endpoint, not read from the client, so the wire body carries only the
 * subject and the two typed confirmations. Both `subjectConfirmation` and
 * `intent` are part of the parsed body, so both fold into the request
 * fingerprint (`computeRequestFingerprint` hashes the whole normalized body) —
 * a replay must resend identical values.
 */
interface EmergencyActionBody {
	uri: string;
	val: string;
	neg: boolean;
	subjectConfirmation: string;
	intent: string;
}

/** The idempotent emergency result — the same shape as a label descriptor
 * (`cid` is always null: every emergency label is URI-wide / DID-subject). */
type EmergencyDescriptor = IssuedLabelDescriptor;

/**
 * `POST /admin/api/emergency/{takedown,publisher-compromised}` and their
 * `-retract` siblings — the admin-only crown-jewel actions (spec §11.3/§18.2,
 * design §2–§4). Issuance flows through `prepareManualLabelIssuance` unchanged;
 * the delta from the reviewer issue endpoint is the `admin` role, the
 * admin-issuable policy gate, the two-field ceremony, and the label-gated
 * operational event + notification outbox committed in the same atomic batch.
 * Retraction is the same path with `neg: true` and a `CONFIRM RETRACT` intent;
 * its resting state is the subject's pre-takedown computed state (the automated
 * labels, never negated, re-expose — nothing is re-issued).
 */
async function runEmergencyAction(
	request: Request,
	deps: ConsoleMutationDeps,
	action: EmergencyAction,
	neg: boolean,
): Promise<Response> {
	const val = EMERGENCY_VALUE[action];
	const spec: MutationSpec<EmergencyActionBody> = {
		action,
		requiredRole: "admin",
		parseBody: (raw) => {
			const body: EmergencyActionBody = {
				uri: requireString(raw.uri),
				val,
				neg,
				subjectConfirmation: requireString(raw.subjectConfirmation),
				intent: requireString(raw.intent),
			};
			assertAdminIssuable(body);
			assertEmergencyConfirmation(body, action, neg);
			return body;
		},
		auditFields: (body) => ({
			subjectUri: body.uri,
			labelValue: val,
			metadata: { neg, effect: getLabelDefinition(val)?.officialEffect ?? null },
		}),
	};

	const outcome = await guardMutation(request, spec, guardDepsOf(deps));
	if (outcome.outcome === "replay") {
		const stored = storedDescriptor<EmergencyDescriptor>(outcome.result);
		await assertIssuancePersisted(deps.db, [stored.actionId]);
		return jsonData(stored);
	}

	const { ctx } = outcome;
	const signer = await deps.createSigner();
	const issuance = await prepareManualLabelIssuance(
		deps.db,
		deps.config,
		signer,
		{
			actor: deps.config.labelerDid,
			type: "manual-label",
			reason: ctx.reason,
			idempotencyKey: ctx.actionId,
		},
		{ uri: ctx.body.uri, val, neg },
		ctx.now,
	);

	// The event + outbox are gated on the label's in-batch existence keyed by the
	// issuance idempotency key (= this action id): a signing-state race that
	// suppresses the label INSERT drops the event and outbox with it, so no
	// "takedown issued" alert fires for a takedown that never landed (T1).
	const eventId = newOperationalEventId();
	const eventInsert = buildOperationalEventInsert(deps.db, {
		id: eventId,
		eventType: EMERGENCY_EVENT_TYPE[action],
		severity: neg ? "high" : "critical",
		actionId: ctx.actionId,
		subjectUri: ctx.body.uri,
		labelValue: val,
		payload: { reason: ctx.reason },
		now: ctx.now,
		gateOnIssuedLabelActionKey: ctx.actionId,
	});
	const outboxInsert = buildOutboxInsert(deps.db, {
		eventId,
		channel: EMERGENCY_CHANNEL,
		now: ctx.now,
		gateOnIssuedLabelActionKey: ctx.actionId,
	});

	const descriptor: EmergencyDescriptor = {
		actionId: ctx.actionId,
		val,
		uri: ctx.body.uri,
		cid: null,
		neg,
		cts: ctx.now.toISOString(),
		effect: getLabelDefinition(val)?.officialEffect ?? "",
	};
	const returned = await commitMutation(
		deps.db,
		ctx,
		spec,
		[...issuance.statements, eventInsert, outboxInsert],
		descriptor,
	);
	await assertIssuancePersisted(deps.db, [returned.actionId]);
	deps.defer(deps.afterCommit(returned.actionId));
	return jsonData(returned);
}

/**
 * The admin issuance gate, policy-driven like `assertW94Issuable` but requiring
 * the matched `subjectRule` to grant `admin`: `!takedown` on a release, package,
 * or publisher; `publisher-compromised` on a publisher. Every emergency label is
 * `cidRule: forbidden`, and the wire body carries no CID, so scope is satisfied
 * structurally. A subject the value does not grant `admin` for (e.g.
 * `publisher-compromised` on a release) is a clean 400 before signing.
 */
function assertAdminIssuable(body: EmergencyActionBody): void {
	const definition = getLabelDefinition(body.val);
	if (!definition) throw new MutationGuardError("INVALID_BODY");
	const subject = parseSubjectKind(body.uri);
	if (subject === null) throw new MutationGuardError("INVALID_BODY");
	const rule = definition.subjectRules.find((candidate) => candidate.subject === subject);
	if (!rule || !rule.issuanceModes.includes("admin")) throw new MutationGuardError("INVALID_BODY");
}

/**
 * The two-field ceremony (design §3), enforced in code, not prompt text. The
 * typed subject identifier is the record rkey for a release/package and the
 * DID's final `:`-segment for a publisher, tying the confirmation to the parsed
 * subject kind — a URI whose kind mismatches the typed identifier fails (T7).
 * The typed intent must equal the server constant for this action + direction.
 * Both errors are the static `CONFIRMATION_MISMATCH`, which never echoes the
 * typed value.
 */
function assertEmergencyConfirmation(
	body: EmergencyActionBody,
	action: EmergencyAction,
	neg: boolean,
): void {
	const subject = parseSubjectKind(body.uri);
	const expectedSubject = subject === "publisher" ? didFinalSegment(body.uri) : rkeyOf(body.uri);
	if (body.subjectConfirmation !== expectedSubject)
		throw new LabelMutationError("CONFIRMATION_MISMATCH");
	const expectedIntent = EMERGENCY_INTENT[action][neg ? "retract" : "issue"];
	if (body.intent !== expectedIntent) throw new LabelMutationError("CONFIRMATION_MISMATCH");
}

/** A publisher subject's typed confirmation is its DID's final `:`-segment (the
 * PLC/web identifier), not a resolved handle. */
function didFinalSegment(uri: string): string {
	return uri.split(":").at(-1) ?? "";
}
