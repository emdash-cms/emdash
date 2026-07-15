import type { LabelSigner, SignedLabel } from "@emdash-cms/registry-moderation";

import { ASSESSMENT_ID } from "./assessment-lifecycle.js";
import { getNegatableAutomatedLabels } from "./assessment-store.js";
import type { LabelerConfig } from "./config.js";
import type { FindingSeverity } from "./evidence.js";
import { getLabelDefinition, type SubjectKind } from "./policy.js";
import {
	getSigningStatusIfInitialized,
	recordSigningAlert,
	validateKeyVersion,
	verifyLabelForSigningStatus,
} from "./signing-rotation.js";
import type { LabelPublisher } from "./subscribe-labels.js";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const REGISTRY_RECORD =
	/^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/(com\.emdashcms\.experimental\.package\.(?:profile|release))\/([A-Za-z0-9._~:%-]+)$/;

/**
 * Issuance could not proceed because the signing state is transiently
 * unavailable (paused or mid-rotation), not because the request is invalid.
 * Callers should retry rather than dead-letter — otherwise a discovery
 * event arriving during a key rotation permanently loses its label.
 */
export class LabelIssuanceUnavailableError extends Error {
	override readonly name = "LabelIssuanceUnavailableError";
}

export type ManualLabelValue =
	| "!takedown"
	| "package-disputed"
	| "publisher-compromised"
	| "security-yanked";

export interface AuthorizedIssuanceAction {
	actor: string;
	type: "manual-label";
	reason: string;
	idempotencyKey: string;
}

export interface AutomatedIssuanceAction {
	actor: string;
	type: "automated-assessment";
	assessmentId: string;
	reason: string;
	idempotencyKey: string;
}

export type IssuanceAction = AuthorizedIssuanceAction | AutomatedIssuanceAction;

export interface AllowedLabelProposal {
	uri: string;
	/** Any label whose policy `subjectRules` grant a `reviewer` or `admin`
	 * issuance mode for the parsed subject — validated in `validateManualProposal`
	 * against the ratified fixture, not a hardcoded union, so a fixture grant lights
	 * up a value with no code change. */
	val: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

export interface AutomatedLabelProposal {
	uri: string;
	val: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
	/** Required, and validated as an allowed automated-block category, when `val`'s policy category is automated-block. */
	findingCategory?: string;
	/** Required (and must be at least "high") when `val`'s policy category is automated-block. */
	severity?: FindingSeverity;
}

export type IssuanceProposal = AllowedLabelProposal | AutomatedLabelProposal;

export interface IssuedLabel {
	action: IssuanceAction;
	label: SignedLabel;
	sequence: number;
	signingKeyId: string;
	signingKeyVersion: string;
}

interface StoredLabelRow {
	actor: string;
	type: string;
	reason: string;
	idempotency_key: string;
	assessment_id: string | null;
	sequence: number;
	ver: number;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	exp: string | null;
	sig: ArrayBuffer;
	signing_key_id: string;
	signing_key_version: string;
	publication_pending: number;
}

export interface IssuanceStatements {
	statements: D1PreparedStatement[];
	postCommit: () => Promise<IssuedLabel>;
}

/**
 * Builds the two INSERT statements that record an issuance action and its
 * signed label, sharing the same signing/rotation guards for both the
 * manual and automated-assessment paths. `publicationPending` must reflect
 * whether the caller intends to publish the result, because rotation
 * activation checks `issued_labels.publication_pending` for the row this
 * batch is about to create — the flag has to be right at INSERT time, not
 * patched in afterward.
 */
export async function buildIssuanceStatements(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: IssuanceAction,
	proposal: IssuanceProposal,
	now: Date,
	publicationPending: boolean,
): Promise<IssuanceStatements> {
	const signingStatus = await getSigningStatusIfInitialized(db);
	if (signingStatus?.phase === "paused") {
		await recordSigningAlert(db, "ISSUANCE_PAUSED", {
			activeKeyVersion: signingStatus.activeKeyVersion,
			targetKeyVersion: config.signingKeyVersion,
			rotationId: signingStatus.rotationId,
		});
		throw new LabelIssuanceUnavailableError("label issuance is paused");
	}
	if (signingStatus && signingStatus.activeKeyVersion !== config.signingKeyVersion) {
		await recordSigningAlert(db, "STALE_SIGNING_KEY", {
			activeKeyVersion: signingStatus.activeKeyVersion,
			targetKeyVersion: config.signingKeyVersion,
			rotationId: signingStatus.rotationId,
		});
		throw new LabelIssuanceUnavailableError("label signing key version is stale");
	}

	if (action.type === "automated-assessment" && proposal.neg === true) {
		await assertAutomatedNegationAllowed(db, signer.issuerDid, proposal);
	}

	const unsignedLabel = {
		ver: 1,
		uri: proposal.uri,
		...(proposal.cid === undefined ? {} : { cid: proposal.cid }),
		val: proposal.val,
		...(proposal.neg === true ? { neg: true } : {}),
		cts: now.toISOString(),
		...(proposal.exp === undefined ? {} : { exp: proposal.exp }),
	} as const;
	const returned = await signer.sign(unsignedLabel);
	const label: SignedLabel = { ...unsignedLabel, src: signer.issuerDid, sig: returned.sig };
	if (signingStatus) {
		try {
			await verifyLabelForSigningStatus(
				signingStatus,
				{ signer, keyVersion: config.signingKeyVersion },
				label,
			);
		} catch {
			await recordSigningAlert(db, "SIGNING_KEY_MISMATCH", {
				activeKeyVersion: signingStatus.activeKeyVersion,
				targetKeyVersion: config.signingKeyVersion,
				rotationId: signingStatus.rotationId,
				severity: "error",
			});
			throw new Error("label signer does not match the active public key");
		}
	}
	const signingKeyId = `${signer.issuerDid}#atproto_label`;
	const isPrebootstrap = signingStatus === null;
	const storedKeyVersion = isPrebootstrap ? "legacy" : config.signingKeyVersion;
	const assessmentId = action.type === "automated-assessment" ? action.assessmentId : null;
	// The §10 negation guard also runs as an in-batch condition on this
	// action insert: the pre-check above is a fast, friendly fail, but only a
	// condition inside the atomic batch closes the read-then-write race with a
	// concurrent manual issuance. Gating the action insert (not the label
	// insert) means a lost race leaves no orphan action — the label insert
	// selects from an action that was never written.
	const isAutomatedNegation = action.type === "automated-assessment" && proposal.neg === true;

	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, assessment_id, created_at)
				 SELECT ?, ?, ?, ?, ?, ?
				 WHERE (
					(? = 1 AND NOT EXISTS (SELECT 1 FROM signing_state))
					OR (? = 0 AND EXISTS (
						SELECT 1 FROM signing_state
						WHERE id = 1 AND phase = 'active' AND active_key_version = ?
					))
				 )
				 AND (
					? = 0
					OR NOT EXISTS (
						SELECT 1 FROM issued_labels l2
						JOIN issuance_actions a2 ON a2.id = l2.action_id
						WHERE l2.src = ? AND l2.uri = ? AND l2.val = ?
						  AND l2.sequence = (
							SELECT MAX(sequence) FROM issued_labels WHERE src = ? AND uri = ? AND val = ?
						  )
						  AND l2.neg = 0 AND a2.type <> 'automated-assessment'
					)
				 )
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				action.actor,
				action.type,
				action.reason,
				action.idempotencyKey,
				assessmentId,
				now.toISOString(),
				isPrebootstrap ? 1 : 0,
				isPrebootstrap ? 1 : 0,
				config.signingKeyVersion,
				isAutomatedNegation ? 1 : 0,
				signer.issuerDid,
				proposal.uri,
				proposal.val,
				signer.issuerDid,
				proposal.uri,
				proposal.val,
			),
		db
			.prepare(
				`INSERT INTO issued_labels
				 (action_id, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
				  signing_key_version, publication_pending)
				 SELECT a.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 FROM issuance_actions a
				 WHERE a.idempotency_key = ?
				 AND (
					(? = 1 AND NOT EXISTS (SELECT 1 FROM signing_state))
					OR (? = 0 AND EXISTS (
						SELECT 1 FROM signing_state
						WHERE id = 1 AND phase = 'active' AND active_key_version = ?
					))
				 )
				 AND NOT EXISTS (SELECT 1 FROM issued_labels WHERE action_id = a.id)`,
			)
			.bind(
				label.ver,
				label.src,
				label.uri,
				label.cid ?? null,
				label.val,
				label.neg === true ? 1 : 0,
				label.cts,
				label.exp ?? null,
				label.sig,
				signingKeyId,
				storedKeyVersion,
				publicationPending ? 1 : 0,
				action.idempotencyKey,
				isPrebootstrap ? 1 : 0,
				isPrebootstrap ? 1 : 0,
				config.signingKeyVersion,
			),
	];

	return {
		statements,
		postCommit: async () => {
			const issued = await getIssuedLabel(db, action.idempotencyKey);
			if (!issued) {
				if (isAutomatedNegation) {
					// The in-batch §10 guard suppresses the insert when a manual
					// label was committed after the pre-check. Re-run the guard so
					// the caller sees the policy violation, not a misleading
					// signing-state alert. If no manual label is present, this is a
					// no-op and we fall through to signing diagnosis.
					await assertAutomatedNegationAllowed(db, signer.issuerDid, proposal);
				}
				const status = await getSigningStatusIfInitialized(db);
				if (!status) throw new LabelIssuanceUnavailableError("label issuance did not persist");
				if (!signingStatus) {
					await recordSigningAlert(db, "SIGNING_STATE_CHANGED", {
						activeKeyVersion: status.activeKeyVersion,
						targetKeyVersion: config.signingKeyVersion,
						rotationId: status.rotationId,
					});
					throw new LabelIssuanceUnavailableError("signing state changed; retry label issuance");
				}
				if (status.phase === "paused") {
					await recordSigningAlert(db, "ISSUANCE_PAUSED", {
						activeKeyVersion: status.activeKeyVersion,
						targetKeyVersion: config.signingKeyVersion,
						rotationId: status.rotationId,
					});
					throw new LabelIssuanceUnavailableError("label issuance is paused");
				}
				await recordSigningAlert(db, "STALE_SIGNING_KEY", {
					activeKeyVersion: status.activeKeyVersion,
					targetKeyVersion: config.signingKeyVersion,
					rotationId: status.rotationId,
				});
				throw new LabelIssuanceUnavailableError("label signing key version is stale");
			}
			return assertMatches(issued, signer, action, proposal);
		},
	};
}

async function issueLabel(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: IssuanceAction,
	proposal: IssuanceProposal,
	now: Date,
	publisher?: LabelPublisher,
): Promise<IssuedLabel> {
	const existing = await getIssuedLabel(db, action.idempotencyKey);
	if (existing) {
		const status = await getSigningStatusIfInitialized(db);
		if (status && existing.signing_key_version !== status.activeKeyVersion) {
			await recordSigningAlert(db, "IDEMPOTENT_RETRY_STALE_SIGNATURE", {
				activeKeyVersion: status.activeKeyVersion,
				targetKeyVersion: existing.signing_key_version,
				rotationId: status.rotationId,
			});
			throw new LabelIssuanceUnavailableError("label signature must be refreshed before replay");
		}
		const result = assertMatches(existing, signer, action, proposal);
		if (publisher) {
			await claimPublication(db, existing, status);
			await publisher.publish(result);
			if (!publisher.managesPublicationState) await markPublicationAccepted(db, result);
		}
		return result;
	}

	const { statements, postCommit } = await buildIssuanceStatements(
		db,
		config,
		signer,
		action,
		proposal,
		now,
		publisher !== undefined,
	);
	await db.batch(statements);
	const result = await postCommit();
	// The D1 batch commits before this notification; replay covers subscribers
	// which connect before the singleton processes the post-commit broadcast.
	if (publisher) {
		await publisher.publish(result);
		if (!publisher.managesPublicationState) await markPublicationAccepted(db, result);
	}
	return result;
}

export async function issueManualLabel(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: AuthorizedIssuanceAction,
	proposal: AllowedLabelProposal,
	now = new Date(),
	publisher?: LabelPublisher,
): Promise<IssuedLabel> {
	if (signer.issuerDid !== config.labelerDid)
		throw new TypeError("signer issuer does not match the configured labeler DID");
	validateKeyVersion(config.signingKeyVersion);
	validateAction(action);
	validateManualProposal(proposal);
	return issueLabel(db, config, signer, action, proposal, now, publisher);
}

/**
 * Prepares (validates + signs) a manual label issuance without executing the
 * batch, returning the same `IssuanceStatements` `commitMutation` consumes so
 * the operator console can commit the signed label INSERTs in the same atomic
 * `db.batch` as the `operator_actions` audit row (plan W9.4). Mirrors the
 * validation half of `issueManualLabel`; the caller owns `db.batch` and
 * publication. `publicationPending` is `true` — the console publishes after the
 * commit via `readIssuedLabelByActionKey`.
 */
export async function prepareManualLabelIssuance(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: AuthorizedIssuanceAction,
	proposal: AllowedLabelProposal,
	now: Date,
): Promise<IssuanceStatements> {
	if (signer.issuerDid !== config.labelerDid)
		throw new TypeError("signer issuer does not match the configured labeler DID");
	validateKeyVersion(config.signingKeyVersion);
	validateAction(action);
	validateManualProposal(proposal);
	return buildIssuanceStatements(db, config, signer, action, proposal, now, true);
}

/**
 * Automated analog of `prepareManualLabelIssuance`: validates + signs an
 * automated-assessment issuance without executing the batch, returning the
 * `IssuanceStatements` a caller commits alongside its own statements (plan W9.5
 * rerun commits the `assessment-pending` label in the same `db.batch` as the
 * operator audit row and the new run). `publicationPending` is `true` — the
 * caller publishes post-commit.
 */
export async function prepareAutomatedLabelIssuance(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: AutomatedIssuanceAction,
	proposal: AutomatedLabelProposal,
	now: Date,
): Promise<IssuanceStatements> {
	if (signer.issuerDid !== config.labelerDid)
		throw new TypeError("signer issuer does not match the configured labeler DID");
	validateKeyVersion(config.signingKeyVersion);
	validateAutomatedAction(action);
	validateAutomatedProposal(proposal);
	return buildIssuanceStatements(db, config, signer, action, proposal, now, true);
}

export interface OverrideIssuanceSpec {
	uri: string;
	cid: string;
	/** The automated blocking labels to negate; must equal the live negatable
	 * automated-block set for `(labelerDid, uri, cid)` (validated here). */
	negate: readonly string[];
}

/** The reviewer override pair, issued together as the eligibility half of an
 * unblock (spec §7.1/§20.2). Order is load-bearing only for the descriptor. */
const OVERRIDE_ELIGIBILITY_LABELS = ["assessment-passed", "assessment-overridden"] as const;

/**
 * The distinct signing idempotency key for one label piece of a multi-label
 * operator action, derived from the single action's base key. Each `(val,
 * direction)` pair is unique within an override or retract, so every piece gets
 * its own `issuance_actions` + `issued_labels` row — a shared key would trip
 * `buildIssuanceStatements`' single-label-per-action guard. Shared with the
 * console handler so the post-commit persistence check reconstructs the same
 * keys on replay.
 */
export function overridePieceKey(base: string, val: string, neg: boolean): string {
	return `${base}:${val}:${neg ? "neg" : "pos"}`;
}

/**
 * Composes the reviewer false-positive override (plan W9.5) as one signed,
 * batchable statement set: `N` negations of the live automated blocking labels
 * for the exact release `(uri, cid)`, then the `assessment-passed` +
 * `assessment-overridden` eligibility pair. All pieces derive a distinct
 * issuance idempotency key from the single operator action (`${base}:${val}:
 * ${neg}`) so each gets its own `issuance_actions` + `issued_labels` row — a
 * shared key would trip `buildIssuanceStatements`' single-label-per-action
 * guard and silently drop all but the first.
 *
 * The negations are §20.2-authorized, not reviewer-issuance-mode labels, so they
 * bypass `validateManualProposal` (which requires a `reviewer`/`admin` mode the
 * automated blocks lack) and sign through `buildIssuanceStatements` directly.
 * The two eligibility labels go through the normal manual path. The submitted
 * `negate` set is validated against the live `getNegatableAutomatedLabels`
 * (filtered to `automated-block`), so a stale or crafted set is rejected before
 * signing rather than negating a different set than the reviewer saw.
 */
export async function prepareOverrideIssuance(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: AuthorizedIssuanceAction,
	spec: OverrideIssuanceSpec,
	now: Date,
): Promise<D1PreparedStatement[]> {
	if (signer.issuerDid !== config.labelerDid)
		throw new TypeError("signer issuer does not match the configured labeler DID");
	validateKeyVersion(config.signingKeyVersion);
	validateAction(action);
	if (parseSubjectKind(spec.uri) !== "release")
		throw new TypeError("override must target a release record");
	if (spec.cid.length === 0) throw new TypeError("override must include a release CID");

	const statements: D1PreparedStatement[] = [];

	for (const val of spec.negate) {
		const definition = getLabelDefinition(val);
		if (!definition || definition.category !== "automated-block")
			throw new TypeError(`${val} is not an automated blocking label`);
		const built = await buildIssuanceStatements(
			db,
			config,
			signer,
			{ ...action, idempotencyKey: overridePieceKey(action.idempotencyKey, val, true) },
			{ uri: spec.uri, val, cid: spec.cid, neg: true },
			now,
			true,
		);
		statements.push(...built.statements);
	}

	for (const val of OVERRIDE_ELIGIBILITY_LABELS) {
		const built = await prepareManualLabelIssuance(
			db,
			config,
			signer,
			{ ...action, idempotencyKey: overridePieceKey(action.idempotencyKey, val, false) },
			{ uri: spec.uri, val, cid: spec.cid, neg: false },
			now,
		);
		statements.push(...built.statements);
	}

	return statements;
}

/**
 * Validates that a submitted override `negate` set is exactly the live
 * negatable automated-block set for `(src, uri, cid)`. Returns the authoritative
 * live vals (sorted) when they match; throws when the submitted set omits an
 * active block, includes a non-active/warning/manual-headed val, or is otherwise
 * not identical — so a reviewer can never override against a stale view.
 */
export async function assertNegatableBlockSet(
	db: D1Database,
	src: string,
	subject: { uri: string; cid: string },
	submitted: readonly string[],
): Promise<string[]> {
	const live = (await getNegatableAutomatedLabels(db, { src, uri: subject.uri, cid: subject.cid }))
		.map((label) => label.val)
		.filter((val) => getLabelDefinition(val)?.category === "automated-block");
	const liveSet = new Set(live);
	const submittedSet = new Set(submitted);
	const identical =
		liveSet.size === submittedSet.size && [...liveSet].every((val) => submittedSet.has(val));
	if (!identical || submitted.length !== submittedSet.size)
		throw new NegatableBlockSetError("submitted block set does not match live automated blocks");
	return live.toSorted();
}

/**
 * The submitted override negation set is not exactly the live automated-block
 * set. Message is static — it never echoes the submitted vals. Callers map this
 * to a 400 `INVALID_BODY`.
 */
export class NegatableBlockSetError extends Error {
	override readonly name = "NegatableBlockSetError";
}

export async function issueAutomatedAssessmentLabel(
	db: D1Database,
	config: LabelerConfig,
	signer: LabelSigner,
	action: AutomatedIssuanceAction,
	proposal: AutomatedLabelProposal,
	now = new Date(),
	publisher?: LabelPublisher,
): Promise<IssuedLabel> {
	if (signer.issuerDid !== config.labelerDid)
		throw new TypeError("signer issuer does not match the configured labeler DID");
	validateKeyVersion(config.signingKeyVersion);
	validateAutomatedAction(action);
	validateAutomatedProposal(proposal);
	return issueLabel(db, config, signer, action, proposal, now, publisher);
}

async function markPublicationAccepted(db: D1Database, issued: IssuedLabel): Promise<void> {
	await db
		.prepare(
			`UPDATE issued_labels SET publication_pending = 0
			 WHERE sequence = ? AND signing_key_version = ? AND publication_pending = 1`,
		)
		.bind(issued.sequence, issued.signingKeyVersion)
		.run();
}

async function claimPublication(
	db: D1Database,
	stored: StoredLabelRow,
	status: Awaited<ReturnType<typeof getSigningStatusIfInitialized>>,
): Promise<void> {
	if (stored.publication_pending === 1) return;
	const result = await db
		.prepare(
			`UPDATE issued_labels SET publication_pending = 1
			 WHERE sequence = ? AND signing_key_version = ? AND publication_pending = 0
			 AND (
				NOT EXISTS (SELECT 1 FROM signing_state)
				OR EXISTS (
					SELECT 1 FROM signing_state WHERE id = 1 AND phase = 'active'
					AND active_key_version = ?
				)
			 )`,
		)
		.bind(stored.sequence, stored.signing_key_version, stored.signing_key_version)
		.run();
	if (result.meta.changes === 1) return;
	await recordSigningAlert(db, "PUBLICATION_BARRIER_CLOSED", {
		activeKeyVersion: status?.activeKeyVersion,
		targetKeyVersion: stored.signing_key_version,
		rotationId: status?.rotationId,
	});
	throw new Error("label publication is paused for signing-key rotation");
}

/**
 * §10: automation must never retract an action-backed manual label. If the
 * currently-active label for this `(src, uri, val)` stream was issued by a
 * manual action (reviewer/admin), an automated negation is refused here —
 * defense in depth independent of whatever candidate set an orchestrator
 * computes. "Currently active" is the highest-sequence event in the stream;
 * a negation only reaches this guard when that event is a live positive.
 */
async function assertAutomatedNegationAllowed(
	db: D1Database,
	src: string,
	proposal: AutomatedLabelProposal,
): Promise<void> {
	const latest = await db
		.prepare(
			`SELECT a.type, l.neg
			 FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.src = ? AND l.uri = ? AND l.val = ?
			 ORDER BY l.sequence DESC
			 LIMIT 1`,
		)
		.bind(src, proposal.uri, proposal.val)
		.first<{ type: string; neg: number }>();
	if (latest && latest.neg === 0 && latest.type !== "automated-assessment") {
		throw new TypeError(
			`automation cannot negate the manually-issued label ${proposal.val} on ${proposal.uri}`,
		);
	}
}

/**
 * Reads a persisted issuance as an `IssuedLabel` by its issuance-action
 * idempotency key. Unlike `IssuanceStatements.postCommit`, a missing row
 * returns `null` rather than re-diagnosing signing state and throwing — the
 * console's post-commit publisher keys on its own `actionId`, so the race
 * loser (whose batch rolled back) legitimately finds nothing and skips.
 */
export async function readIssuedLabelByActionKey(
	db: D1Database,
	idempotencyKey: string,
): Promise<IssuedLabel | null> {
	const row = await getIssuedLabel(db, idempotencyKey);
	return row ? rowToIssuedLabel(row) : null;
}

function rowToIssuedLabel(stored: StoredLabelRow): IssuedLabel {
	const action: IssuanceAction =
		stored.type === "automated-assessment"
			? {
					actor: stored.actor,
					type: "automated-assessment",
					assessmentId: stored.assessment_id ?? "",
					reason: stored.reason,
					idempotencyKey: stored.idempotency_key,
				}
			: {
					actor: stored.actor,
					type: "manual-label",
					reason: stored.reason,
					idempotencyKey: stored.idempotency_key,
				};
	return {
		action,
		label: {
			ver: 1,
			src: stored.src,
			uri: stored.uri,
			...(stored.cid === null ? {} : { cid: stored.cid }),
			val: stored.val,
			...(stored.neg === 1 ? { neg: true } : {}),
			cts: stored.cts,
			...(stored.exp === null ? {} : { exp: stored.exp }),
			sig: new Uint8Array(stored.sig),
		},
		sequence: stored.sequence,
		signingKeyId: stored.signing_key_id,
		signingKeyVersion: stored.signing_key_version,
	};
}

async function getIssuedLabel(
	db: D1Database,
	idempotencyKey: string,
): Promise<StoredLabelRow | null> {
	return db
		.prepare(
			`SELECT a.actor, a.type, a.reason, a.idempotency_key, a.assessment_id, l.sequence, l.ver,
			 l.src, l.uri, l.cid, l.val, l.neg, l.cts, l.exp, l.sig, l.signing_key_id,
			 l.signing_key_version, l.publication_pending
			 FROM issuance_actions a
			 JOIN issued_labels l ON l.action_id = a.id
			 WHERE a.idempotency_key = ?`,
		)
		.bind(idempotencyKey)
		.first<StoredLabelRow>();
}

function assertMatches(
	stored: StoredLabelRow,
	signer: LabelSigner,
	action: IssuanceAction,
	proposal: IssuanceProposal,
): IssuedLabel {
	if (
		stored.actor !== action.actor ||
		stored.type !== action.type ||
		stored.reason !== action.reason ||
		stored.assessment_id !==
			(action.type === "automated-assessment" ? action.assessmentId : null) ||
		stored.src !== signer.issuerDid ||
		stored.uri !== proposal.uri ||
		stored.cid !== (proposal.cid ?? null) ||
		stored.val !== proposal.val ||
		(stored.neg === 1) !== (proposal.neg === true) ||
		stored.exp !== (proposal.exp ?? null)
	) {
		throw new TypeError("idempotency key is already bound to a different issuance");
	}
	return rowToIssuedLabel(stored);
}

function validateAction(action: AuthorizedIssuanceAction): void {
	if (!DID.test(action.actor)) throw new TypeError("action.actor must be a DID");
	if (action.type !== "manual-label") throw new TypeError("action.type must be manual-label");
	if (action.reason.trim().length === 0 || action.reason.length > 1_000)
		throw new TypeError("action.reason must be between 1 and 1000 characters");
	if (action.idempotencyKey.length < 1 || action.idempotencyKey.length > 200)
		throw new TypeError("action.idempotencyKey must be between 1 and 200 characters");
}

/** Parses a label subject URI into its policy `SubjectKind`: a bare DID is a
 * publisher, a `…package.profile` record is a package, a `…package.release`
 * record is a release; anything else is unrecognized. */
export function parseSubjectKind(uri: string): SubjectKind | null {
	if (DID.test(uri)) return "publisher";
	const record = REGISTRY_RECORD.exec(uri);
	if (!record) return null;
	const collection = record[2]!;
	if (collection.endsWith(".profile")) return "package";
	if (collection.endsWith(".release")) return "release";
	return null;
}

function describeSubject(subject: SubjectKind): string {
	switch (subject) {
		case "release":
			return "release record";
		case "package":
			return "package profile record";
		case "publisher":
			return "DID";
	}
}

/**
 * Manual issuance legality driven from the ratified policy fixture, mirroring
 * `validateAutomatedProposal`: a value is manually issuable only where its
 * `subjectRules` grant a `reviewer` or `admin` mode for the subject parsed from
 * the URI, and the matched rule's `cidRule` decides whether a CID is forbidden
 * (URI-wide), required (CID-bound), or optional. Keeping the issuer policy-driven
 * means a fixture grant lights up a value with no code change, and an
 * automated-only value (`assessment-pending`, an ungranted descriptive label)
 * is rejected here. The per-endpoint W9.4 scope gate (override-coupled labels,
 * role) lives in the console mutation dispatcher, not here.
 */
function validateManualProposal(proposal: AllowedLabelProposal): void {
	const definition = getLabelDefinition(proposal.val);
	if (!definition) throw new TypeError(`unknown label value: ${proposal.val}`);
	const manualRules = definition.subjectRules.filter(
		(rule) => rule.issuanceModes.includes("reviewer") || rule.issuanceModes.includes("admin"),
	);
	if (manualRules.length === 0)
		throw new TypeError(`${proposal.val} cannot be issued through the manual path`);
	const subject = parseSubjectKind(proposal.uri);
	const rule =
		subject === null ? undefined : manualRules.find((candidate) => candidate.subject === subject);
	if (!rule) {
		const allowed = manualRules.map((candidate) => describeSubject(candidate.subject)).join(", ");
		throw new TypeError(`${proposal.val} must target a ${allowed}`);
	}
	if (rule.cidRule === "forbidden" && proposal.cid !== undefined)
		throw new TypeError(`${proposal.val} must not include a CID`);
	if (rule.cidRule === "required" && proposal.cid === undefined)
		throw new TypeError(`${proposal.val} must include a CID`);
}

function validateAutomatedAction(action: AutomatedIssuanceAction): void {
	if (!DID.test(action.actor)) throw new TypeError("action.actor must be a DID");
	if (action.type !== "automated-assessment")
		throw new TypeError("action.type must be automated-assessment");
	if (!ASSESSMENT_ID.test(action.assessmentId))
		throw new TypeError("action.assessmentId must be a valid assessment id");
	if (action.reason.trim().length === 0 || action.reason.length > 1_000)
		throw new TypeError("action.reason must be between 1 and 1000 characters");
	if (action.idempotencyKey.length < 1 || action.idempotencyKey.length > 200)
		throw new TypeError("action.idempotencyKey must be between 1 and 200 characters");
}

/**
 * Value legality (which labels the automated path may issue, and their
 * category/finding rules) is driven from the ratified policy fixture's
 * `subjectRules`/`issuanceModes`/`category` so the issuer and the policy
 * document cannot drift. The release-record subject and mandatory CID are
 * asserted directly per §20.2's absolutes ("automated actions target release
 * records only and include CID"), independent of any per-label policy rule.
 * `assessment-overridden` and reviewer manual-pass flows are rejected simply
 * because the fixture never lists "automated" among their issuance modes.
 */
function validateAutomatedProposal(proposal: AutomatedLabelProposal): void {
	const definition = getLabelDefinition(proposal.val);
	if (!definition) throw new TypeError(`unknown label value: ${proposal.val}`);
	const record = REGISTRY_RECORD.exec(proposal.uri);
	if (!record || !record[2]!.endsWith(".release"))
		throw new TypeError("automated labels must target a release record");
	if (proposal.cid === undefined)
		throw new TypeError("automated labels must include a release CID");
	const canAutomateRelease = definition.subjectRules.some(
		(candidate) => candidate.subject === "release" && candidate.issuanceModes.includes("automated"),
	);
	if (!canAutomateRelease)
		throw new TypeError(`${proposal.val} cannot be issued through the automated path`);
	if (proposal.neg === true) return;
	if (definition.category === "automated-block") {
		if (proposal.findingCategory === undefined)
			throw new TypeError(`${proposal.val} requires a finding category`);
		const findingDefinition = getLabelDefinition(proposal.findingCategory);
		if (!findingDefinition || findingDefinition.category !== "automated-block")
			throw new TypeError("finding category must be an allowed security/impersonation category");
		// Mirrors the resolver's amended blocking gate (W8.5): a model/image
		// block finding blocks at `high` or `critical`. The proposal carries no
		// finding source, so the issuer enforces the stricter model/image
		// threshold uniformly rather than admitting a sub-high block.
		if (proposal.severity !== "critical" && proposal.severity !== "high")
			throw new TypeError(`${proposal.val} requires a high or critical finding severity`);
	}
}
