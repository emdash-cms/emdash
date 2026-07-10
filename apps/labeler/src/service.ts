import type { LabelSigner, SignedLabel } from "@emdash-cms/registry-moderation";

import type { LabelerConfig } from "./config.js";
import type { LabelPublisher } from "./subscribe-labels.js";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;
const REGISTRY_RECORD =
	/^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*)\/(com\.emdashcms\.experimental\.package\.(?:profile|release))\/([A-Za-z0-9._~:%-]+)$/;

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

export interface AllowedLabelProposal {
	uri: string;
	val: ManualLabelValue;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

export interface IssuedLabel {
	action: AuthorizedIssuanceAction;
	label: SignedLabel;
	sequence: number;
	signingKeyId: string;
}

interface StoredLabelRow {
	actor: string;
	type: string;
	reason: string;
	idempotency_key: string;
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
	validateAction(action);
	validateProposal(proposal);

	const existing = await getIssuedLabel(db, action.idempotencyKey);
	if (existing) {
		const result = assertMatches(existing, signer, action, proposal);
		await publisher?.publish(result);
		return result;
	}

	const label = await signer.sign({
		ver: 1,
		uri: proposal.uri,
		...(proposal.cid === undefined ? {} : { cid: proposal.cid }),
		val: proposal.val,
		...(proposal.neg === true ? { neg: true } : {}),
		cts: now.toISOString(),
		...(proposal.exp === undefined ? {} : { exp: proposal.exp }),
	});
	const signingKeyId = `${signer.issuerDid}#atproto_label`;

	await db.batch([
		db
			.prepare(
				`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(action.actor, action.type, action.reason, action.idempotencyKey, now.toISOString()),
		db
			.prepare(
				`INSERT INTO issued_labels
				 (action_id, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id)
				 SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 FROM issuance_actions
				 WHERE idempotency_key = ?
				 AND NOT EXISTS (SELECT 1 FROM issued_labels WHERE action_id = issuance_actions.id)`,
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
				action.idempotencyKey,
			),
	]);

	const issued = await getIssuedLabel(db, action.idempotencyKey);
	if (!issued) throw new Error("label issuance did not persist");
	const result = assertMatches(issued, signer, action, proposal);
	// The D1 batch commits before this notification; replay covers subscribers
	// which connect before the singleton processes the post-commit broadcast.
	await publisher?.publish(result);
	return result;
}

async function getIssuedLabel(
	db: D1Database,
	idempotencyKey: string,
): Promise<StoredLabelRow | null> {
	return db
		.prepare(
			`SELECT a.actor, a.type, a.reason, a.idempotency_key, l.sequence, l.ver, l.src, l.uri,
			 l.cid, l.val, l.neg, l.cts, l.exp, l.sig, l.signing_key_id
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
	action: AuthorizedIssuanceAction,
	proposal: AllowedLabelProposal,
): IssuedLabel {
	if (
		stored.actor !== action.actor ||
		stored.type !== action.type ||
		stored.reason !== action.reason ||
		stored.src !== signer.issuerDid ||
		stored.signing_key_id !== `${signer.issuerDid}#atproto_label` ||
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
