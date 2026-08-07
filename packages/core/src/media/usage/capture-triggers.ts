import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres, tableExists } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";

const POSTGRES_TRIGGER_FUNCTION = "emdash_media_usage_capture_work";
const POSTGRES_IDENTIFIER_LIMIT = 63;
const CAPTURE_TRIGGER_VERSION = 1;
const OWNED_TRIGGER_PREFIX = "emdash_mu_";
const WHITESPACE_PATTERN = /\s+/g;
const TRAILING_SEMICOLON_PATTERN = /;$/;

export interface MediaUsageCaptureIdentity {
	collectionId: string;
	collectionSlug: string;
}

type CaptureOperation = "insert" | "update" | "delete";

export async function installMediaUsageCaptureTriggers(
	db: Kysely<Database>,
	identity: MediaUsageCaptureIdentity,
	options: { replaceExisting?: boolean } = {},
): Promise<void> {
	const identifiers = await captureIdentifiers(identity);
	if (isPostgres(db)) await installPostgresFunction(db);
	const installedNames = await listOwnedCaptureTriggers(db, identifiers.tableName);
	if (await hasExactCaptureTriggers(db, identifiers, identity, installedNames)) {
		return;
	}

	await assertCaptureLifecycle(db, identity, ["installing"]);
	const expectedNames = new Set(Object.values(identifiers.triggerNames));
	const retainedNames = new Set(
		options.replaceExisting === false
			? installedNames.filter((name) => expectedNames.has(name))
			: [],
	);
	await removeCaptureTriggers(
		db,
		identifiers.tableName,
		installedNames.filter((name) => !retainedNames.has(name)),
	);

	for (const operation of captureOperations) {
		if (retainedNames.has(identifiers.triggerNames[operation])) continue;
		if (isPostgres(db)) {
			await postgresCreateTrigger(
				db,
				identifiers.tableName,
				identifiers.triggerNames[operation],
				operation,
				identity,
			);
		} else {
			await sqliteCreateTrigger(
				db,
				identifiers.tableName,
				identifiers.triggerNames[operation],
				operation,
				identity,
			);
		}
	}

	await assertExpectedTriggerSet(db, identifiers, identity);
}

export async function verifyMediaUsageCaptureTriggers(
	db: Kysely<Database>,
	identity: MediaUsageCaptureIdentity,
): Promise<boolean> {
	const identifiers = await captureIdentifiers(identity);
	if (!(await tableExists(db, identifiers.tableName))) return false;
	return hasExactCaptureTriggers(
		db,
		identifiers,
		identity,
		await listOwnedCaptureTriggers(db, identifiers.tableName),
	);
}

export async function removeMediaUsageCaptureTriggers(
	db: Kysely<Database>,
	identity: MediaUsageCaptureIdentity,
): Promise<void> {
	const identifiers = await captureIdentifiers(identity);
	if (!(await tableExists(db, identifiers.tableName))) return;
	await assertCaptureLifecycle(db, identity, ["installing", "deleting"]);
	await removeCaptureTriggers(
		db,
		identifiers.tableName,
		await listOwnedCaptureTriggers(db, identifiers.tableName),
	);
}

const captureOperations: readonly CaptureOperation[] = ["insert", "update", "delete"];

async function captureIdentifiers(identity: MediaUsageCaptureIdentity): Promise<{
	tableName: string;
	triggerNames: Record<CaptureOperation, string>;
}> {
	validateIdentifier(identity.collectionSlug, "collection slug");
	const tableName = `ec_${identity.collectionSlug}`;
	validateIdentifier(tableName, "content table");

	const digest = await identityDigest(
		`${CAPTURE_TRIGGER_VERSION}:${identity.collectionId}:${identity.collectionSlug}`,
	);
	const triggerNames = {
		insert: `emdash_mu_${digest}_ai`,
		update: `emdash_mu_${digest}_au`,
		delete: `emdash_mu_${digest}_ad`,
	};
	for (const triggerName of Object.values(triggerNames)) {
		validateIdentifier(triggerName, "media usage trigger");
		if (triggerName.length > POSTGRES_IDENTIFIER_LIMIT) {
			throw new Error(`Media usage trigger name exceeds ${POSTGRES_IDENTIFIER_LIMIT} bytes`);
		}
	}

	return { tableName, triggerNames };
}

async function identityDigest(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function removeCaptureTriggers(
	db: Kysely<Database>,
	tableName: string,
	triggerNames: readonly string[],
): Promise<void> {
	for (const triggerName of triggerNames) {
		validateIdentifier(triggerName, "media usage trigger");
		if (isPostgres(db)) {
			await sql`
				DROP TRIGGER IF EXISTS ${sql.ref(triggerName)} ON ${sql.ref(tableName)}
			`.execute(db);
		} else {
			await sql`DROP TRIGGER IF EXISTS ${sql.ref(triggerName)}`.execute(db);
		}
	}
}

async function listOwnedCaptureTriggers(
	db: Kysely<Database>,
	tableName: string,
): Promise<string[]> {
	if (isPostgres(db)) {
		const result = await sql<{ name: string }>`
			SELECT trigger.tgname AS name
			FROM pg_trigger AS trigger
			INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
			INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = current_schema()
				AND relation.relname = ${tableName}
				AND NOT trigger.tgisinternal
				AND left(trigger.tgname, 10) = ${OWNED_TRIGGER_PREFIX}
		`.execute(db);
		return result.rows.map((row) => row.name);
	}

	const result = await sql<{ name: string }>`
		SELECT name
		FROM sqlite_master
		WHERE type = 'trigger'
			AND tbl_name = ${tableName}
			AND substr(name, 1, 10) = ${OWNED_TRIGGER_PREFIX}
	`.execute(db);
	return result.rows.map((row) => row.name);
}

async function hasExactCaptureTriggers(
	db: Kysely<Database>,
	identifiers: {
		tableName: string;
		triggerNames: Record<CaptureOperation, string>;
	},
	identity: MediaUsageCaptureIdentity,
	installedNames: readonly string[],
): Promise<boolean> {
	const expectedNames = new Set(Object.values(identifiers.triggerNames));
	if (
		installedNames.length !== expectedNames.size ||
		installedNames.some((name) => !expectedNames.has(name))
	) {
		return false;
	}

	if (isPostgres(db)) {
		const result = await sql<{
			name: string;
			trigger_type: number;
			function_name: string;
			arguments_hex: string;
			enabled: string;
			has_when: boolean;
		}>`
			SELECT
				trigger.tgname AS name,
				trigger.tgtype AS trigger_type,
				procedure.proname AS function_name,
				encode(trigger.tgargs, 'hex') AS arguments_hex,
				trigger.tgenabled AS enabled,
				trigger.tgqual IS NOT NULL AS has_when
			FROM pg_trigger AS trigger
			INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
			INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			INNER JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
			INNER JOIN pg_namespace AS function_namespace ON function_namespace.oid = procedure.pronamespace
			WHERE namespace.nspname = current_schema()
				AND function_namespace.nspname = current_schema()
				AND relation.relname = ${identifiers.tableName}
				AND NOT trigger.tgisinternal
				AND trigger.tgconstraint = 0
				AND NOT trigger.tgdeferrable
				AND NOT trigger.tginitdeferred
				AND trigger.tgattr = ''::int2vector
				AND left(trigger.tgname, 10) = ${OWNED_TRIGGER_PREFIX}
		`.execute(db);
		const expectedArguments = triggerArgumentsHex(identity);
		return captureOperations.every((operation) => {
			const row = result.rows.find(
				(candidate) => candidate.name === identifiers.triggerNames[operation],
			);
			return (
				row?.function_name === POSTGRES_TRIGGER_FUNCTION &&
				Number(row.trigger_type) === postgresTriggerType(operation) &&
				row.arguments_hex === expectedArguments &&
				row.enabled === "O" &&
				row.has_when === false
			);
		});
	}

	const result = await sql<{ name: string; definition: string }>`
		SELECT name, sql AS definition
		FROM sqlite_master
		WHERE type = 'trigger'
			AND tbl_name = ${identifiers.tableName}
			AND substr(name, 1, 10) = ${OWNED_TRIGGER_PREFIX}
	`.execute(db);
	return captureOperations.every((operation) => {
		const row = result.rows.find(
			(candidate) => candidate.name === identifiers.triggerNames[operation],
		);
		const contentId = operation === "delete" ? sql`OLD.id` : sql`NEW.id`;
		const expected = sqliteTriggerSql(
			identifiers.tableName,
			identifiers.triggerNames[operation],
			operationSql(operation),
			contentId,
			identity,
		).compile(db).sql;
		return row ? normalizeDdl(row.definition) === normalizeDdl(expected) : false;
	});
}

function triggerArgumentsHex(identity: MediaUsageCaptureIdentity): string {
	const bytes = new TextEncoder().encode(`${identity.collectionId}\0${identity.collectionSlug}\0`);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function postgresTriggerType(operation: CaptureOperation): number {
	switch (operation) {
		case "insert":
			return 5;
		case "update":
			return 17;
		case "delete":
			return 9;
	}
}

function normalizeDdl(definition: string): string {
	return definition.replace(WHITESPACE_PATTERN, " ").trim().replace(TRAILING_SEMICOLON_PATTERN, "");
}

async function assertCaptureLifecycle(
	db: Kysely<Database>,
	identity: MediaUsageCaptureIdentity,
	allowedStates: readonly string[],
): Promise<void> {
	const lifecycle = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select("capture_state")
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", identity.collectionSlug)
		.where("collection_id", "=", identity.collectionId)
		.executeTakeFirst();
	if (!lifecycle?.capture_state || !allowedStates.includes(lifecycle.capture_state)) {
		throw new Error("Media usage capture trigger changes require a fenced collection lifecycle");
	}
}

async function assertExpectedTriggerSet(
	db: Kysely<Database>,
	identifiers: {
		tableName: string;
		triggerNames: Record<CaptureOperation, string>;
	},
	identity: MediaUsageCaptureIdentity,
): Promise<void> {
	const actual = await listOwnedCaptureTriggers(db, identifiers.tableName);
	if (!(await hasExactCaptureTriggers(db, identifiers, identity, actual))) {
		throw new Error("Media usage capture trigger installation is incomplete");
	}
}

async function installPostgresFunction(db: Kysely<Database>): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION ${sql.ref(POSTGRES_TRIGGER_FUNCTION)}()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		DECLARE
			v_collection_id text := TG_ARGV[0];
			v_collection_slug text := TG_ARGV[1];
			v_content_id text;
			v_epoch bigint;
			v_now text := to_char(
				clock_timestamp() AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			);
		BEGIN
			IF TG_OP = 'DELETE' THEN
				v_content_id := OLD.id;
			ELSE
				v_content_id := NEW.id;
			END IF;

			UPDATE _emdash_media_usage_index_status
			SET change_epoch = change_epoch + 1,
				status = CASE WHEN status = 'complete' THEN 'stale' ELSE status END,
				completed_at = CASE WHEN status = 'complete' THEN NULL ELSE completed_at END,
				updated_at = v_now
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND scope_key = v_collection_slug
				AND collection_id = v_collection_id
				AND capture_state = 'active'
				AND EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = v_collection_id
						AND collection.slug = v_collection_slug
				)
			RETURNING change_epoch INTO v_epoch;

			IF NOT FOUND THEN
				RAISE EXCEPTION USING
					ERRCODE = 'P0001',
					MESSAGE = 'media usage capture inactive';
			END IF;

			INSERT INTO _emdash_media_usage_work (
				collection_id,
				collection_slug,
				content_id,
				change_epoch,
				work_version,
				state,
				attempt_count,
				next_attempt_at,
				lease_token,
				lease_expires_at,
				last_attempted_at,
				last_error_code,
				created_at,
				updated_at
			)
			VALUES (
				v_collection_id,
				v_collection_slug,
				v_content_id,
				v_epoch,
				1,
				'pending',
				0,
				v_now,
				NULL,
				NULL,
				NULL,
				NULL,
				v_now,
				v_now
			)
			ON CONFLICT (collection_id, content_id) DO UPDATE SET
				collection_slug = EXCLUDED.collection_slug,
				change_epoch = EXCLUDED.change_epoch,
				work_version = _emdash_media_usage_work.work_version + 1,
				state = 'pending',
				attempt_count = 0,
				next_attempt_at = EXCLUDED.next_attempt_at,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_attempted_at = NULL,
				last_error_code = NULL,
				updated_at = EXCLUDED.updated_at;

			RETURN NULL;
		END;
		$function$
	`.execute(db);
}

async function postgresCreateTrigger(
	db: Kysely<Database>,
	tableName: string,
	triggerName: string,
	operation: CaptureOperation,
	identity: MediaUsageCaptureIdentity,
): Promise<void> {
	await sql`
		CREATE TRIGGER ${sql.ref(triggerName)}
		AFTER ${operationSql(operation)} ON ${sql.ref(tableName)}
		FOR EACH ROW
		EXECUTE FUNCTION ${sql.ref(POSTGRES_TRIGGER_FUNCTION)}(
			${sql.lit(identity.collectionId)},
			${sql.lit(identity.collectionSlug)}
		)
	`.execute(db);
}

async function sqliteCreateTrigger(
	db: Kysely<Database>,
	tableName: string,
	triggerName: string,
	operation: CaptureOperation,
	identity: MediaUsageCaptureIdentity,
): Promise<void> {
	const contentId = operation === "delete" ? sql`OLD.id` : sql`NEW.id`;
	await sqliteTriggerSql(
		tableName,
		triggerName,
		operationSql(operation),
		contentId,
		identity,
	).execute(db);
}

function sqliteTriggerSql(
	tableName: string,
	triggerName: string,
	operation: RawBuilder<unknown>,
	contentId: RawBuilder<unknown>,
	identity: MediaUsageCaptureIdentity,
): RawBuilder<unknown> {
	return sql`
		CREATE TRIGGER ${sql.ref(triggerName)}
		AFTER ${operation} ON ${sql.ref(tableName)}
		FOR EACH ROW
		BEGIN
			UPDATE _emdash_media_usage_index_status
			SET change_epoch = change_epoch + 1,
				status = CASE WHEN status = 'complete' THEN 'stale' ELSE status END,
				completed_at = CASE WHEN status = 'complete' THEN NULL ELSE completed_at END,
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND scope_key = ${sql.lit(identity.collectionSlug)}
				AND collection_id = ${sql.lit(identity.collectionId)}
				AND capture_state = 'active'
				AND EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${sql.lit(identity.collectionId)}
						AND collection.slug = ${sql.lit(identity.collectionSlug)}
				);

			SELECT CASE
				WHEN changes() <> 1 THEN RAISE(ABORT, 'media usage capture inactive')
			END;

			INSERT INTO _emdash_media_usage_work (
				collection_id,
				collection_slug,
				content_id,
				change_epoch,
				work_version,
				state,
				attempt_count,
				next_attempt_at,
				lease_token,
				lease_expires_at,
				last_attempted_at,
				last_error_code,
				created_at,
				updated_at
			)
			SELECT
				${sql.lit(identity.collectionId)},
				${sql.lit(identity.collectionSlug)},
				${contentId},
				change_epoch,
				1,
				'pending',
				0,
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
				NULL,
				NULL,
				NULL,
				NULL,
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			FROM _emdash_media_usage_index_status
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND scope_key = ${sql.lit(identity.collectionSlug)}
				AND collection_id = ${sql.lit(identity.collectionId)}
				AND capture_state = 'active'
			ON CONFLICT (collection_id, content_id) DO UPDATE SET
				collection_slug = excluded.collection_slug,
				change_epoch = excluded.change_epoch,
				work_version = _emdash_media_usage_work.work_version + 1,
				state = 'pending',
				attempt_count = 0,
				next_attempt_at = excluded.next_attempt_at,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_attempted_at = NULL,
				last_error_code = NULL,
				updated_at = excluded.updated_at;
		END
	`;
}

function operationSql(operation: CaptureOperation): RawBuilder<unknown> {
	switch (operation) {
		case "insert":
			return sql`INSERT`;
		case "update":
			return sql`UPDATE`;
		case "delete":
			return sql`DELETE`;
	}
}
