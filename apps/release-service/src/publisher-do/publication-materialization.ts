import { safeParse } from "@atcute/lexicons";
import { PackageRelease } from "@emdash-cms/registry-lexicons";
import { multihashFromBlobCid } from "@emdash-cms/registry-verification/checksum";
import { base64url } from "jose";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const BLOB_CID_PATTERN = /^b[a-z2-7]{10,255}$/;
const MIME_TYPE_PATTERN = /^(?:application\/gzip|image\/(?:jpeg|png|webp))$/;
const STAGING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const MAX_PACKAGE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_RELEASE_INPUT_JSON_CHARS = 64 * 1024;
const MAX_RECORD_JSON_CHARS = 128 * 1024;

export type PublicationArtifactSlot =
	| "package"
	| "icon"
	| "banner"
	| "screenshots[0]"
	| "screenshots[1]"
	| "screenshots[2]"
	| "screenshots[3]"
	| "screenshots[4]"
	| "screenshots[5]"
	| "screenshots[6]"
	| "screenshots[7]";

const SCREENSHOT_SLOTS = [
	"screenshots[0]",
	"screenshots[1]",
	"screenshots[2]",
	"screenshots[3]",
	"screenshots[4]",
	"screenshots[5]",
	"screenshots[6]",
	"screenshots[7]",
] as const satisfies readonly PublicationArtifactSlot[];

export interface PublicationBlob {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

export interface PutPublicationArtifactStageInput {
	publisherDid: string;
	intentId: string;
	sourceDigest: string;
	slot: PublicationArtifactSlot;
	sourceUrlDigest: string;
	checksum: string;
	stagingKey: string;
	mimeType: string;
	size: number;
	width: number | null;
	height: number | null;
	now?: number;
}

export interface PutPublicationBlobReceiptInput {
	publisherDid: string;
	intentId: string;
	sourceDigest: string;
	slot: PublicationArtifactSlot;
	blob: PublicationBlob;
	now?: number;
}

export interface CompletePublicationMaterializationInput {
	publisherDid: string;
	intentId: string;
	sourceDigest: string;
	recordJson: string;
	recordDigest: string;
	now?: number;
}

export interface StoredPublicationArtifact {
	slot: PublicationArtifactSlot;
	sourceUrlDigest: string;
	checksum: string;
	stagingKey: string;
	mimeType: string;
	size: number;
	width: number | null;
	height: number | null;
	blob: PublicationBlob | null;
	stagedAt: number;
	uploadedAt: number | null;
}

export interface StoredPublicationMaterialization {
	intentId: string;
	sourceDigest: string;
	status: "complete" | "preparing";
	recordJson: string | null;
	recordDigest: string | null;
	createdAt: number;
	updatedAt: number;
	slots: readonly StoredPublicationArtifact[];
}

export type PublicationMaterializationMutationResult =
	| { ok: true; replayed: boolean }
	| {
			ok: false;
			code:
				| "INTENT_NOT_FOUND"
				| "INTENT_STATE_INVALID"
				| "MATERIALIZATION_CONFLICT"
				| "MATERIALIZATION_INCOMPLETE"
				| "MATERIALIZATION_NOT_FOUND"
				| "MATERIALIZATION_SLOT_NOT_FOUND";
	  };

interface IntentRow {
	[key: string]: string | number | ArrayBuffer | null;
	package_slug: string;
	version: string;
	state: string;
	request_digest: string;
	release_input_json: string;
}

interface MaterializationRow {
	[key: string]: string | number | ArrayBuffer | null;
	intent_id: string;
	source_digest: string;
	status: "complete" | "preparing";
	record_json: string | null;
	record_digest: string | null;
	created_at: number;
	updated_at: number;
}

interface ArtifactRow {
	[key: string]: string | number | ArrayBuffer | null;
	slot: PublicationArtifactSlot;
	source_url_digest: string;
	checksum: string;
	staging_key: string;
	mime_type: string;
	byte_size: number;
	width: number | null;
	height: number | null;
	blob_json: string | null;
	staged_at: number;
	uploaded_at: number | null;
}

export class PublicationMaterializationError extends Error {
	readonly code = "PUBLICATION_MATERIALIZATION_INVALID";

	constructor() {
		super("PUBLICATION_MATERIALIZATION_INVALID");
		this.name = "PublicationMaterializationError";
	}
}

function isArtifactSlot(value: unknown): value is PublicationArtifactSlot {
	return (
		value === "package" ||
		value === "icon" ||
		value === "banner" ||
		value === "screenshots[0]" ||
		value === "screenshots[1]" ||
		value === "screenshots[2]" ||
		value === "screenshots[3]" ||
		value === "screenshots[4]" ||
		value === "screenshots[5]" ||
		value === "screenshots[6]" ||
		value === "screenshots[7]"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isMutableIntentState(value: string): boolean {
	return value === "ready" || value === "publishing";
}

function validStage(input: PutPublicationArtifactStageInput, now: number): boolean {
	if (
		!DID_PATTERN.test(input.publisherDid) ||
		!ULID_PATTERN.test(input.intentId) ||
		!DIGEST_PATTERN.test(input.sourceDigest) ||
		!isArtifactSlot(input.slot) ||
		!DIGEST_PATTERN.test(input.sourceUrlDigest) ||
		!CHECKSUM_PATTERN.test(input.checksum) ||
		!STAGING_KEY_PATTERN.test(input.stagingKey) ||
		input.stagingKey.split("/").includes("..") ||
		!MIME_TYPE_PATTERN.test(input.mimeType) ||
		!Number.isSafeInteger(input.size) ||
		input.size < 1 ||
		!validTimestamp(now)
	) {
		return false;
	}
	if (input.slot === "package") {
		return (
			input.mimeType === "application/gzip" &&
			input.size <= MAX_PACKAGE_BYTES &&
			input.width === null &&
			input.height === null
		);
	}
	return (
		input.mimeType !== "application/gzip" &&
		input.size <= MAX_IMAGE_BYTES &&
		Number.isSafeInteger(input.width) &&
		input.width !== null &&
		input.width >= 1 &&
		input.width <= MAX_IMAGE_DIMENSION &&
		Number.isSafeInteger(input.height) &&
		input.height !== null &&
		input.height >= 1 &&
		input.height <= MAX_IMAGE_DIMENSION
	);
}

function parseBlob(value: unknown): PublicationBlob | null {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 4 ||
		value["$type"] !== "blob" ||
		!isRecord(value["ref"]) ||
		Object.keys(value["ref"]).length !== 1 ||
		typeof value["ref"]["$link"] !== "string" ||
		!BLOB_CID_PATTERN.test(value["ref"]["$link"]) ||
		typeof value["mimeType"] !== "string" ||
		!MIME_TYPE_PATTERN.test(value["mimeType"]) ||
		!Number.isSafeInteger(value["size"]) ||
		Number(value["size"]) < 1
	) {
		return null;
	}
	return {
		$type: "blob",
		ref: { $link: value["ref"]["$link"] },
		mimeType: value["mimeType"],
		size: Number(value["size"]),
	};
}

function canonicalBlob(value: unknown): string | null {
	const blob = parseBlob(value);
	if (!blob) return null;
	return JSON.stringify({
		$type: "blob",
		ref: { $link: blob.ref.$link },
		mimeType: blob.mimeType,
		size: blob.size,
	});
}

function parseCanonicalReleaseRecord(value: string): PackageRelease.Main | null {
	if (typeof value !== "string" || value.length < 2 || value.length > MAX_RECORD_JSON_CHARS) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			JSON.stringify(parsed) !== value
		) {
			return null;
		}
		const release = safeParse(PackageRelease.mainSchema, parsed, { strict: true });
		return release.ok ? release.value : null;
	} catch {
		return null;
	}
}

function parseIntentRelease(value: string): PackageRelease.Main | null {
	if (value.length < 2 || value.length > MAX_RELEASE_INPUT_JSON_CHARS) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!isRecord(parsed) ||
			Object.keys(parsed).length !== 1 ||
			!("release" in parsed) ||
			JSON.stringify(parsed) !== value
		) {
			return null;
		}
		const release = safeParse(PackageRelease.mainSchema, parsed["release"], { strict: true });
		return release.ok ? release.value : null;
	} catch {
		return null;
	}
}

type ArtifactDescriptor = PackageRelease.Artifact | PackageRelease.ImageArtifact;

function releaseArtifacts(
	release: PackageRelease.Main,
): readonly (readonly [PublicationArtifactSlot, ArtifactDescriptor])[] {
	const screenshots = (release.artifacts.screenshots ?? []).map((descriptor, index) => {
		const slot = SCREENSHOT_SLOTS[index];
		if (!slot) throw new PublicationMaterializationError();
		return [slot, descriptor] as const;
	});
	return [
		["package", release.artifacts.package],
		...(release.artifacts.icon ? ([["icon", release.artifacts.icon]] as const) : []),
		...(release.artifacts.banner ? ([["banner", release.artifacts.banner]] as const) : []),
		...screenshots,
	];
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) throw new TypeError("Non-JSON value");
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, item] of Object.entries(value).toSorted(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		if (item === undefined) throw new TypeError("Undefined JSON value");
		result[key] = canonicalize(item);
	}
	return result;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function expectedDescriptor(
	slot: PublicationArtifactSlot,
	source: ArtifactDescriptor,
	artifact: StoredPublicationArtifact,
): ArtifactDescriptor | null {
	if (
		typeof source.url !== "string" ||
		Object.hasOwn(source, "blob") ||
		Object.hasOwn(source, "requiresAuth") ||
		source.checksum !== artifact.checksum ||
		(source.contentType !== undefined && source.contentType.toLowerCase() !== artifact.mimeType) ||
		!artifact.blob
	) {
		return null;
	}
	const blobChecksum = multihashFromBlobCid(artifact.blob.ref.$link);
	if (
		!blobChecksum.success ||
		blobChecksum.value !== artifact.checksum ||
		artifact.blob.mimeType !== artifact.mimeType ||
		artifact.blob.size !== artifact.size
	) {
		return null;
	}
	if (slot === "package") {
		if (
			artifact.mimeType !== "application/gzip" ||
			artifact.width !== null ||
			artifact.height !== null
		) {
			return null;
		}
	} else if (
		artifact.mimeType === "application/gzip" ||
		artifact.width === null ||
		artifact.height === null ||
		(source.width !== undefined && source.width !== artifact.width) ||
		(source.height !== undefined && source.height !== artifact.height)
	) {
		return null;
	}
	const expected = structuredClone(source);
	delete expected.url;
	delete expected.blob;
	delete expected.requiresAuth;
	delete expected.releaseAsset;
	expected.contentType = artifact.mimeType;
	expected.blob = artifact.blob;
	if (slot !== "package") {
		if (artifact.width === null || artifact.height === null) return null;
		expected.width = artifact.width;
		expected.height = artifact.height;
	}
	return expected;
}

function validateCompletedRecord(
	intent: IntentRow,
	source: PackageRelease.Main,
	record: PackageRelease.Main,
	artifacts: readonly StoredPublicationArtifact[],
	sourceUrlDigests: ReadonlyMap<PublicationArtifactSlot, string>,
): "complete" | "conflict" | "incomplete" {
	if (
		source.package !== intent.package_slug ||
		source.version !== intent.version ||
		record.package !== intent.package_slug ||
		record.version !== intent.version
	) {
		return "conflict";
	}
	const sourceEntries = releaseArtifacts(source);
	const recordEntries = new Map(releaseArtifacts(record));
	const stored = new Map(artifacts.map((artifact) => [artifact.slot, artifact]));
	if (sourceEntries.some(([slot]) => !stored.has(slot))) return "incomplete";
	if (stored.size !== sourceEntries.length || recordEntries.size !== sourceEntries.length) {
		return "conflict";
	}
	const { artifacts: sourceArtifactSet, ...sourceRecord } = source;
	const { artifacts: recordArtifactSet, ...completedRecord } = record;
	if (
		canonicalJson(sourceRecord) !== canonicalJson(completedRecord) ||
		sourceArtifactSet.$type !== recordArtifactSet.$type
	) {
		return "conflict";
	}
	for (const [slot, sourceDescriptor] of sourceEntries) {
		const artifact = stored.get(slot);
		const recordDescriptor = recordEntries.get(slot);
		if (!artifact?.blob || !recordDescriptor) return "incomplete";
		if (artifact.sourceUrlDigest !== sourceUrlDigests.get(slot)) return "conflict";
		const expected = expectedDescriptor(slot, sourceDescriptor, artifact);
		if (!expected || canonicalJson(expected) !== canonicalJson(recordDescriptor)) return "conflict";
	}
	return "complete";
}

async function digest(value: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
	);
}

function rowToArtifact(row: ArtifactRow): StoredPublicationArtifact {
	let blob: PublicationBlob | null = null;
	if (row.blob_json !== null) {
		try {
			blob = parseBlob(JSON.parse(row.blob_json));
		} catch {
			throw new PublicationMaterializationError();
		}
		if (!blob || canonicalBlob(blob) !== row.blob_json) {
			throw new PublicationMaterializationError();
		}
	}
	return {
		slot: row.slot,
		sourceUrlDigest: row.source_url_digest,
		checksum: row.checksum,
		stagingKey: row.staging_key,
		mimeType: row.mime_type,
		size: row.byte_size,
		width: row.width,
		height: row.height,
		blob,
		stagedAt: row.staged_at,
		uploadedAt: row.uploaded_at,
	};
}

export function initializePublicationMaterializationSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS publication_materializations (
			intent_id TEXT PRIMARY KEY,
			source_digest TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('preparing', 'complete')),
			record_json TEXT,
			record_digest TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS publication_materialization_slots (
			intent_id TEXT NOT NULL,
			slot TEXT NOT NULL CHECK (slot IN (
				'package', 'icon', 'banner',
				'screenshots[0]', 'screenshots[1]', 'screenshots[2]', 'screenshots[3]',
				'screenshots[4]', 'screenshots[5]', 'screenshots[6]', 'screenshots[7]'
			)),
			source_url_digest TEXT NOT NULL,
			checksum TEXT NOT NULL,
			staging_key TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL CHECK (byte_size > 0),
			width INTEGER,
			height INTEGER,
			blob_json TEXT,
			staged_at INTEGER NOT NULL,
			uploaded_at INTEGER,
			PRIMARY KEY (intent_id, slot)
		);
		CREATE INDEX IF NOT EXISTS idx_publication_materialization_slots_intent
			ON publication_materialization_slots(intent_id, slot);
	`);
}

export class PublicationMaterializationStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	begin(
		publisherDid: string,
		intentId: string,
		sourceDigest: string,
		now = Date.now(),
	): PublicationMaterializationMutationResult {
		if (
			!DID_PATTERN.test(publisherDid) ||
			!ULID_PATTERN.test(intentId) ||
			!DIGEST_PATTERN.test(sourceDigest) ||
			!validTimestamp(now)
		) {
			throw new PublicationMaterializationError();
		}
		return this.storage.transactionSync(() => {
			const intent = this.#intent(intentId);
			if (!intent) return { ok: false, code: "INTENT_NOT_FOUND" } as const;
			const current = this.#materialization(intentId);
			if (current) {
				return current.source_digest === sourceDigest && intent.request_digest === sourceDigest
					? ({ ok: true, replayed: true } as const)
					: ({ ok: false, code: "MATERIALIZATION_CONFLICT" } as const);
			}
			if (!isMutableIntentState(intent.state)) {
				return { ok: false, code: "INTENT_STATE_INVALID" } as const;
			}
			if (intent.request_digest !== sourceDigest) {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO publication_materializations (
					intent_id, source_digest, status, record_json, record_digest, created_at, updated_at
				) VALUES (?, ?, 'preparing', NULL, NULL, ?, ?)`,
				intentId,
				sourceDigest,
				now,
				now,
			);
			return { ok: true, replayed: false } as const;
		});
	}

	putStage(input: PutPublicationArtifactStageInput): PublicationMaterializationMutationResult {
		const now = input.now ?? Date.now();
		if (!validStage(input, now)) throw new PublicationMaterializationError();
		return this.storage.transactionSync(() => {
			const parent = this.#materialization(input.intentId);
			if (!parent) return { ok: false, code: "MATERIALIZATION_NOT_FOUND" } as const;
			if (parent.source_digest !== input.sourceDigest) {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			const current = this.#artifact(input.intentId, input.slot);
			if (current) {
				return current.source_url_digest === input.sourceUrlDigest &&
					current.checksum === input.checksum &&
					current.staging_key === input.stagingKey &&
					current.mime_type === input.mimeType &&
					current.byte_size === input.size &&
					current.width === input.width &&
					current.height === input.height
					? ({ ok: true, replayed: true } as const)
					: ({ ok: false, code: "MATERIALIZATION_CONFLICT" } as const);
			}
			if (parent.status !== "preparing" || !this.#mutableIntent(input.intentId)) {
				return { ok: false, code: "INTENT_STATE_INVALID" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO publication_materialization_slots (
					intent_id, slot, source_url_digest, checksum, staging_key, mime_type,
					byte_size, width, height, blob_json, staged_at, uploaded_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
				input.intentId,
				input.slot,
				input.sourceUrlDigest,
				input.checksum,
				input.stagingKey,
				input.mimeType,
				input.size,
				input.width,
				input.height,
				now,
			);
			this.#touch(input.intentId, now);
			return { ok: true, replayed: false } as const;
		});
	}

	putReceipt(input: PutPublicationBlobReceiptInput): PublicationMaterializationMutationResult {
		const now = input.now ?? Date.now();
		const blobJson = canonicalBlob(input.blob);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!DIGEST_PATTERN.test(input.sourceDigest) ||
			!isArtifactSlot(input.slot) ||
			blobJson === null ||
			!validTimestamp(now)
		) {
			throw new PublicationMaterializationError();
		}
		return this.storage.transactionSync(() => {
			const parent = this.#materialization(input.intentId);
			if (!parent) return { ok: false, code: "MATERIALIZATION_NOT_FOUND" } as const;
			if (parent.source_digest !== input.sourceDigest) {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			const stage = this.#artifact(input.intentId, input.slot);
			if (!stage) return { ok: false, code: "MATERIALIZATION_SLOT_NOT_FOUND" } as const;
			const blobChecksum = multihashFromBlobCid(input.blob.ref.$link);
			if (
				!blobChecksum.success ||
				blobChecksum.value !== stage.checksum ||
				input.blob.mimeType !== stage.mime_type ||
				input.blob.size !== stage.byte_size
			) {
				throw new PublicationMaterializationError();
			}
			if (stage.blob_json !== null) {
				return stage.blob_json === blobJson
					? ({ ok: true, replayed: true } as const)
					: ({ ok: false, code: "MATERIALIZATION_CONFLICT" } as const);
			}
			if (parent.status !== "preparing" || !this.#mutableIntent(input.intentId)) {
				return { ok: false, code: "INTENT_STATE_INVALID" } as const;
			}
			this.storage.sql.exec(
				`UPDATE publication_materialization_slots SET blob_json = ?, uploaded_at = ?
				 WHERE intent_id = ? AND slot = ? AND blob_json IS NULL`,
				blobJson,
				now,
				input.intentId,
				input.slot,
			);
			this.#touch(input.intentId, now);
			return { ok: true, replayed: false } as const;
		});
	}

	async complete(
		input: CompletePublicationMaterializationInput,
	): Promise<PublicationMaterializationMutationResult> {
		const now = input.now ?? Date.now();
		const record = parseCanonicalReleaseRecord(input.recordJson);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!DIGEST_PATTERN.test(input.sourceDigest) ||
			record === null ||
			!DIGEST_PATTERN.test(input.recordDigest) ||
			!validTimestamp(now) ||
			(await digest(input.recordJson)) !== input.recordDigest
		) {
			throw new PublicationMaterializationError();
		}
		const intentSnapshot = this.#intent(input.intentId);
		let source = intentSnapshot ? parseIntentRelease(intentSnapshot.release_input_json) : null;
		const sourceUrlDigests = new Map<PublicationArtifactSlot, string>();
		if (source) {
			const digests = await Promise.all(
				releaseArtifacts(source).map(async ([slot, descriptor]) => {
					if (
						typeof descriptor.url !== "string" ||
						Object.hasOwn(descriptor, "blob") ||
						Object.hasOwn(descriptor, "requiresAuth")
					) {
						return null;
					}
					return [slot, await digest(descriptor.url)] as const;
				}),
			);
			for (const entry of digests) {
				if (!entry) {
					source = null;
					break;
				}
				const [slot, sourceUrlDigest] = entry;
				sourceUrlDigests.set(slot, sourceUrlDigest);
			}
		}
		return this.storage.transactionSync(() => {
			const parent = this.#materialization(input.intentId);
			if (!parent) return { ok: false, code: "MATERIALIZATION_NOT_FOUND" } as const;
			if (parent.source_digest !== input.sourceDigest) {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			const intent = this.#intent(input.intentId);
			if (
				!intentSnapshot ||
				!intent ||
				!source ||
				intent.package_slug !== intentSnapshot.package_slug ||
				intent.version !== intentSnapshot.version ||
				intent.request_digest !== intentSnapshot.request_digest ||
				intent.release_input_json !== intentSnapshot.release_input_json
			) {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			if (parent.status === "complete") {
				return parent.record_json === input.recordJson &&
					parent.record_digest === input.recordDigest
					? ({ ok: true, replayed: true } as const)
					: ({ ok: false, code: "MATERIALIZATION_CONFLICT" } as const);
			}
			const validation = validateCompletedRecord(
				intent,
				source,
				record,
				this.#artifacts(input.intentId),
				sourceUrlDigests,
			);
			if (validation === "incomplete") {
				return { ok: false, code: "MATERIALIZATION_INCOMPLETE" } as const;
			}
			if (validation === "conflict") {
				return { ok: false, code: "MATERIALIZATION_CONFLICT" } as const;
			}
			if (!this.#mutableIntent(input.intentId)) {
				return { ok: false, code: "INTENT_STATE_INVALID" } as const;
			}
			this.storage.sql.exec(
				`UPDATE publication_materializations SET
					status = 'complete', record_json = ?, record_digest = ?, updated_at = ?
				 WHERE intent_id = ? AND status = 'preparing'`,
				input.recordJson,
				input.recordDigest,
				now,
				input.intentId,
			);
			return { ok: true, replayed: false } as const;
		});
	}

	get(intentId: string): StoredPublicationMaterialization | null {
		if (!ULID_PATTERN.test(intentId)) throw new PublicationMaterializationError();
		const parent = this.#materialization(intentId);
		if (!parent) return null;
		return {
			intentId: parent.intent_id,
			sourceDigest: parent.source_digest,
			status: parent.status,
			recordJson: parent.record_json,
			recordDigest: parent.record_digest,
			createdAt: parent.created_at,
			updatedAt: parent.updated_at,
			slots: this.#artifacts(intentId),
		};
	}

	#intent(intentId: string): IntentRow | null {
		return (
			this.storage.sql
				.exec<IntentRow>(
					`SELECT package_slug, version, state, request_digest, release_input_json
					 FROM intents WHERE id = ?`,
					intentId,
				)
				.toArray()[0] ?? null
		);
	}

	#mutableIntent(intentId: string): boolean {
		const intent = this.#intent(intentId);
		return intent !== null && isMutableIntentState(intent.state);
	}

	#materialization(intentId: string): MaterializationRow | null {
		return (
			this.storage.sql
				.exec<MaterializationRow>(
					`SELECT intent_id, source_digest, status, record_json, record_digest,
					        created_at, updated_at
					 FROM publication_materializations WHERE intent_id = ?`,
					intentId,
				)
				.toArray()[0] ?? null
		);
	}

	#artifact(intentId: string, slot: PublicationArtifactSlot): ArtifactRow | null {
		return (
			this.storage.sql
				.exec<ArtifactRow>(
					`SELECT slot, source_url_digest, checksum, staging_key, mime_type,
					        byte_size, width, height, blob_json, staged_at, uploaded_at
					 FROM publication_materialization_slots WHERE intent_id = ? AND slot = ?`,
					intentId,
					slot,
				)
				.toArray()[0] ?? null
		);
	}

	#artifacts(intentId: string): readonly StoredPublicationArtifact[] {
		return this.storage.sql
			.exec<ArtifactRow>(
				`SELECT slot, source_url_digest, checksum, staging_key, mime_type,
				        byte_size, width, height, blob_json, staged_at, uploaded_at
				 FROM publication_materialization_slots WHERE intent_id = ?
				 ORDER BY CASE slot
					WHEN 'package' THEN 0 WHEN 'icon' THEN 1 WHEN 'banner' THEN 2
					WHEN 'screenshots[0]' THEN 3 WHEN 'screenshots[1]' THEN 4
					WHEN 'screenshots[2]' THEN 5 WHEN 'screenshots[3]' THEN 6
					WHEN 'screenshots[4]' THEN 7 WHEN 'screenshots[5]' THEN 8
					WHEN 'screenshots[6]' THEN 9 WHEN 'screenshots[7]' THEN 10 ELSE 11 END`,
				intentId,
			)
			.toArray()
			.map(rowToArtifact);
	}

	#touch(intentId: string, now: number): void {
		this.storage.sql.exec(
			"UPDATE publication_materializations SET updated_at = ? WHERE intent_id = ?",
			now,
			intentId,
		);
	}
}
