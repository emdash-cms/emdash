import type { SignedLabel } from "@emdash-cms/registry-moderation";

import {
	getSigningStatusIfInitialized,
	recordSigningAlert,
	type VersionedLabelSigner,
	verifyLabelForSigningStatus,
} from "./signing-rotation.js";
import { xrpcError } from "./xrpc.js";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const DIGITS = /^\d+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export interface LabelRow {
	id: number;
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
}

export async function queryLabels(
	db: D1Database,
	request: Request,
	signing?: VersionedLabelSigner | (() => Promise<VersionedLabelSigner>),
): Promise<Response> {
	if (request.method !== "GET") {
		return xrpcError("MethodNotSupported", "queryLabels only supports GET", 405, { allow: "GET" });
	}
	const params = new URL(request.url).searchParams;
	const uriPatterns = params.getAll("uriPatterns");
	if (uriPatterns.length === 0) return badRequest("uriPatterns is required");
	const patterns = uriPatterns.map(parseUriPattern);
	if (patterns.some((pattern) => pattern === null)) return badRequest("invalid uriPatterns");
	const sources = params.getAll("sources");
	if (sources.some((source) => !DID.test(source))) return badRequest("sources must contain DIDs");
	const limit = parseLimit(params.get("limit"));
	if (limit === null) return badRequest("limit must be an integer between 1 and 250");
	const cursor = parseCursor(params.get("cursor"));
	if (cursor === null) return badRequest("cursor must be a positive integer");

	const patternClauses: string[] = [];
	const values: (string | number)[] = [];
	for (const pattern of patterns) {
		if (!pattern) continue;
		if (pattern.endsWith("*")) {
			patternClauses.push("substr(uri, 1, ?) = ?");
			const prefix = pattern.slice(0, -1);
			values.push(prefix.length, prefix);
		} else {
			patternClauses.push("uri = ?");
			values.push(pattern);
		}
	}
	const sourceClause =
		sources.length > 0 ? ` AND src IN (${sources.map(() => "?").join(", ")})` : "";
	values.push(...sources, cursor ?? 0, limit + 1);
	const rows = await db
		.prepare(
			`SELECT id, sequence, ver, src, uri, cid, val, neg, cts, exp, sig,
			 signing_key_id, signing_key_version
			 FROM issued_labels
			 WHERE (${patternClauses.join(" OR ")})${sourceClause} AND sequence > ?
			 ORDER BY sequence ASC LIMIT ?`,
		)
		.bind(...values)
		.all<LabelRow>();
	const labels = rows.results ?? [];
	let page = labels.slice(0, limit);
	try {
		page = await resignStaleLabels(db, page, signing);
	} catch {
		return xrpcError("InternalServerError", "label signing is temporarily unavailable", 503);
	}
	const last = page.at(-1);
	return Response.json({
		labels: page.map((label) => ({
			ver: label.ver,
			src: label.src,
			uri: label.uri,
			...(label.cid === null ? {} : { cid: label.cid }),
			val: label.val,
			...(label.neg === 1 ? { neg: true } : {}),
			cts: label.cts,
			...(label.exp === null ? {} : { exp: label.exp }),
			sig: { $bytes: toBase64(new Uint8Array(label.sig)) },
		})),
		...(labels.length > limit && last ? { cursor: `${last.sequence}` } : {}),
	});
}

/**
 * Lazily brings a page of retained label rows onto the active signing key: any
 * row whose `signing_key_version` differs from the active key is re-signed with
 * the current key and persisted (its prior signature archived in
 * `label_signature_history`), mutating the passed rows in place. `sequence`,
 * `cts`, and every label field except the signature are untouched, so ordering
 * and identity are preserved. Shared by the public `queryLabels` reader and the
 * WebSocket subscription replay so both serve verifiable frames after a routine
 * key rotation. Throws when the current signing key is unavailable (paused mid
 * rotation, or a configuration/state mismatch) — the caller must not serve the
 * still-stale rows.
 */
export async function resignStaleLabels(
	db: D1Database,
	labels: LabelRow[],
	signingInput?: VersionedLabelSigner | (() => Promise<VersionedLabelSigner>),
): Promise<LabelRow[]> {
	if (labels.length === 0) return labels;
	const status = await getSigningStatusIfInitialized(db);
	if (!status) return labels;
	const stale = labels.filter((label) => label.signing_key_version !== status.activeKeyVersion);
	if (stale.length === 0) return labels;
	const signing =
		status.phase !== "active"
			? undefined
			: typeof signingInput === "function"
				? await signingInput()
				: signingInput;
	if (
		status.phase !== "active" ||
		!signing ||
		signing.signer.issuerDid !== status.issuerDid ||
		signing.keyVersion !== status.activeKeyVersion ||
		signing.publicKeyMultibase !== status.activePublicKeyMultibase
	) {
		await recordSigningAlert(db, "RESIGN_CONFIGURATION_MISMATCH", {
			activeKeyVersion: status.activeKeyVersion,
			targetKeyVersion: signing?.keyVersion,
			rotationId: status.rotationId,
			severity: "error",
		});
		throw new Error("current signing key is unavailable");
	}

	for (const row of stale) {
		let signed: SignedLabel;
		try {
			const expected = unsignedLabel(row);
			const returned = await signing.signer.sign(expected);
			signed = { ...expected, src: row.src, sig: returned.sig };
			await verifyLabelForSigningStatus(status, signing, signed);
		} catch {
			await recordSigningAlert(db, "RESIGN_SIGN_FAILED", {
				activeKeyVersion: status.activeKeyVersion,
				targetKeyVersion: signing.keyVersion,
				rotationId: status.rotationId,
				severity: "error",
			});
			throw new Error("historical label re-signing failed");
		}
		const results = await db.batch([
			db
				.prepare(
					`INSERT INTO label_signature_history
					 (label_id, label_sequence, sig, signing_key_id, signing_key_version, replaced_at)
					 SELECT id, sequence, sig, signing_key_id, signing_key_version, ?
					 FROM issued_labels WHERE id = ? AND signing_key_version = ?
					 ON CONFLICT(label_id, signing_key_version) DO NOTHING`,
				)
				.bind(new Date().toISOString(), row.id, row.signing_key_version),
			db
				.prepare(
					`UPDATE issued_labels SET sig = ?, signing_key_id = ?, signing_key_version = ?
					 WHERE id = ? AND signing_key_version = ?
					 AND EXISTS (
						SELECT 1 FROM signing_state WHERE id = 1 AND phase = 'active'
						AND active_key_version = ? AND active_public_multikey = ?
					 )`,
				)
				.bind(
					signed.sig,
					`${signed.src}#atproto_label`,
					signing.keyVersion,
					row.id,
					row.signing_key_version,
					signing.keyVersion,
					signing.publicKeyMultibase,
				),
		]);
		if (results[1]?.meta.changes !== 1) {
			const current = await getLabelRow(db, row.id);
			if (current?.signing_key_version === signing.keyVersion) {
				Object.assign(row, current);
				continue;
			}
			await recordSigningAlert(db, "RESIGN_STATE_CHANGED", {
				activeKeyVersion: status.activeKeyVersion,
				targetKeyVersion: signing.keyVersion,
				rotationId: status.rotationId,
				severity: "error",
			});
			throw new Error("signing state changed while re-signing labels");
		}
		row.sig = Uint8Array.from(signed.sig).buffer;
		row.signing_key_id = `${signed.src}#atproto_label`;
		row.signing_key_version = signing.keyVersion;
	}
	const after = await getSigningStatusIfInitialized(db);
	if (
		!after ||
		after.phase !== "active" ||
		after.issuerDid !== signing.signer.issuerDid ||
		after.activeKeyVersion !== signing.keyVersion ||
		after.activePublicKeyMultibase !== signing.publicKeyMultibase
	)
		throw new Error("signing state changed while re-signing labels");
	return labels;
}

async function getLabelRow(db: D1Database, id: number): Promise<LabelRow | null> {
	return db
		.prepare(
			`SELECT id, sequence, ver, src, uri, cid, val, neg, cts, exp, sig,
			 signing_key_id, signing_key_version FROM issued_labels WHERE id = ?`,
		)
		.bind(id)
		.first<LabelRow>();
}

function unsignedLabel(row: LabelRow): Omit<SignedLabel, "src" | "sig"> {
	return {
		ver: 1,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts: row.cts,
		...(row.exp === null ? {} : { exp: row.exp }),
	};
}

function parseUriPattern(value: string): string | null {
	if (value.length === 0 || value.length > 2_000) return null;
	const firstStar = value.indexOf("*");
	if (firstStar !== -1 && firstStar !== value.length - 1) return null;
	return value;
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_LIMIT;
	if (!DIGITS.test(value)) return null;
	const limit = Number(value);
	return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function parseCursor(value: string | null): number | null {
	if (value === null) return 0;
	if (!POSITIVE_INTEGER.test(value)) return null;
	const cursor = Number(value);
	return Number.isSafeInteger(cursor) ? cursor : null;
}

function badRequest(message: string): Response {
	return xrpcError("InvalidRequest", message, 400);
}

function toBase64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}
