/**
 * Records queue consumer. Replaces the no-op `queue()` handler in `index.ts`.
 *
 * For each `RecordsJob` from the Records Queue:
 *
 *   1. `delete` operations short-circuit to a tombstone / hard-delete write.
 *   2. `create` / `update` go through the verification pipeline:
 *      a. Resolve publisher's PDS endpoint + signing key (cached in
 *         `known_publishers`).
 *      b. Fetch + verify the record via `com.atproto.sync.getRecord`
 *         (`@atcute/repo` does MST + signature in one call).
 *      c. Cross-check the verified record against the Jetstream-supplied copy
 *         (verified always wins; mismatch is logged as a Jetstream-correctness
 *         signal).
 *      d. Lexicon-validate against the generated runtime schema for the
 *         specific collection.
 *      e. Per-collection structural checks (rkey-vs-version for releases,
 *         rkey=='self' for publisher.profile, contact validation, etc.).
 *      f. Write to D1.
 *
 * Error policy:
 *   - Verification failure (signature, MST, lexicon, structural): write a
 *     `dead_letters` row with the structured reason + payload, ack the message.
 *     Never retry — these are malicious or broken upstream.
 *   - Transient PDS failure (network, timeout, 5xx): `retry()` so Cloudflare
 *     Queues backs off and retries. After `max_retries` (5) it lands in the
 *     configured DLQ.
 *   - Unexpected programming errors: log loud, write a `dead_letters` row,
 *     ack the message. Never crash the worker — that would block the queue.
 */

import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import { safeParse } from "@atcute/lexicons/validations";
import {
	NSID,
	PackageProfile,
	PackageRelease,
	PackageReleaseExtension,
	PublisherProfile,
	PublisherVerification,
} from "@emdash-cms/registry-lexicons";

import { createD1DidDocCache, DidResolver } from "./did-resolver.js";
import type { RecordsJob } from "./env.js";
import {
	fetchAndVerifyRecord,
	isTransient,
	PdsVerificationError,
	type VerificationFailureReason,
	type VerifiedPdsRecord,
} from "./pds-verify.js";

/**
 * Deps the consumer needs at runtime. Constructed once per `processBatch` call
 * (per workerd invocation). Tests inject their own.
 */
export interface ConsumerDeps {
	db: D1Database;
	resolver: DidResolver;
	fetch?: typeof fetch;
	now?: () => Date;
}

/** Subset of `cloudflare:workers` `Message` we use; defining inline so tests
 * don't need to import workerd types. */
export interface MessageController {
	ack(): void;
	retry(): void;
}

/** Subset of a `MessageBatch`. Workers' real batch object satisfies this. */
export interface MessageBatchLike<T> {
	readonly messages: ReadonlyArray<MessageController & { body: T }>;
}

/** Reason codes written to `dead_letters.reason`. PDS-verification reasons
 * pass through verbatim from `PdsVerificationError`; the rest are structural
 * checks the consumer enforces locally. */
export type DeadLetterReason =
	// from pds-verify (only the permanent ones — transient ones retry)
	| "RECORD_NOT_FOUND"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_PROOF"
	| "PDS_HTTP_ERROR"
	// structural checks (consumer-enforced)
	| "LEXICON_VALIDATION_FAILED"
	| "RKEY_MISMATCH"
	| "CONTACT_VALIDATION_FAILED"
	| "INVALID_VERSION"
	| "UNKNOWN_COLLECTION"
	| "UNEXPECTED_ERROR";

/**
 * Thrown by writers when the input is well-formed but the dependency it
 * needs isn't yet present (e.g. a release whose parent profile hasn't been
 * ingested). Distinct from `IngestError` because the right action is
 * `controller.retry()` — the next attempt may succeed once the parent
 * arrives. After Cloudflare Queues exhausts `max_retries` (5) the message
 * lands in the configured DLQ and the reconciliation pass picks it up.
 */
export class MissingDependencyError extends Error {
	override readonly name = "MissingDependencyError";
}

/** Thrown by writers and structural checks. Carries the reason for the
 * `dead_letters` row plus an optional human-readable detail. */
export class IngestError extends Error {
	override readonly name = "IngestError";
	constructor(
		readonly reason: DeadLetterReason,
		message: string,
		readonly detail?: string,
	) {
		super(message);
	}
}

export async function processBatch(
	batch: MessageBatchLike<RecordsJob>,
	env: Env,
	depsOverride?: ConsumerDeps,
): Promise<void> {
	const deps = depsOverride ?? createProductionDeps(env);
	// Process jobs independently — a single failed verification must not fail
	// the whole batch and trigger redeliveries for already-acked messages.
	for (const message of batch.messages) {
		await processMessage(message.body, message, deps);
	}
}

export async function processMessage(
	job: RecordsJob,
	controller: MessageController,
	deps: ConsumerDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date());

	if (job.operation === "delete") {
		try {
			await applyDelete(deps.db, job, now());
			controller.ack();
		} catch (err) {
			if (err instanceof IngestError) {
				// Structural: unknown collection. Don't retry — the schema
				// problem won't fix itself across attempts. Forensics + ack.
				await writeDeadLetter(deps.db, job, err.reason, err.detail ?? err.message, now());
				controller.ack();
				return;
			}
			// Transient (D1 unavailable, etc.) — retry.
			console.error("[aggregator] delete failed", {
				did: job.did,
				collection: job.collection,
				rkey: job.rkey,
				error: err instanceof Error ? err.message : String(err),
			});
			controller.retry();
		}
		return;
	}

	try {
		await verifyAndIngest(job, deps);
		controller.ack();
		return;
	} catch (err) {
		if (err instanceof PdsVerificationError) {
			if (isTransient(err.reason, err.status)) {
				controller.retry();
				return;
			}
			await writeDeadLetter(deps.db, job, mapPdsReason(err.reason), err.message, now());
			controller.ack();
			return;
		}
		if (err instanceof IngestError) {
			await writeDeadLetter(deps.db, job, err.reason, err.detail ?? err.message, now());
			controller.ack();
			return;
		}
		if (err instanceof MissingDependencyError) {
			// Out-of-order Jetstream delivery (release before its profile is a
			// common case). Retry; after max_retries the message lands in the
			// DLQ for the reconciliation pass to recover.
			console.warn("[aggregator] missing dependency, retrying", {
				did: job.did,
				collection: job.collection,
				rkey: job.rkey,
				reason: err.message,
			});
			controller.retry();
			return;
		}
		// Unexpected — log loud, dead-letter, ack so the queue isn't blocked.
		// We don't retry because we have no evidence the next attempt will
		// succeed and unbounded retries on a poison message stall the slot.
		console.error("[aggregator] unexpected consumer error", {
			did: job.did,
			collection: job.collection,
			rkey: job.rkey,
			error: err instanceof Error ? (err.stack ?? err.message) : String(err),
		});
		await writeDeadLetter(
			deps.db,
			job,
			"UNEXPECTED_ERROR",
			err instanceof Error ? err.message : String(err),
			now(),
		);
		controller.ack();
	}
}

async function verifyAndIngest(job: RecordsJob, deps: ConsumerDeps): Promise<void> {
	const resolved = await deps.resolver.resolve(job.did);
	const verified = await fetchAndVerifyRecord({
		pds: resolved.pds,
		did: job.did,
		collection: job.collection,
		rkey: job.rkey,
		publicKey: resolved.publicKey,
		fetch: deps.fetch,
	});

	// Cross-check vs Jetstream copy intentionally omitted: the verified PDS
	// copy is canonical and always wins, so the comparison is a monitoring
	// signal only. JSON.stringify isn't a canonical comparator — key order
	// and undefined-vs-missing differences fire false positives constantly.
	// Add a CBOR-canonical comparator when Jetstream-correctness monitoring
	// becomes load-bearing; for now the verified copy is what gets written.

	const now = (deps.now ?? (() => new Date()))();

	switch (job.collection) {
		case NSID.packageProfile:
			return ingestPackageProfile(deps.db, job, verified, now);
		case NSID.packageRelease:
			return ingestPackageRelease(deps.db, job, verified, now);
		case NSID.publisherProfile:
			return ingestPublisherProfile(deps.db, job, verified, now);
		case NSID.publisherVerification:
			return ingestPublisherVerification(deps.db, job, verified, now);
		default:
			throw new IngestError(
				"UNKNOWN_COLLECTION",
				`unsupported collection: ${job.collection}`,
				job.collection,
			);
	}
}

// ─── Writers ────────────────────────────────────────────────────────────────

export async function ingestPackageProfile(
	db: D1Database,
	job: RecordsJob,
	verified: VerifiedPdsRecord,
	now: Date,
): Promise<void> {
	const validation = safeParse(PackageProfile.mainSchema, verified.record);
	if (!validation.ok) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			"package.profile failed lexicon validation",
			formatValidationIssues(validation.issues),
		);
	}
	const record = validation.value;
	// Lexicon requires `id` to be the canonical AT URI of the record itself;
	// aggregators MUST reject records where it disagrees with the URI we
	// fetched from. verifyRecord binds the body to (did, collection, rkey)
	// via the MST proof, but the publisher could put a bogus `id` value in
	// the body and it would still verify — that's exactly what this check
	// catches.
	const expectedId = `at://${job.did}/${NSID.packageProfile}/${job.rkey}`;
	if (record.id !== expectedId) {
		throw new IngestError(
			"RKEY_MISMATCH",
			`package.profile record.id '${record.id}' does not match AT URI '${expectedId}'`,
		);
	}
	// Slug is optional — when absent, clients use the rkey as the display
	// slug. When present, lexicon requires it to equal the rkey.
	if (record.slug !== undefined && record.slug !== job.rkey) {
		throw new IngestError(
			"RKEY_MISMATCH",
			`package.profile rkey '${job.rkey}' does not match record.slug '${record.slug}'`,
		);
	}
	// Lexicon-can't-express constraint (`profile.json` line 113): each
	// security[] entry MUST carry at least one of url/email; aggregators
	// MUST reject otherwise. authors[] only SHOULDs the same so we don't
	// enforce there.
	for (const c of record.security) {
		if (!c.url && !c.email) {
			throw new IngestError(
				"CONTACT_VALIDATION_FAILED",
				"package.profile security entry must include at least one of `url` or `email`",
			);
		}
	}
	const slug = record.slug ?? job.rkey;
	const sigMeta = JSON.stringify({ cid: verified.cid });
	await db
		.prepare(
			`INSERT INTO packages
			   (did, slug, type, name, description, license, authors, security, keywords, sections,
			    last_updated, latest_version, capabilities, record_blob, signature_metadata, verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(did, slug) DO UPDATE SET
			   type = excluded.type,
			   name = excluded.name,
			   description = excluded.description,
			   license = excluded.license,
			   authors = excluded.authors,
			   security = excluded.security,
			   keywords = excluded.keywords,
			   sections = excluded.sections,
			   last_updated = excluded.last_updated,
			   record_blob = excluded.record_blob,
			   signature_metadata = excluded.signature_metadata,
			   verified_at = excluded.verified_at`,
		)
		.bind(
			job.did,
			slug,
			record.type,
			record.name ?? null,
			record.description ?? null,
			record.license,
			JSON.stringify(record.authors),
			JSON.stringify(record.security),
			record.keywords ? JSON.stringify(record.keywords) : null,
			record.sections ? JSON.stringify(record.sections) : null,
			record.lastUpdated ?? null,
			null, // latest_version — populated by release writer, not the profile writer
			null, // capabilities — populated by release writer
			verified.carBytes,
			sigMeta,
			now.toISOString(),
		)
		.run();
}

export async function ingestPackageRelease(
	db: D1Database,
	job: RecordsJob,
	verified: VerifiedPdsRecord,
	now: Date,
): Promise<void> {
	const validation = safeParse(PackageRelease.mainSchema, verified.record);
	if (!validation.ok) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			"package.release failed lexicon validation",
			formatValidationIssues(validation.issues),
		);
	}
	const record = validation.value;
	// Lexicon describes the slug format ("ASCII letter followed by ASCII
	// letters, digits, '-', or '_'") but doesn't pin a regex. `record.package`
	// must obey the same shape since it's the slug of the parent profile;
	// without this check, `package: "foo:bar"` builds an ambiguous rkey
	// `foo:bar:1.0.0` indistinguishable from `package: "foo"` + `version:
	// "bar:1.0.0"`. Two rows for what looks like the same release.
	if (!PACKAGE_SLUG_RE.test(record.package)) {
		throw new IngestError(
			"RKEY_MISMATCH",
			`package.release record.package '${record.package}' must match ${PACKAGE_SLUG_RE}`,
		);
	}
	const expectedRkey = `${record.package}:${encodeRkeyVersion(record.version)}`;
	if (job.rkey !== expectedRkey) {
		throw new IngestError(
			"RKEY_MISMATCH",
			`package.release rkey '${job.rkey}' does not match expected '${expectedRkey}'`,
		);
	}

	const versionSort = computeVersionSort(record.version);
	if (!versionSort) {
		throw new IngestError(
			"INVALID_VERSION",
			`package.release version '${record.version}' is not parseable as semver`,
		);
	}

	// Lexicon mandates releases of type emdash-plugin include a
	// releaseExtension entry under the keyed open-union `extensions` map.
	// `extensions` is typed as `unknown` in the generated schema so we
	// validate the inner shape ourselves; without this, malformed extension
	// payloads land in `releases.emdash_extension` and break the read API.
	if (!isPlainObject(record.extensions)) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			`package.release extensions field must be an object, got ${typeof record.extensions}`,
		);
	}
	const extension = record.extensions[NSID.packageReleaseExtension];
	if (!extension) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			`package.release missing required extensions['${NSID.packageReleaseExtension}']`,
		);
	}
	const extValidation = safeParse(PackageReleaseExtension.mainSchema, extension);
	if (!extValidation.ok) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			"package.release releaseExtension failed lexicon validation",
			formatValidationIssues(extValidation.issues),
		);
	}

	// Parent-profile presence check. The schema's FK would catch this at
	// INSERT time, but a raw FK violation surfaces as an opaque error that
	// gets dead-lettered as UNEXPECTED_ERROR with no recovery path. Doing
	// the lookup explicitly lets us throw MissingDependencyError → retry,
	// so out-of-order Jetstream delivery (release before profile) recovers
	// once the profile arrives.
	const parent = await db
		.prepare(`SELECT 1 FROM packages WHERE did = ? AND slug = ?`)
		.bind(job.did, record.package)
		.first();
	if (!parent) {
		throw new MissingDependencyError(
			`package.release ${job.rkey} requires profile ${record.package} which is not yet ingested`,
		);
	}

	const sigMeta = JSON.stringify({ cid: verified.cid });
	const result = await db
		.prepare(
			`INSERT INTO releases
			   (did, package, version, rkey, version_sort, artifacts, requires, suggests,
			    emdash_extension, repo_url, cts, record_blob, signature_metadata, verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(did, package, version) DO NOTHING`,
		)
		.bind(
			job.did,
			record.package,
			record.version,
			job.rkey,
			versionSort,
			JSON.stringify(record.artifacts),
			record.requires ? JSON.stringify(record.requires) : null,
			record.suggests ? JSON.stringify(record.suggests) : null,
			// Store only the validated releaseExtension contents, not the
			// arbitrary `record.extensions` map. Schema comment for
			// `emdash_extension` matches this shape.
			JSON.stringify(extValidation.value),
			record.repo ?? null,
			// cts column intentionally mirrors verified_at: the release lexicon
			// has no creation-timestamp field today and the atproto MST commit
			// rev isn't surfaced by verifyRecord. Tracked: revisit if the
			// lexicon adds a createdAt or @atcute/repo exposes commit metadata.
			now.toISOString(),
			verified.carBytes,
			sigMeta,
			now.toISOString(),
		)
		.run();

	let releaseSetChanged = result.meta.changes === 1;
	if (result.meta.changes === 0) {
		// Conflict path. Three sub-cases:
		//   1. Same content, not tombstoned → legitimate idempotent replay,
		//      silent no-op.
		//   2. Same content, tombstoned → publisher re-published a previously
		//      deleted release; clear the tombstone so it reappears in read
		//      results.
		//   3. Different content → immutability violation; audit it.
		const existing = await db
			.prepare(
				`SELECT record_blob, tombstoned_at
				 FROM releases WHERE did = ? AND package = ? AND version = ?`,
			)
			.bind(job.did, record.package, record.version)
			.first<{ record_blob: ArrayBuffer | Uint8Array; tombstoned_at: string | null }>();
		if (existing) {
			const sameContent = bytesEqual(toUint8(existing.record_blob), verified.carBytes);
			if (sameContent && existing.tombstoned_at !== null) {
				await db
					.prepare(
						`UPDATE releases SET tombstoned_at = NULL
						 WHERE did = ? AND package = ? AND version = ?`,
					)
					.bind(job.did, record.package, record.version)
					.run();
				releaseSetChanged = true;
			} else if (!sameContent) {
				await db
					.prepare(
						`INSERT INTO release_duplicate_attempts
						   (did, package, version, rejected_at, reason, attempted_record_blob)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						job.did,
						record.package,
						record.version,
						now.toISOString(),
						"IMMUTABLE_VERSION",
						verified.carBytes,
					)
					.run();
			}
		}
	}

	// Whenever the visible-release set for this package changed, recompute
	// `packages.latest_version` and `capabilities` from the new max-version
	// row. The schema promises these are denormalised from the latest release;
	// the read API queries them directly without sorting at request time.
	if (releaseSetChanged) {
		await refreshPackageLatest(db, job.did, record.package);
	}

	// TODO(slice 3): enqueue artifact-mirror task for this release. Until then,
	// `mirrored_artifacts` stays empty for new releases.
}

/**
 * Recompute `packages.latest_version` and `capabilities` from the current
 * max-version-sort, non-tombstoned release. Capabilities are the keys of the
 * release's `declaredAccess` map — the cheap projection the search SQL uses
 * for capability filtering.
 *
 * Called from the release writer (after insert / un-tombstone) and from
 * `applyDelete` (after release tombstone). Both code paths can change which
 * release is "latest" for a package.
 */
async function refreshPackageLatest(db: D1Database, did: string, pkg: string): Promise<void> {
	const latest = await db
		.prepare(
			`SELECT version, emdash_extension
			 FROM releases
			 WHERE did = ? AND package = ? AND tombstoned_at IS NULL
			 ORDER BY version_sort DESC LIMIT 1`,
		)
		.bind(did, pkg)
		.first<{ version: string; emdash_extension: string }>();

	let latestVersion: string | null = null;
	let capabilities: string | null = null;
	if (latest) {
		latestVersion = latest.version;
		try {
			const parsed: unknown = JSON.parse(latest.emdash_extension);
			if (isPlainObject(parsed) && isPlainObject(parsed.declaredAccess)) {
				capabilities = JSON.stringify(Object.keys(parsed.declaredAccess));
			}
		} catch {
			// Stored extension is malformed JSON; leave capabilities null
			// rather than failing the whole consumer pass.
		}
	}

	await db
		.prepare(
			`UPDATE packages SET latest_version = ?, capabilities = ?
			 WHERE did = ? AND slug = ?`,
		)
		.bind(latestVersion, capabilities, did, pkg)
		.run();
}

export async function ingestPublisherProfile(
	db: D1Database,
	job: RecordsJob,
	verified: VerifiedPdsRecord,
	now: Date,
): Promise<void> {
	const validation = safeParse(PublisherProfile.mainSchema, verified.record);
	if (!validation.ok) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			"publisher.profile failed lexicon validation",
			formatValidationIssues(validation.issues),
		);
	}
	const record = validation.value;
	if (job.rkey !== "self") {
		throw new IngestError(
			"RKEY_MISMATCH",
			`publisher.profile rkey must be 'self', got '${job.rkey}'`,
		);
	}
	// Lexicon can't express "at least one of url|email" on contact entries.
	// Enforce at the consumer.
	for (const c of record.contact ?? []) {
		if (!c.url && !c.email) {
			throw new IngestError(
				"CONTACT_VALIDATION_FAILED",
				"publisher.profile contact entry must include at least one of `url` or `email`",
			);
		}
	}
	const sigMeta = JSON.stringify({ cid: verified.cid });
	await db
		.prepare(
			`INSERT INTO publishers
			   (did, display_name, description, url, contact, updated_at,
			    record_blob, signature_metadata, verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(did) DO UPDATE SET
			   display_name = excluded.display_name,
			   description = excluded.description,
			   url = excluded.url,
			   contact = excluded.contact,
			   updated_at = excluded.updated_at,
			   record_blob = excluded.record_blob,
			   signature_metadata = excluded.signature_metadata,
			   verified_at = excluded.verified_at`,
		)
		.bind(
			job.did,
			record.displayName,
			record.description ?? null,
			record.url ?? null,
			record.contact ? JSON.stringify(record.contact) : null,
			record.updatedAt ?? null,
			verified.carBytes,
			sigMeta,
			now.toISOString(),
		)
		.run();
}

export async function ingestPublisherVerification(
	db: D1Database,
	job: RecordsJob,
	verified: VerifiedPdsRecord,
	now: Date,
): Promise<void> {
	const validation = safeParse(PublisherVerification.mainSchema, verified.record);
	if (!validation.ok) {
		throw new IngestError(
			"LEXICON_VALIDATION_FAILED",
			"publisher.verification failed lexicon validation",
			formatValidationIssues(validation.issues),
		);
	}
	const record = validation.value;
	const sigMeta = JSON.stringify({ cid: verified.cid });
	await db
		.prepare(
			`INSERT INTO publisher_verifications
			   (issuer_did, rkey, subject_did, subject_handle, subject_display_name,
			    created_at, expires_at, record_blob, signature_metadata, verified_at, tombstoned_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT(issuer_did, rkey) DO UPDATE SET
			   subject_did = excluded.subject_did,
			   subject_handle = excluded.subject_handle,
			   subject_display_name = excluded.subject_display_name,
			   created_at = excluded.created_at,
			   expires_at = excluded.expires_at,
			   record_blob = excluded.record_blob,
			   signature_metadata = excluded.signature_metadata,
			   verified_at = excluded.verified_at,
			   tombstoned_at = NULL`,
		)
		.bind(
			job.did,
			job.rkey,
			record.subject,
			record.handle,
			record.displayName,
			record.createdAt,
			record.expiresAt ?? null,
			verified.carBytes,
			sigMeta,
			now.toISOString(),
		)
		.run();
}

// ─── Delete handling ────────────────────────────────────────────────────────

export async function applyDelete(db: D1Database, job: RecordsJob, now: Date): Promise<void> {
	switch (job.collection) {
		case NSID.packageProfile:
			// Hard-delete the profile. Releases hang off the profile via FK; we
			// don't cascade because doing so silently throws away publication
			// history. Operators inspecting an "orphaned" release row can tell
			// the publisher deleted the profile.
			await db
				.prepare(`DELETE FROM packages WHERE did = ? AND slug = ?`)
				.bind(job.did, job.rkey)
				.run();
			return;
		case NSID.packageRelease: {
			// Releases are version-immutable but a publisher CAN delete them
			// (yanking from the source). Soft-delete: read APIs filter on
			// `tombstoned_at IS NULL` so they disappear from listings.
			// Parse rkey back to (package, version) so we hit the PK index
			// instead of the partial idx_releases_latest, which has to scan
			// for did=? then filter by rkey.
			const parsed = parseReleaseRkey(job.rkey);
			if (!parsed) return;
			const result = await db
				.prepare(
					`UPDATE releases SET tombstoned_at = ?
					 WHERE did = ? AND package = ? AND version = ? AND tombstoned_at IS NULL`,
				)
				.bind(now.toISOString(), job.did, parsed.pkg, parsed.version)
				.run();
			if (result.meta.changes > 0) {
				// Tombstoning may have removed the latest release; recompute.
				await refreshPackageLatest(db, job.did, parsed.pkg);
			}
			return;
		}
		case NSID.publisherProfile:
			// Hard-delete; one-per-DID, no audit value in retaining it.
			await db.prepare(`DELETE FROM publishers WHERE did = ?`).bind(job.did).run();
			return;
		case NSID.publisherVerification:
			// Soft-delete to preserve the audit trail. `(issuer_did, rkey)`
			// is the AT-URI primary key.
			await db
				.prepare(
					`UPDATE publisher_verifications SET tombstoned_at = ?
					 WHERE issuer_did = ? AND rkey = ? AND tombstoned_at IS NULL`,
				)
				.bind(now.toISOString(), job.did, job.rkey)
				.run();
			return;
		default:
			// Reach here only if a future collection is added to
			// WANTED_COLLECTIONS without an applyDelete arm. Throw so the
			// dispatcher writes a dead_letters row instead of silently
			// dropping the delete — silent drops let the table drift out of
			// sync with the publisher's repo until someone notices the
			// inconsistency.
			throw new IngestError(
				"UNKNOWN_COLLECTION",
				`delete for unhandled collection: ${job.collection}`,
				job.collection,
			);
	}
}

// ─── Forensics ─────────────────────────────────────────────────────────────

async function writeDeadLetter(
	db: D1Database,
	job: RecordsJob,
	reason: DeadLetterReason,
	detail: string | null,
	now: Date,
): Promise<void> {
	// `payload` holds whatever Jetstream gave us, encoded as JSON. If the job
	// didn't carry a jetstreamRecord (delete operations don't), store the
	// envelope of operation+cid so the row is still inspectable.
	const payload = JSON.stringify(job.jetstreamRecord ?? { operation: job.operation, cid: job.cid });
	const payloadBytes = new TextEncoder().encode(payload);
	await db
		.prepare(
			`INSERT INTO dead_letters
			   (did, collection, rkey, reason, detail, payload, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(job.did, job.collection, job.rkey, reason, detail, payloadBytes, now.toISOString())
		.run();
}

// ─── Production wiring ─────────────────────────────────────────────────────

function createProductionDeps(env: Env): ConsumerDeps {
	const composite = new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver(),
			web: new AtprotoWebDidDocumentResolver(),
		},
	});
	return {
		db: env.DB,
		resolver: new DidResolver({
			cache: createD1DidDocCache(env.DB),
			resolver: composite,
		}),
	};
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Translate a permanent `PdsVerificationError.reason` to its `DeadLetterReason`
 * counterpart. The parameter type is the imported `VerificationFailureReason`
 * union so a new variant added in `pds-verify.ts` becomes a compile-time
 * error here. Transient reasons (PDS_NETWORK_ERROR today) are unreachable
 * because the caller filters them via `isTransient`; we throw rather than
 * silently dead-letter to surface the broken invariant loudly.
 */
function mapPdsReason(reason: VerificationFailureReason): DeadLetterReason {
	switch (reason) {
		case "RECORD_NOT_FOUND":
		case "RESPONSE_TOO_LARGE":
		case "INVALID_PROOF":
		case "PDS_HTTP_ERROR":
			return reason;
		case "PDS_NETWORK_ERROR":
			throw new Error(
				"unreachable: PDS_NETWORK_ERROR should have been retried by isTransient before reaching mapPdsReason",
			);
		default: {
			const exhaustive: never = reason;
			throw new Error(`unhandled PdsVerificationError reason: ${String(exhaustive)}`);
		}
	}
}

/**
 * Encode a semver version string for use in the release rkey per the lexicon's
 * `<package>:<encoded-version>` rule. Atproto rkeys allow `[A-Za-z0-9._~-]`;
 * semver versions can include `+` for build metadata which must be
 * percent-encoded. Our lexicon disallows `+` so this is conservative.
 */
const PACKAGE_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PLUS_RE = /\+/g;
function encodeRkeyVersion(version: string): string {
	return version.replace(PLUS_RE, "%2B");
}

/**
 * Parse a release rkey of the form `<package>:<encoded-version>` back into its
 * components. Returns null on malformed input — callers should treat that as
 * "this isn't a release we recognise" and no-op.
 *
 * Splits on the FIRST `:`. Both `package` (slug regex) and `version` (semver
 * subset) reject `:` in the lexicon, so a single split is unambiguous.
 */
function parseReleaseRkey(rkey: string): { pkg: string; version: string } | null {
	const idx = rkey.indexOf(":");
	if (idx <= 0 || idx === rkey.length - 1) return null;
	const pkg = rkey.slice(0, idx);
	const encodedVersion = rkey.slice(idx + 1);
	const version = decodeURIComponent(encodedVersion);
	return { pkg, version };
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const NUMERIC_RE = /^\d+$/;
const pad = (s: string) => s.padStart(10, "0");

/**
 * Pre-compute a fixed-width sortable string for a semver version.
 *
 * Format: `<10-digit-major>.<10-digit-minor>.<10-digit-patch>.<prerelease-or-zzz>`
 *
 * - Numeric components are zero-padded to 10 digits so lexicographic sort
 *   matches numeric order ('1.10.0' > '1.9.0').
 * - The prerelease tag uses 'zzz' as a sentinel for non-prerelease so finals
 *   outrank any prerelease at the same major.minor.patch.
 * - Within a prerelease tag, numeric identifiers are zero-padded too. This
 *   matches semver precedence rules approximately; the "numeric < non-numeric"
 *   wrinkle isn't fully captured but the typical patterns ('rc.1', 'beta.2')
 *   sort correctly.
 *
 * Returns null when the input doesn't parse as our supported semver subset
 * (the lexicon disallows build metadata '+...').
 */
function computeVersionSort(version: string): string | null {
	const m = SEMVER_RE.exec(version);
	if (!m) return null;
	const major = m[1] ?? "0";
	const minor = m[2] ?? "0";
	const patch = m[3] ?? "0";
	const pre = m[4];
	if (major.length > 10 || minor.length > 10 || patch.length > 10) {
		// 10-digit pad ceiling — versions past this can't be ordered correctly
		// by simple zero-padding. ~10 billion is well past reasonable.
		return null;
	}
	if (pre) {
		const parts = pre.split(".");
		const padded: string[] = [];
		for (const p of parts) {
			if (NUMERIC_RE.test(p)) {
				if (p.length > 10) return null; // same ceiling for prerelease numerics
				padded.push(pad(p));
			} else {
				padded.push(p);
			}
		}
		return `${pad(major)}.${pad(minor)}.${pad(patch)}.${padded.join(".")}`;
	}
	return `${pad(major)}.${pad(minor)}.${pad(patch)}.zzz`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function toUint8(value: ArrayBuffer | Uint8Array): Uint8Array {
	if (value instanceof Uint8Array) return value;
	return new Uint8Array(value);
}

function formatValidationIssues(issues: unknown): string {
	try {
		return JSON.stringify(issues);
	} catch {
		return String(issues);
	}
}
