import { P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { verifyLabel, type LabelSigner, type SignedLabel } from "@emdash-cms/registry-moderation";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const P256_MULTIKEY = /^zDna[1-9A-HJ-NP-Za-km-z]+$/;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;

interface SigningStateRow {
	issuer_did: string;
	phase: "active" | "paused";
	active_key_version: string;
	active_public_multikey: string;
	pending_key_version: string | null;
	pending_public_multikey: string | null;
	rotation_id: string | null;
	paused_at: string | null;
	activated_at: string;
	updated_at: string;
}

interface SigningAlertRow {
	code: string;
	severity: "warning" | "error";
	rotation_id: string | null;
	active_key_version: string | null;
	target_key_version: string | null;
	created_at: string;
}

interface SigningKeyVersionRow {
	key_version: string;
	public_multikey: string;
	status: "pending" | "active" | "retired" | "aborted";
	rotation_id: string | null;
}

export interface VersionedLabelSigner {
	signer: LabelSigner;
	keyVersion: string;
	publicKeyMultibase: string;
}

export interface SigningStatus {
	issuerDid: string;
	phase: "active" | "paused";
	activeKeyVersion: string;
	activePublicKeyMultibase: string;
	pendingKeyVersion?: string;
	pendingPublicKeyMultibase?: string;
	rotationId?: string;
	pausedAt?: string;
	activatedAt: string;
	updatedAt: string;
}

export interface SigningAlert {
	code: string;
	severity: "warning" | "error";
	rotationId?: string;
	activeKeyVersion?: string;
	targetKeyVersion?: string;
	createdAt: string;
}

export async function verifyLabelForSigningStatus(
	status: SigningStatus,
	input: { signer: LabelSigner; keyVersion: string },
	label: SignedLabel,
): Promise<void> {
	if (
		status.phase !== "active" ||
		input.signer.issuerDid !== status.issuerDid ||
		input.keyVersion !== status.activeKeyVersion ||
		label.src !== status.issuerDid
	) {
		throw new TypeError("signer does not match the active signing state");
	}
	await verifyLabel({
		label,
		resolveDid: async () => ({
			id: status.issuerDid,
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: status.issuerDid,
					publicKeyMultibase: status.activePublicKeyMultibase,
				},
			],
		}),
	});
}

export async function initializeSigningState(
	db: D1Database,
	input: { issuerDid: string; keyVersion: string; publicKeyMultibase: string; now?: Date },
): Promise<SigningStatus> {
	if (!DID.test(input.issuerDid)) throw new TypeError("issuerDid must be a DID");
	validateKeyVersion(input.keyVersion);
	await validateMultikey(input.publicKeyMultibase);
	const now = (input.now ?? new Date()).toISOString();
	await db.batch([
		db
			.prepare(
				`INSERT INTO signing_state
			 (id, issuer_did, phase, active_key_version, active_public_multikey, activated_at, updated_at)
			 VALUES (1, ?, 'active', ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
			)
			.bind(input.issuerDid, input.keyVersion, input.publicKeyMultibase, now, now),
		db
			.prepare(
				`INSERT INTO signing_key_versions
				 (key_version, public_multikey, status, created_at, activated_at)
				 VALUES (?, ?, 'active', ?, ?)
				 ON CONFLICT(key_version) DO NOTHING`,
			)
			.bind(input.keyVersion, input.publicKeyMultibase, now, now),
	]);
	const status = await getSigningStatus(db);
	const key = await getSigningKeyVersion(db, input.keyVersion);
	if (
		status.issuerDid !== input.issuerDid ||
		status.activeKeyVersion !== input.keyVersion ||
		status.activePublicKeyMultibase !== input.publicKeyMultibase ||
		key?.public_multikey !== input.publicKeyMultibase ||
		key?.status !== "active"
	) {
		throw new TypeError("signing state is already initialized with another key");
	}
	return status;
}

export async function beginRoutineKeyRotation(
	db: D1Database,
	input: {
		rotationId: string;
		expectedActiveKeyVersion: string;
		nextKeyVersion: string;
		nextPublicKeyMultibase: string;
		now?: Date;
	},
): Promise<SigningStatus> {
	validateIdentifier(input.rotationId, "rotationId");
	validateKeyVersion(input.expectedActiveKeyVersion);
	validateKeyVersion(input.nextKeyVersion);
	await validateMultikey(input.nextPublicKeyMultibase);
	if (input.nextKeyVersion === input.expectedActiveKeyVersion)
		throw new TypeError("nextKeyVersion must differ from the active key version");
	const before = await getSigningStatus(db);
	if (
		before.phase === "paused" &&
		before.rotationId === input.rotationId &&
		before.pendingKeyVersion === input.nextKeyVersion &&
		before.pendingPublicKeyMultibase === input.nextPublicKeyMultibase
	)
		return before;
	if (before.phase !== "active" || before.activeKeyVersion !== input.expectedActiveKeyVersion)
		throw new TypeError("signing rotation could not acquire the active key");
	const now = (input.now ?? new Date()).toISOString();
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO signing_key_versions
				 (key_version, public_multikey, status, rotation_id, created_at)
				 SELECT ?, ?, 'pending', ?, ? FROM signing_state
				 WHERE id = 1 AND phase = 'active' AND active_key_version = ?
				 AND NOT EXISTS (
					SELECT 1 FROM signing_key_versions WHERE key_version = ? OR rotation_id = ?
				 )`,
			)
			.bind(
				input.nextKeyVersion,
				input.nextPublicKeyMultibase,
				input.rotationId,
				now,
				input.expectedActiveKeyVersion,
				input.nextKeyVersion,
				input.rotationId,
			),
		db
			.prepare(
				`UPDATE signing_state
				 SET phase = 'paused', pending_key_version = ?, pending_public_multikey = ?,
				     rotation_id = ?, paused_at = ?, updated_at = ?
				 WHERE id = 1 AND phase = 'active' AND active_key_version = ?
				 AND EXISTS (
					SELECT 1 FROM signing_key_versions
					WHERE key_version = ? AND public_multikey = ?
					AND status = 'pending' AND rotation_id = ?
				 )`,
			)
			.bind(
				input.nextKeyVersion,
				input.nextPublicKeyMultibase,
				input.rotationId,
				now,
				now,
				input.expectedActiveKeyVersion,
				input.nextKeyVersion,
				input.nextPublicKeyMultibase,
				input.rotationId,
			),
		db
			.prepare(
				`INSERT INTO signing_events
				 (event_type, code, severity, rotation_id, active_key_version, target_key_version, created_at)
				 SELECT 'transition', 'ROTATION_PAUSED', 'info', rotation_id, active_key_version,
				        pending_key_version, ?
				 FROM signing_state
				 WHERE id = 1 AND phase = 'paused' AND rotation_id = ?
				 AND NOT EXISTS (
					SELECT 1 FROM signing_events
					WHERE event_type = 'transition' AND code = 'ROTATION_PAUSED' AND rotation_id = ?
				 )`,
			)
			.bind(now, input.rotationId, input.rotationId),
	]);
	if (results[1]?.meta.changes === 1) {
		return {
			issuerDid: before.issuerDid,
			phase: "paused",
			activeKeyVersion: before.activeKeyVersion,
			activePublicKeyMultibase: before.activePublicKeyMultibase,
			pendingKeyVersion: input.nextKeyVersion,
			pendingPublicKeyMultibase: input.nextPublicKeyMultibase,
			rotationId: input.rotationId,
			pausedAt: now,
			activatedAt: before.activatedAt,
			updatedAt: now,
		};
	}
	const status = await getSigningStatus(db);
	if (
		status.phase !== "paused" ||
		status.rotationId !== input.rotationId ||
		status.pendingKeyVersion !== input.nextKeyVersion ||
		status.pendingPublicKeyMultibase !== input.nextPublicKeyMultibase
	) {
		throw new TypeError("signing rotation could not acquire the active key");
	}
	return status;
}

export async function activateRoutineKeyRotation(
	db: D1Database,
	input: VersionedLabelSigner & { rotationId: string; now?: Date },
): Promise<SigningStatus> {
	validateIdentifier(input.rotationId, "rotationId");
	validateKeyVersion(input.keyVersion);
	await validateMultikey(input.publicKeyMultibase);
	const before = await getSigningStatus(db);
	const [activeKey, pendingKey] = await Promise.all([
		getSigningKeyVersion(db, before.activeKeyVersion),
		getSigningKeyVersion(db, input.keyVersion),
	]);
	if (
		input.signer.issuerDid !== before.issuerDid ||
		before.phase !== "paused" ||
		before.rotationId !== input.rotationId ||
		before.pendingKeyVersion !== input.keyVersion ||
		before.pendingPublicKeyMultibase !== input.publicKeyMultibase ||
		activeKey?.status !== "active" ||
		activeKey.public_multikey !== before.activePublicKeyMultibase ||
		pendingKey?.status !== "pending" ||
		pendingKey.public_multikey !== input.publicKeyMultibase ||
		pendingKey.rotation_id !== input.rotationId
	) {
		await recordSigningAlert(db, "ROTATION_ACTIVATION_MISMATCH", {
			activeKeyVersion: before.activeKeyVersion,
			targetKeyVersion: input.keyVersion,
			rotationId: input.rotationId,
		});
		throw new TypeError("rotation activation does not match the pending key");
	}
	const now = (input.now ?? new Date()).toISOString();
	try {
		const proof = await input.signer.sign({
			ver: 1,
			uri: "did:example:rotation-check",
			val: "rotation-check",
			cts: now,
		});
		await verifyLabel({
			label: proof,
			resolveDid: async () => ({
				id: before.issuerDid,
				verificationMethod: [
					{
						id: "#atproto_label",
						type: "Multikey",
						controller: before.issuerDid,
						publicKeyMultibase: input.publicKeyMultibase,
					},
				],
			}),
		});
	} catch {
		await recordSigningAlert(db, "ROTATION_SIGNER_MISMATCH", {
			activeKeyVersion: before.activeKeyVersion,
			targetKeyVersion: input.keyVersion,
			rotationId: input.rotationId,
			severity: "error",
		});
		throw new TypeError("rotation signer does not match the pending public key");
	}
	const results = await db.batch([
		db
			.prepare(
				`UPDATE signing_key_versions SET status = 'retired'
				 WHERE key_version = ? AND status = 'active'
				 AND EXISTS (
					SELECT 1 FROM signing_state
					WHERE id = 1 AND phase = 'paused' AND rotation_id = ?
					AND pending_key_version = ? AND pending_public_multikey = ?
				 )
				 AND NOT EXISTS (
					SELECT 1 FROM issued_labels
					WHERE publication_pending = 1 AND signing_key_version = ?
				 )`,
			)
			.bind(
				before.activeKeyVersion,
				input.rotationId,
				input.keyVersion,
				input.publicKeyMultibase,
				before.activeKeyVersion,
			),
		db
			.prepare(
				`UPDATE signing_key_versions SET status = 'active', activated_at = ?
				 WHERE key_version = ? AND public_multikey = ?
				 AND status = 'pending' AND rotation_id = ?
				 AND EXISTS (
					SELECT 1 FROM signing_state
					WHERE id = 1 AND phase = 'paused' AND rotation_id = ?
					AND pending_key_version = ? AND pending_public_multikey = ?
				 )
				 AND NOT EXISTS (
					SELECT 1 FROM issued_labels
					WHERE publication_pending = 1 AND signing_key_version = ?
				 )`,
			)
			.bind(
				now,
				input.keyVersion,
				input.publicKeyMultibase,
				input.rotationId,
				input.rotationId,
				input.keyVersion,
				input.publicKeyMultibase,
				before.activeKeyVersion,
			),
		db
			.prepare(
				`UPDATE signing_state
				 SET phase = 'active', active_key_version = pending_key_version,
				     active_public_multikey = pending_public_multikey,
				     pending_key_version = NULL, pending_public_multikey = NULL,
				     activated_at = ?, updated_at = ?
				 WHERE id = 1 AND phase = 'paused' AND rotation_id = ?
				 AND pending_key_version = ? AND pending_public_multikey = ?
				 AND EXISTS (
					SELECT 1 FROM signing_key_versions
					WHERE key_version = ? AND public_multikey = ? AND status = 'active'
				 )
				 AND NOT EXISTS (
					SELECT 1 FROM issued_labels
					WHERE publication_pending = 1 AND signing_key_version = ?
				 )`,
			)
			.bind(
				now,
				now,
				input.rotationId,
				input.keyVersion,
				input.publicKeyMultibase,
				input.keyVersion,
				input.publicKeyMultibase,
				before.activeKeyVersion,
			),
		db
			.prepare(
				`INSERT INTO signing_events
				 (event_type, code, severity, rotation_id, active_key_version, target_key_version, created_at)
				 SELECT 'transition', 'ROTATION_ACTIVATED', 'info', rotation_id,
				        active_key_version, active_key_version, ?
				 FROM signing_state
				 WHERE id = 1 AND phase = 'active' AND rotation_id = ? AND active_key_version = ?
				 AND NOT EXISTS (
					SELECT 1 FROM signing_events
					WHERE event_type = 'transition' AND code = 'ROTATION_ACTIVATED' AND rotation_id = ?
				 )`,
			)
			.bind(now, input.rotationId, input.keyVersion, input.rotationId),
	]);
	if (results[2]?.meta.changes === 1) {
		return {
			issuerDid: before.issuerDid,
			phase: "active",
			activeKeyVersion: input.keyVersion,
			activePublicKeyMultibase: input.publicKeyMultibase,
			rotationId: input.rotationId,
			...(before.pausedAt === undefined ? {} : { pausedAt: before.pausedAt }),
			activatedAt: now,
			updatedAt: now,
		};
	}
	const status = await getSigningStatus(db);
	if (status.phase !== "active" || status.activeKeyVersion !== input.keyVersion) {
		await recordSigningAlert(db, "ROTATION_ACTIVATION_RACE", {
			activeKeyVersion: status.activeKeyVersion,
			targetKeyVersion: input.keyVersion,
			rotationId: input.rotationId,
		});
		throw new TypeError("signing rotation activation lost its compare-and-swap");
	}
	return status;
}

export async function abortRoutineKeyRotation(
	db: D1Database,
	input: { rotationId: string; expectedPendingKeyVersion: string; now?: Date },
): Promise<SigningStatus> {
	validateIdentifier(input.rotationId, "rotationId");
	validateKeyVersion(input.expectedPendingKeyVersion);
	const before = await getSigningStatus(db);
	if (
		before.phase !== "paused" ||
		before.rotationId !== input.rotationId ||
		before.pendingKeyVersion !== input.expectedPendingKeyVersion
	) {
		throw new TypeError("rotation abort does not match the pending key");
	}
	const now = (input.now ?? new Date()).toISOString();
	const results = await db.batch([
		db
			.prepare(
				`UPDATE signing_state
				 SET phase = 'active', pending_key_version = NULL, pending_public_multikey = NULL,
				     updated_at = ?
				 WHERE id = 1 AND phase = 'paused' AND rotation_id = ?
				 AND pending_key_version = ?`,
			)
			.bind(now, input.rotationId, input.expectedPendingKeyVersion),
		db
			.prepare(
				`UPDATE signing_key_versions SET status = 'aborted'
				 WHERE key_version = ? AND status = 'pending' AND rotation_id = ?`,
			)
			.bind(input.expectedPendingKeyVersion, input.rotationId),
		db
			.prepare(
				`INSERT INTO signing_events
				 (event_type, code, severity, rotation_id, active_key_version, target_key_version, created_at)
				 SELECT 'transition', 'ROTATION_ABORTED', 'warning', rotation_id,
				        active_key_version, ?, ?
				 FROM signing_state
				 WHERE id = 1 AND phase = 'active' AND rotation_id = ?
				 AND active_key_version = ?
				 AND EXISTS (
					SELECT 1 FROM signing_key_versions
					WHERE key_version = ? AND status = 'aborted' AND rotation_id = ?
				 )
				 AND NOT EXISTS (
					SELECT 1 FROM signing_events
					WHERE event_type = 'transition' AND code = 'ROTATION_ABORTED' AND rotation_id = ?
				 )`,
			)
			.bind(
				input.expectedPendingKeyVersion,
				now,
				input.rotationId,
				before.activeKeyVersion,
				input.expectedPendingKeyVersion,
				input.rotationId,
				input.rotationId,
			),
	]);
	if (results[0]?.meta.changes === 1) {
		return {
			issuerDid: before.issuerDid,
			phase: "active",
			activeKeyVersion: before.activeKeyVersion,
			activePublicKeyMultibase: before.activePublicKeyMultibase,
			rotationId: input.rotationId,
			...(before.pausedAt === undefined ? {} : { pausedAt: before.pausedAt }),
			activatedAt: before.activatedAt,
			updatedAt: now,
		};
	}
	const status = await getSigningStatus(db);
	if (status.phase !== "active" || status.activeKeyVersion !== before.activeKeyVersion)
		throw new TypeError("signing rotation abort lost its compare-and-swap");
	return status;
}

export async function getSigningStatus(db: D1Database): Promise<SigningStatus> {
	const status = await getSigningStatusIfInitialized(db);
	if (!status) throw new Error("signing state is not initialized");
	return status;
}

export async function getSigningStatusIfInitialized(db: D1Database): Promise<SigningStatus | null> {
	const row = await db
		.prepare(
			`SELECT issuer_did, phase, active_key_version, active_public_multikey, pending_key_version,
			 pending_public_multikey, rotation_id, paused_at, activated_at, updated_at
			 FROM signing_state WHERE id = 1`,
		)
		.first<SigningStateRow>();
	if (!row) return null;
	return {
		issuerDid: row.issuer_did,
		phase: row.phase,
		activeKeyVersion: row.active_key_version,
		activePublicKeyMultibase: row.active_public_multikey,
		...(row.pending_key_version === null ? {} : { pendingKeyVersion: row.pending_key_version }),
		...(row.pending_public_multikey === null
			? {}
			: { pendingPublicKeyMultibase: row.pending_public_multikey }),
		...(row.rotation_id === null ? {} : { rotationId: row.rotation_id }),
		...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
		activatedAt: row.activated_at,
		updatedAt: row.updated_at,
	};
}

export async function recordSigningAlert(
	db: D1Database,
	code: string,
	input: {
		activeKeyVersion?: string;
		targetKeyVersion?: string;
		rotationId?: string;
		severity?: "warning" | "error";
		now?: Date;
	} = {},
): Promise<void> {
	validateIdentifier(code, "alert code");
	const dedupeKey = [
		code,
		input.rotationId ?? "",
		input.activeKeyVersion ?? "",
		input.targetKeyVersion ?? "",
	].join("\u0000");
	await db
		.prepare(
			`INSERT INTO signing_events
			 (event_type, code, severity, rotation_id, active_key_version, target_key_version,
			  dedupe_key, created_at)
			 VALUES ('alert', ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(dedupe_key) DO NOTHING`,
		)
		.bind(
			code,
			input.severity ?? "warning",
			input.rotationId ?? null,
			input.activeKeyVersion ?? null,
			input.targetKeyVersion ?? null,
			dedupeKey,
			(input.now ?? new Date()).toISOString(),
		)
		.run();
}

export async function listSigningAlerts(db: D1Database, limit = 50): Promise<SigningAlert[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new TypeError("alert limit must be between 1 and 100");
	const rows = await db
		.prepare(
			`SELECT code, severity, rotation_id, active_key_version, target_key_version, created_at
			 FROM signing_events WHERE event_type = 'alert' ORDER BY id DESC LIMIT ?`,
		)
		.bind(limit)
		.all<SigningAlertRow>();
	return (rows.results ?? []).map((row) => ({
		code: row.code,
		severity: row.severity,
		...(row.rotation_id === null ? {} : { rotationId: row.rotation_id }),
		...(row.active_key_version === null ? {} : { activeKeyVersion: row.active_key_version }),
		...(row.target_key_version === null ? {} : { targetKeyVersion: row.target_key_version }),
		createdAt: row.created_at,
	}));
}

export function validateKeyVersion(value: string): void {
	validateIdentifier(value, "signing key version");
	if (value === "legacy") throw new TypeError("legacy is reserved for pre-bootstrap signatures");
}

function validateIdentifier(value: string, field: string): void {
	if (!IDENTIFIER.test(value)) throw new TypeError(`${field} is invalid`);
}

async function validateMultikey(value: string): Promise<void> {
	if (!P256_MULTIKEY.test(value))
		throw new TypeError("publicKeyMultibase must be a P-256 Multikey");
	try {
		const parsed = parsePublicMultikey(value);
		if (
			parsed.type !== "p256" ||
			parsed.publicKeyBytes.length !== 33 ||
			![2, 3].includes(parsed.publicKeyBytes[0]!)
		) {
			throw new TypeError();
		}
		const key = await P256PublicKey.importRaw(parsed.publicKeyBytes);
		if ((await key.exportPublicKey("multikey")) !== value) throw new TypeError();
	} catch {
		throw new TypeError("publicKeyMultibase must be a canonical P-256 Multikey");
	}
}

async function getSigningKeyVersion(
	db: D1Database,
	keyVersion: string,
): Promise<SigningKeyVersionRow | null> {
	return db
		.prepare(
			`SELECT key_version, public_multikey, status, rotation_id
			 FROM signing_key_versions WHERE key_version = ?`,
		)
		.bind(keyVersion)
		.first<SigningKeyVersionRow>();
}
