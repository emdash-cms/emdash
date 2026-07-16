/**
 * Publisher-contact resolution for the notification subsystem (spec §18,
 * plan W10.4 slice A). Given a package subject, walks three contact tiers in
 * priority order and returns the first entry carrying a non-empty EMAIL — the
 * address a takedown/warning notice would be offered to. A url-only contact is
 * skipped, not treated as resolved: this channel is email, and a URL cannot
 * receive one.
 *
 * Tiers (spec order):
 *   1. package `security[]`   — required per-package security contacts.
 *   2. package `authors[]`    — author contact (email optional).
 *   3. publisher `contact[]`  — identity-level channels, preferring `kind:
 *                               security` over `general`/other within the tier.
 *
 * The reads go through the aggregator service binding ({@link AggregatorClient})
 * with a fresh single fetch per tier and NO caching — a notice must resolve
 * against the publisher's current metadata at send time. The aggregator read is
 * deliberately unfiltered (blank accept-labelers, see the client's module doc):
 * resolving a takedown contact must work even for a subject this labeler has
 * itself redacted.
 *
 * "No resolvable contact" is an expected terminal outcome (`{ none: ... }`),
 * not an error. Only a transport/aggregator failure throws, propagated from the
 * client so the caller can retry the whole resolution.
 *
 * PII: the resolved email is returned in memory for the caller to hash
 * immediately via {@link seedPublisherContact}. It is never persisted or logged
 * here — logs carry the (public) publisher DID and at most an 8-char prefix of
 * the recipient hash, matching slice C's `logOutcome`.
 */

import type { AggregatorClient } from "./aggregator-client.js";
import { ensureContact, isSuppressed, recipientHash } from "./notification-contacts.js";

/** The package subject a notice concerns. `did` is the publisher DID; it also
 * keys the tier-3 publisher-profile read. */
export interface ContactTarget {
	did: string;
	slug: string;
}

/** Which tier a resolved email came from — carried for observability and to
 * let the caller shape tier-specific copy. */
export type ContactTier = "package_security" | "package_author" | "publisher_profile";

export interface ResolvedContact {
	/** The address verbatim from the record; normalization happens at hashing
	 * time in {@link recipientHash}, so this may carry surrounding whitespace. */
	email: string;
	tier: ContactTier;
	/** Present only for `publisher_profile`: the contact channel `kind`
	 * (`security` | `general` | other), when the record carried one. */
	kind?: string;
}

/** The only expected non-resolution: every tier was walked and no entry
 * carried a non-empty email (url-only entries don't count). */
export type NoContactReason = "no_email_contact";

export type ContactResolution = ResolvedContact | { none: NoContactReason };

export async function resolvePublisherContact(
	client: AggregatorClient,
	target: ContactTarget,
): Promise<ContactResolution> {
	const pkg = await client.getPackage(target.did, target.slug);
	if (pkg) {
		const profile = asRecord(pkg.profile);
		if (profile) {
			const securityEmail = firstEmail(asArray(profile["security"]));
			if (securityEmail !== null) {
				return { email: securityEmail, tier: "package_security" };
			}
			const authorEmail = firstEmail(asArray(profile["authors"]));
			if (authorEmail !== null) {
				return { email: authorEmail, tier: "package_author" };
			}
		}
	}

	// Tier 3 is keyed by DID alone, so it is attempted even when the package
	// read misses (e.g. the package was deleted between discovery and notice)
	// — the publisher entity may still be reachable.
	const publisher = await client.getPublisher(target.did);
	if (publisher) {
		const profile = asRecord(publisher.profile);
		if (profile) {
			const preferred = preferredPublisherEmail(asArray(profile["contact"]));
			if (preferred !== null) {
				return { email: preferred.email, tier: "publisher_profile", kind: preferred.kind };
			}
		}
	}

	return { none: "no_email_contact" };
}

export type SeedSkipReason = NoContactReason | "suppressed";

export type SeedOutcome =
	| { seeded: true; recipientHash: string; tier: ContactTier }
	| { seeded: false; reason: SeedSkipReason };

/**
 * Resolve the publisher contact and seed the double-opt-in state row so slice
 * C's confirm flow can proceed. On a resolved email: hash it under the pepper
 * and {@link ensureContact} (insert-if-absent as `unconfirmed`). Sending the
 * confirmation mail is W10.5 — this only seeds the contact and returns its
 * recipient hash for the send path to use.
 *
 * Anti-abuse: a suppressed address is never seeded, so a victim who unsubscribed
 * or reported "not me" stays off the list even if named again in fresh hostile
 * metadata. `ensureContact` is insert-if-absent, so an already-confirmed or
 * declined contact is never reset to `unconfirmed`; the per-address/per-DID
 * rate limits and confirm-state machine (slices B/C) govern the rest.
 *
 * Never logs plaintext email — only the DID and a hash prefix.
 */
export async function seedPublisherContact(
	client: AggregatorClient,
	db: D1Database,
	pepper: string,
	target: ContactTarget,
	nowIso: string,
): Promise<SeedOutcome> {
	const resolution = await resolvePublisherContact(client, target);
	if ("none" in resolution) {
		logResolve(target.did, resolution.none, undefined);
		return { seeded: false, reason: resolution.none };
	}

	const hash = await recipientHash(pepper, resolution.email);
	if (await isSuppressed(db, hash)) {
		logResolve(target.did, "suppressed", hash);
		return { seeded: false, reason: "suppressed" };
	}

	await ensureContact(db, hash, nowIso);
	logResolve(target.did, `seeded:${resolution.tier}`, hash);
	return { seeded: true, recipientHash: hash, tier: resolution.tier };
}

/** First entry with a non-empty `email`, or null. Skips url-only entries and
 * anything that isn't a `{ email }`-shaped object. */
function firstEmail(entries: readonly unknown[]): string | null {
	for (const entry of entries) {
		const email = readEmail(entry);
		if (email !== null) return email;
	}
	return null;
}

/** Tier-3 selection: an entry with `kind: security` and an email wins outright;
 * otherwise the first entry carrying any email (regardless of kind). */
function preferredPublisherEmail(
	entries: readonly unknown[],
): { email: string; kind?: string } | null {
	let fallback: { email: string; kind?: string } | null = null;
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record === null) continue;
		const email = readEmail(record);
		if (email === null) continue;
		const kind = typeof record["kind"] === "string" ? record["kind"] : undefined;
		if (kind === "security") return { email, kind };
		if (fallback === null) fallback = kind === undefined ? { email } : { email, kind };
	}
	return fallback;
}

/** The `email` of a contact-shaped value, if present and non-empty after
 * trimming; otherwise null. Returns the value verbatim (untrimmed). */
function readEmail(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record === null) return null;
	const email = record["email"];
	if (typeof email !== "string") return null;
	return email.trim().length > 0 ? email : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function logResolve(did: string, outcome: string, recipientHashValue: string | undefined): void {
	console.log("[notifications]", {
		action: "resolve",
		outcome,
		did,
		hashPrefix: recipientHashValue?.slice(0, 8),
	});
}
