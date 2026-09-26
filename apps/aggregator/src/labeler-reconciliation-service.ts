import { NSID } from "@emdash-cms/registry-lexicons";

import { parseSignatureMetadataCid } from "./utils.js";

export interface AuthoritativeRegistrySubject {
	uri: string;
	cid: string;
	kind: "profile" | "release";
}

export interface AuthoritativeRegistrySubjectPage {
	items: readonly AuthoritativeRegistrySubject[];
	nextCursor?: string;
}

export async function listCurrentSubjects(
	db: D1Database,
	cursor?: string,
	limit = 100,
): Promise<AuthoritativeRegistrySubjectPage> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new TypeError("authoritative subject page limit is invalid");
	}
	if (cursor !== undefined && (cursor.length === 0 || cursor.length > 1_024)) {
		throw new TypeError("authoritative subject cursor is invalid");
	}
	const rows = await db
		.prepare(
			`SELECT uri, cid, kind FROM (
				SELECT 'at://' || head.did || '/${NSID.packageProfile}/' || head.slug AS uri,
				       head.current_cid AS cid,
				       'profile' AS kind
				FROM package_profile_heads head
				WHERE head.deleted_at IS NULL AND head.current_cid IS NOT NULL
				UNION ALL
				SELECT 'at://' || release.did || '/${NSID.packageRelease}/' || release.rkey AS uri,
				       json_extract(release.signature_metadata, '$.cid') AS cid,
				       'release' AS kind
				FROM releases release
				JOIN package_profile_heads head
				  ON head.did = release.did AND head.slug = release.package
				WHERE release.tombstoned_at IS NULL
				  AND head.deleted_at IS NULL
				  AND json_type(release.signature_metadata, '$.cid') = 'text'
			) subjects
			WHERE (? IS NULL OR uri > ?)
			ORDER BY uri ASC
			LIMIT ?`,
		)
		.bind(cursor ?? null, cursor ?? null, limit + 1)
		.all<{ uri: string; cid: string; kind: "profile" | "release" }>();
	const page = rows.results.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page,
		...(rows.results.length > limit && last ? { nextCursor: last.uri } : {}),
	};
}

export async function isCurrentSubject(db: D1Database, uri: string, cid: string): Promise<boolean> {
	if (!uri.startsWith("at://") || !cid) return false;
	const profilePrefix = `/${NSID.packageProfile}/`;
	const releasePrefix = `/${NSID.packageRelease}/`;
	const body = uri.slice("at://".length);
	if (body.includes(profilePrefix)) {
		const [did, slug] = body.split(profilePrefix);
		if (!did || !slug) return false;
		const row = await db
			.prepare(
				`SELECT current_cid FROM package_profile_heads
				 WHERE did = ? AND slug = ? AND deleted_at IS NULL`,
			)
			.bind(did, slug)
			.first<{ current_cid: string | null }>();
		return row?.current_cid === cid;
	}
	if (body.includes(releasePrefix)) {
		const [did, rkey] = body.split(releasePrefix);
		if (!did || !rkey) return false;
		const row = await db
			.prepare(
				`SELECT release.signature_metadata
				 FROM releases release
				 JOIN package_profile_heads head
				   ON head.did = release.did AND head.slug = release.package
				 WHERE release.did = ? AND release.rkey = ?
				   AND release.tombstoned_at IS NULL
				   AND head.deleted_at IS NULL`,
			)
			.bind(did, rkey)
			.first<{ signature_metadata: string | null }>();
		return parseSignatureMetadataCid(row?.signature_metadata ?? null) === cid;
	}
	return false;
}
