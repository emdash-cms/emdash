import type { LabelSigner, SignedLabel } from "@emdash-cms/registry-moderation";

import type { LabelerConfig } from "./config.js";
import type { FindingSeverity } from "./evidence.js";
import { getLabelDefinition } from "./policy.js";
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
const ASSESSMENT_ID = /^asmt_[0-9A-HJKMNP-TV-Z]{26}$/;

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
	val: ManualLabelValue;
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
	/** Required (and must be "critical") when `val`'s policy category is automated-block. */
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
		throw new Error("label issuance is paused");
	}
	if (signingStatus && signingStatus.activeKeyVersion !== config.signingKeyVersion) {
		await recordSigningAlert(db, "STALE_SIGNING_KEY", {
			activeKeyVersion: signingStatus.activeKeyVersion,
			targetKeyVersion: config.signingKeyVersion,
			rotationId: signingStatus.rotationId,
		});
		throw new Error("label signing key version is stale");
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

	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, assessment_id, created_at)
				 SELECT ?, ?, ?, ?, ?, ?
				 WHERE (? = 1 AND NOT EXISTS (SELECT 1 FROM signing_state))
				 OR (? = 0 AND EXISTS (
					SELECT 1 FROM signing_state
					WHERE id = 1 AND phase = 'active' AND active_key_version = ?
				 ))
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
				const status = await getSigningStatusIfInitialized(db);
				if (!status) throw new Error("label issuance did not persist");
				if (!signingStatus) {
					await recordSigningAlert(db, "SIGNING_STATE_CHANGED", {
						activeKeyVersion: status.activeKeyVersion,
						targetKeyVersion: config.signingKeyVersion,
						rotationId: status.rotationId,
					});
					throw new Error("signing state changed; retry label issuance");
				}
				if (status.phase === "paused") {
					await recordSigningAlert(db, "ISSUANCE_PAUSED", {
						activeKeyVersion: status.activeKeyVersion,
						targetKeyVersion: config.signingKeyVersion,
						rotationId: status.rotationId,
					});
					throw new Error("label issuance is paused");
				}
				await recordSigningAlert(db, "STALE_SIGNING_KEY", {
					activeKeyVersion: status.activeKeyVersion,
					targetKeyVersion: config.signingKeyVersion,
					rotationId: status.rotationId,
				});
				throw new Error("label signing key version is stale");
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
			throw new Error("label signature must be refreshed before replay");
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
	validateProposal(proposal);
	return issueLabel(db, config, signer, action, proposal, now, publisher);
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

function validateAction(action: AuthorizedIssuanceAction): void {
	if (!DID.test(action.actor)) throw new TypeError("action.actor must be a DID");
	if (action.type !== "manual-label") throw new TypeError("action.type must be manual-label");
	if (action.reason.trim().length === 0 || action.reason.length > 1_000)
		throw new TypeError("action.reason must be between 1 and 1000 characters");
	if (action.idempotencyKey.length < 1 || action.idempotencyKey.length > 200)
		throw new TypeError("action.idempotencyKey must be between 1 and 200 characters");
}

function validateProposal(proposal: AllowedLabelProposal): void {
	const record = REGISTRY_RECORD.exec(proposal.uri);
	const isDidSubject = DID.test(proposal.uri);
	switch (proposal.val) {
		case "publisher-compromised":
			if (!isDidSubject || proposal.cid !== undefined)
				throw new TypeError("publisher-compromised must target a DID without a CID");
			return;
		case "!takedown":
			if (!isDidSubject && !record)
				throw new TypeError("!takedown must target a DID, package profile, or release record");
			if (proposal.cid !== undefined) throw new TypeError("!takedown must not include a CID");
			return;
		case "package-disputed":
			if (!record || !record[2]!.endsWith(".profile"))
				throw new TypeError("package-disputed must target a package profile record");
			return;
		case "security-yanked":
			if (!record || !record[2]!.endsWith(".release"))
				throw new TypeError("security-yanked must target a release record");
			if (proposal.cid !== undefined) throw new TypeError("security-yanked must not include a CID");
			return;
	}
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
 * Validation is driven entirely from the ratified policy fixture's
 * `subjectRules`/`issuanceModes`/`category` (per label value) so the issuer
 * and the policy document cannot drift apart. `assessment-overridden` and
 * reviewer manual-pass flows are rejected here simply because the fixture
 * never lists "automated" among their issuance modes — no special case.
 */
function validateAutomatedProposal(proposal: AutomatedLabelProposal): void {
	const definition = getLabelDefinition(proposal.val);
	if (!definition) throw new TypeError(`unknown label value: ${proposal.val}`);
	const record = REGISTRY_RECORD.exec(proposal.uri);
	if (!record || !record[2]!.endsWith(".release"))
		throw new TypeError("automated labels must target a release record");
	const rule = definition.subjectRules.find((candidate) => candidate.subject === "release");
	if (!rule || !rule.issuanceModes.includes("automated"))
		throw new TypeError(`${proposal.val} cannot be issued through the automated path`);
	if (rule.cidRule === "required" && proposal.cid === undefined)
		throw new TypeError(`${proposal.val} requires a CID`);
	if (rule.cidRule === "forbidden" && proposal.cid !== undefined)
		throw new TypeError(`${proposal.val} must not include a CID`);
	if (proposal.neg === true) return;
	if (definition.category === "automated-block") {
		if (proposal.findingCategory === undefined)
			throw new TypeError(`${proposal.val} requires a finding category`);
		const findingDefinition = getLabelDefinition(proposal.findingCategory);
		if (!findingDefinition || findingDefinition.category !== "automated-block")
			throw new TypeError("finding category must be an allowed security/impersonation category");
		if (proposal.severity !== "critical")
			throw new TypeError(`${proposal.val} requires a critical finding severity`);
	}
}
