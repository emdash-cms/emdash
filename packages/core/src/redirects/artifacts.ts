/**
 * Published redirect artifacts.
 *
 * Enabled redirect rules are published as compact, content-addressed JSON
 * artifacts grouped into a generation. The middleware loads the active
 * generation in one query and afterwards only polls the small state row, so a
 * site with many redirects never rescans `_emdash_redirects` on the read path.
 *
 * Exact rules are sharded by a hash of their source and pattern rules are
 * chunked in precedence order, so a single rule change usually rewrites one
 * artifact. Writers bump `_emdash_redirect_state.revision` through triggers.
 * A generation that is stale or fails verification is never served: readers
 * fall back to the rules table and schedule a repair.
 */

import type { Kysely } from "kysely";

import { after } from "../after.js";
import { RedirectRepository } from "../database/repositories/redirect.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";
import {
	invalidateRedirectCache,
	type RedirectRule,
	type RedirectRuleSet,
	type RedirectSource,
} from "./cache.js";

type ArtifactKind = "exact" | "pattern";
type ArtifactEntry = [id: string, source: string, destination: string, type: number];

interface RedirectArtifact {
	digest: string;
	kind: ArtifactKind;
	payload: string;
}

interface RuleRow {
	id: string;
	source: string;
	destination: string;
	type: number;
	is_pattern: number;
}

const ARTIFACT_TARGET_BYTES = 64 * 1024;
const GENERATION_PREFIX = "emdash-redirects-v1";
const REPAIR_LEASE_MS = 60_000;
/** Three bound parameters per link row keeps each insert within D1's limit. */
const LINK_BATCH_SIZE = 30;

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fnv1a(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function toEntry(rule: RedirectRule): ArtifactEntry {
	return [rule.id, rule.source, rule.destination, rule.type];
}

function entryBytes(entry: ArtifactEntry): number {
	return encoder.encode(JSON.stringify(entry)).byteLength + 1;
}

async function createArtifact(kind: ArtifactKind, entries: ArtifactEntry[]) {
	const payload = JSON.stringify(entries);
	return { digest: await sha256Hex(`${kind}\n${payload}`), kind, payload };
}

function generationId(digests: string[]): Promise<string> {
	return sha256Hex([GENERATION_PREFIX, ...digests].join("\n"));
}

/** Splits enabled rows, in precedence order, into exact and pattern rules. */
function toRuleSet(
	rows: Array<RedirectRule & { isPattern: boolean }>,
	version: string | null,
): RedirectRuleSet {
	const exact: RedirectRule[] = [];
	const patterns: RedirectRule[] = [];
	for (const { isPattern, ...rule } of rows) {
		(isPattern ? patterns : exact).push(rule);
	}
	return { version, exact, patterns };
}

/**
 * Builds the artifacts for a rule set. Exact rules keep the last rule per
 * source, matching lookup semantics, and are sorted so the shards are
 * deterministic. Pattern rules keep precedence order across chunks.
 */
async function buildArtifacts(
	rules: RedirectRuleSet,
): Promise<{ generation: string; artifacts: RedirectArtifact[] }> {
	const bySource = new Map<string, ArtifactEntry>();
	for (const rule of rules.exact) bySource.set(rule.source, toEntry(rule));
	const exact = [...bySource.values()].toSorted((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
	const exactBytes = exact.reduce((total, entry) => total + entryBytes(entry), 0);
	const shardCount = Math.max(1, Math.ceil(exactBytes / ARTIFACT_TARGET_BYTES));
	const shards: ArtifactEntry[][] = Array.from({ length: shardCount }, () => []);
	for (const entry of exact) shards[fnv1a(entry[1]) % shardCount].push(entry);

	const artifacts: RedirectArtifact[] = [];
	for (const shard of shards) {
		if (shard.length > 0) artifacts.push(await createArtifact("exact", shard));
	}

	let chunk: ArtifactEntry[] = [];
	let chunkBytes = 0;
	for (const rule of rules.patterns) {
		const entry = toEntry(rule);
		const bytes = entryBytes(entry);
		if (chunk.length > 0 && chunkBytes + bytes > ARTIFACT_TARGET_BYTES) {
			artifacts.push(await createArtifact("pattern", chunk));
			chunk = [];
			chunkBytes = 0;
		}
		chunk.push(entry);
		chunkBytes += bytes;
	}
	if (chunk.length > 0) artifacts.push(await createArtifact("pattern", chunk));

	return {
		generation: await generationId(artifacts.map((artifact) => artifact.digest)),
		artifacts,
	};
}

/**
 * Publishes the enabled redirect rules as the active generation.
 *
 * The revision is read before the rules, so the published generation holds
 * at least the changes up to the revision it is labelled with. A publish at
 * the active revision replaces the active generation, which repairs a damaged
 * one; losing the compare-and-set to a newer revision leaves that publish
 * active.
 */
export async function publishRedirectArtifacts(db: Kysely<Database>): Promise<void> {
	const state = await db
		.selectFrom("_emdash_redirect_state")
		.select("revision")
		.where("id", "=", 1)
		.executeTakeFirst();
	if (!state) throw new Error("Redirect state row is missing");
	const revision = Number(state.revision);

	const rows: RuleRow[] = await db
		.selectFrom("_emdash_redirects")
		.select(["id", "source", "destination", "type", "is_pattern"])
		.where("enabled", "=", 1)
		.orderBy("created_at", (order) => order.asc().nullsFirst())
		.orderBy("id", "asc")
		.execute();
	const { generation, artifacts } = await buildArtifacts(
		toRuleSet(
			rows.map((row) => ({
				id: row.id,
				source: row.source,
				destination: row.destination,
				type: Number(row.type),
				isPattern: Number(row.is_pattern) === 1,
			})),
			null,
		),
	);

	await withTransaction(db, async (trx) => {
		const digests = [...new Set(artifacts.map((artifact) => artifact.digest))];
		const stored = new Map<string, string>();
		for (const batch of chunks(digests, SQL_BATCH_SIZE)) {
			const found = await trx
				.selectFrom("_emdash_redirect_artifacts")
				.select(["digest", "kind", "payload"])
				.where("digest", "in", batch)
				.execute();
			for (const row of found) stored.set(row.digest, `${row.kind}\n${row.payload}`);
		}
		for (const artifact of artifacts) {
			const content = `${artifact.kind}\n${artifact.payload}`;
			if (stored.get(artifact.digest) === content) continue;
			stored.set(artifact.digest, content);
			// A stored row that does not match its digest was damaged; rewrite it.
			await trx
				.insertInto("_emdash_redirect_artifacts")
				.values(artifact)
				.onConflict((conflict) =>
					conflict.column("digest").doUpdateSet({ kind: artifact.kind, payload: artifact.payload }),
				)
				.execute();
		}

		const links = artifacts.map((artifact, position) => ({
			generation,
			position,
			digest: artifact.digest,
		}));
		for (const batch of chunks(links, LINK_BATCH_SIZE)) {
			await trx
				.insertInto("_emdash_redirect_generation_artifacts")
				.values(batch)
				.onConflict((conflict) =>
					conflict
						.columns(["generation", "position"])
						.doUpdateSet((eb) => ({ digest: eb.ref("excluded.digest") })),
				)
				.execute();
		}
		await trx
			.deleteFrom("_emdash_redirect_generation_artifacts")
			.where("generation", "=", generation)
			.where("position", ">=", links.length)
			.execute();

		const activated = await trx
			.updateTable("_emdash_redirect_state")
			.set({ generation, generation_revision: revision })
			.where("id", "=", 1)
			.where("generation_revision", "<=", revision)
			.executeTakeFirst();
		if (BigInt(activated.numUpdatedRows) === 0n) return;

		// Another publish may have activated since this one; keep the active generation.
		await trx
			.deleteFrom("_emdash_redirect_generation_artifacts")
			.where((eb) =>
				eb(
					"generation",
					"<>",
					eb.selectFrom("_emdash_redirect_state").select("generation").where("id", "=", 1),
				),
			)
			.execute();
		await trx
			.deleteFrom("_emdash_redirect_artifacts")
			.where(({ exists, not, selectFrom }) =>
				not(
					exists(
						selectFrom("_emdash_redirect_generation_artifacts")
							.select("_emdash_redirect_generation_artifacts.digest")
							.whereRef(
								"_emdash_redirect_generation_artifacts.digest",
								"=",
								"_emdash_redirect_artifacts.digest",
							),
					),
				),
			)
			.execute();
	});
}

/**
 * Publishes after a redirect write, then invalidates this isolate's cache. A
 * failed publish is logged rather than failing the write: readers fall back
 * to the rules table and repair the stale generation.
 */
export async function publishRedirectChanges(db: Kysely<Database>): Promise<void> {
	try {
		await publishRedirectArtifacts(db);
	} catch (error) {
		console.error("[emdash:redirects] publishing redirect artifacts failed:", error);
	}
	invalidateRedirectCache();
}

function isArtifactEntry(value: unknown): value is ArtifactEntry {
	return (
		Array.isArray(value) &&
		value.length === 4 &&
		typeof value[0] === "string" &&
		typeof value[1] === "string" &&
		typeof value[2] === "string" &&
		typeof value[3] === "number"
	);
}

function parseEntries(payload: string): ArtifactEntry[] | null {
	try {
		const parsed: unknown = JSON.parse(payload);
		return Array.isArray(parsed) && parsed.every(isArtifactEntry) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Loads and verifies the active generation. Returns null when nothing is
 * published, the generation is stale, or any artifact is missing, altered, or
 * out of place.
 */
async function loadPublishedRedirects(db: Kysely<Database>): Promise<RedirectRuleSet | null> {
	const rows = await db
		.selectFrom("_emdash_redirect_state as state")
		.leftJoin(
			"_emdash_redirect_generation_artifacts as link",
			"link.generation",
			"state.generation",
		)
		.leftJoin("_emdash_redirect_artifacts as artifact", "artifact.digest", "link.digest")
		.select([
			"state.revision",
			"state.generation",
			"state.generation_revision",
			"link.position",
			"link.digest",
			"artifact.kind",
			"artifact.payload",
		])
		.where("state.id", "=", 1)
		.orderBy("link.position", "asc")
		.execute();

	const state = rows[0];
	if (!state?.generation) return null;
	if (Number(state.revision) > Number(state.generation_revision)) return null;

	const exact: RedirectRule[] = [];
	const patterns: RedirectRule[] = [];
	const digests: string[] = [];
	const links = rows.filter((row) => row.position !== null);
	for (const [index, link] of links.entries()) {
		if (
			Number(link.position) !== index ||
			!link.digest ||
			link.payload === null ||
			(link.kind !== "exact" && link.kind !== "pattern")
		) {
			return null;
		}
		if ((await sha256Hex(`${link.kind}\n${link.payload}`)) !== link.digest) {
			return null;
		}
		const entries = parseEntries(link.payload);
		if (!entries) return null;
		const target = link.kind === "exact" ? exact : patterns;
		for (const [id, source, destination, type] of entries) {
			target.push({ id, source, destination, type });
		}
		digests.push(link.digest);
	}
	if ((await generationId(digests)) !== state.generation) return null;

	return { version: state.generation, exact, patterns };
}

async function loadRulesTable(db: Kysely<Database>): Promise<RedirectRuleSet> {
	const redirects = await new RedirectRepository(db).findAllEnabled();
	return toRuleSet(
		redirects.map(({ id, source, destination, type, isPattern }) => ({
			id,
			source,
			destination,
			type,
			isPattern,
		})),
		null,
	);
}

interface RepairState {
	runningUntil: number;
}

const REPAIR_STATE_KEY = Symbol.for("emdash:redirect-artifact-repair");
const g = globalThis as Record<symbol, unknown>;
const repairState: RepairState =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[REPAIR_STATE_KEY] as RepairState | undefined) ??
	(() => {
		const state: RepairState = { runningUntil: 0 };
		g[REPAIR_STATE_KEY] = state;
		return state;
	})();

/**
 * Republishes the artifacts under a database lease so one isolate repairs a
 * stale or damaged generation while the others keep serving.
 */
async function repairRedirectArtifacts(db: Kysely<Database>): Promise<void> {
	const now = Date.now();
	const expiresAt = now + REPAIR_LEASE_MS;
	const lease = await db
		.updateTable("_emdash_redirect_state")
		.set({ repair_expires_at: expiresAt })
		.where("id", "=", 1)
		.where("repair_expires_at", "<", now)
		.executeTakeFirst();
	if (BigInt(lease.numUpdatedRows) === 0n) return;
	try {
		await publishRedirectArtifacts(db);
	} finally {
		await db
			.updateTable("_emdash_redirect_state")
			.set({ repair_expires_at: 0 })
			.where("id", "=", 1)
			.where("repair_expires_at", "=", expiresAt)
			.execute();
	}
}

function scheduleRedirectRepair(db: Kysely<Database>): void {
	const now = Date.now();
	if (repairState.runningUntil > now) return;
	const runningUntil = now + REPAIR_LEASE_MS;
	repairState.runningUntil = runningUntil;
	after(async () => {
		try {
			await repairRedirectArtifacts(db);
		} catch (error) {
			console.error("[emdash:redirects] repairing redirect artifacts failed:", error);
		} finally {
			if (repairState.runningUntil === runningUntil) repairState.runningUntil = 0;
		}
	});
}

/**
 * The rule source the middleware caches: the published generation when it is
 * current and verifies, otherwise the rules table. Before the artifact tables exist the
 * rules table is read directly.
 */
export function createRedirectSource(db: Kysely<Database>): RedirectSource {
	return {
		async load() {
			let published: RedirectRuleSet | null;
			try {
				published = await loadPublishedRedirects(db);
			} catch (error) {
				if (isMissingTableError(error)) return loadRulesTable(db);
				throw error;
			}
			if (published) return published;
			scheduleRedirectRepair(db);
			return loadRulesTable(db);
		},
		async isCurrent(version) {
			const state = await db
				.selectFrom("_emdash_redirect_state")
				.select(["revision", "generation", "generation_revision"])
				.where("id", "=", 1)
				.executeTakeFirst();
			return (
				state?.generation === version && Number(state.revision) <= Number(state.generation_revision)
			);
		},
	};
}
