import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database, AuditLogTable } from "../types.js";
import { encodeCursor, decodeCursor, type FindManyResult } from "./types.js";

export type AuditAction =
	| "create"
	| "update"
	| "delete"
	| "publish"
	| "unpublish"
	| "login"
	| "logout"
	| "password_change"
	| "settings_update"
	| "schema_change";

export type AuditStatus = "success" | "failure" | "denied";

export interface AuditLog {
	id: string;
	timestamp: string;
	actorId: string | null;
	actorIp: string | null;
	action: AuditAction;
	resourceType: string | null;
	resourceId: string | null;
	details: Record<string, unknown> | null;
	status: AuditStatus | null;
}

export interface CreateAuditLogInput {
	actorId?: string;
	actorIp?: string;
	action: AuditAction;
	resourceType?: string;
	resourceId?: string;
	details?: Record<string, unknown>;
	status?: AuditStatus;
}

export interface AuditLogQuery {
	actorId?: string;
	action?: AuditAction;
	resourceType?: string;
	resourceId?: string;
	status?: AuditStatus;
	since?: string; // ISO date
	until?: string; // ISO date
	limit?: number;
	cursor?: string;
}

/**
 * Audit repository for logging system events
 *
 * Tracks user actions for security, debugging, and compliance.
 * All mutations should create an audit log entry.
 */
export class AuditRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create an audit log entry
	 */
	async log(input: CreateAuditLogInput): Promise<AuditLog> {
		const id = ulid();

		const row: Omit<AuditLogTable, "timestamp"> = {
			id,
			actor_id: input.actorId ?? null,
			actor_ip: input.actorIp ?? null,
			action: input.action,
			resource_type: input.resourceType ?? null,
			resource_id: input.resourceId ?? null,
			details: input.details ? JSON.stringify(input.details) : null,
			status: input.status ?? null,
		};

		await this.db.insertInto("audit_logs").values(row).execute();

		const log = await this.findById(id);
		if (!log) {
			throw new Error("Failed to create audit log");
		}
		return log;
	}

	/**
	 * Find audit log by ID
	 */
	async findById(id: string): Promise<AuditLog | null> {
		const row = await this.db
			.selectFrom("audit_logs")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();

		return row ? this.rowToAuditLog(row) : null;
	}

	/**
	 * Query audit logs with filters and cursor-based pagination
	 */
	async findMany(query: AuditLogQuery = {}): Promise<FindManyResult<AuditLog>> {
		const limit = Math.min(Math.max(1, query.limit || 50), 100);

		let q = this.db
			.selectFrom("audit_logs")
			.selectAll()
			.orderBy("timestamp", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		if (query.actorId) {
			q = q.where("actor_id", "=", query.actorId);
		}

		if (query.action) {
			q = q.where("action", "=", query.action);
		}

		if (query.resourceType) {
			q = q.where("resource_type", "=", query.resourceType);
		}

		if (query.resourceId) {
			q = q.where("resource_id", "=", query.resourceId);
		}

		if (query.status) {
			q = q.where("status", "=", query.status);
		}

		if (query.since) {
			q = q.where("timestamp", ">=", query.since);
		}

		if (query.until) {
			q = q.where("timestamp", "<=", query.until);
		}

		if (query.cursor) {
			const decoded = decodeCursor(query.cursor);
			q = q.where((eb) =>
				eb.or([
					eb("timestamp", "<", decoded.orderValue),
					eb.and([eb("timestamp", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
				]),
			);
		}

		const rows = await q.execute();
		const items = rows.slice(0, limit).map((row) => this.rowToAuditLog(row));
		const result: FindManyResult<AuditLog> = { items };

		if (rows.length > limit && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.timestamp, last.id);
		}

		return result;
	}

	/**
	 * Get all logs for a specific resource
	 */
	async findByResource(
		resourceType: string,
		resourceId: string,
		options: { limit?: number } = {},
	): Promise<AuditLog[]> {
		let query = this.db
			.selectFrom("audit_logs")
			.selectAll()
			.where("resource_type", "=", resourceType)
			.where("resource_id", "=", resourceId)
			.orderBy("timestamp", "desc");

		if (options.limit) {
			query = query.limit(options.limit);
		}

		const rows = await query.execute();
		return rows.map((row) => this.rowToAuditLog(row));
	}

	/**
	 * Get all logs for a specific user
	 */
	async findByActor(
		actorId: string,
		options: { limit?: number; since?: string } = {},
	): Promise<AuditLog[]> {
		let query = this.db
			.selectFrom("audit_logs")
			.selectAll()
			.where("actor_id", "=", actorId)
			.orderBy("timestamp", "desc");

		if (options.since) {
			query = query.where("timestamp", ">=", options.since);
		}

		if (options.limit) {
			query = query.limit(options.limit);
		}

		const rows = await query.execute();
		return rows.map((row) => this.rowToAuditLog(row));
	}

	/**
	 * Count logs matching a query
	 */
	async count(query: Omit<AuditLogQuery, "limit" | "cursor"> = {}): Promise<number> {
		let q = this.db.selectFrom("audit_logs").select((eb) => eb.fn.count("id").as("count"));

		if (query.actorId) {
			q = q.where("actor_id", "=", query.actorId);
		}

		if (query.action) {
			q = q.where("action", "=", query.action);
		}

		if (query.resourceType) {
			q = q.where("resource_type", "=", query.resourceType);
		}

		if (query.resourceId) {
			q = q.where("resource_id", "=", query.resourceId);
		}

		if (query.status) {
			q = q.where("status", "=", query.status);
		}

		if (query.since) {
			q = q.where("timestamp", ">=", query.since);
		}

		if (query.until) {
			q = q.where("timestamp", "<=", query.until);
		}

		const result = await q.executeTakeFirst();
		return Number(result?.count || 0);
	}

	/**
	 * Delete old audit logs (for retention policy)
	 */
	async deleteOlderThan(date: string): Promise<number> {
		const result = await this.db
			.deleteFrom("audit_logs")
			.where("timestamp", "<", date)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Convert database row to AuditLog object
	 */
	private rowToAuditLog(row: {
		id: string;
		timestamp: string;
		actor_id: string | null;
		actor_ip: string | null;
		action: string;
		resource_type: string | null;
		resource_id: string | null;
		details: string | null;
		status: string | null;
	}): AuditLog {
		return {
			id: row.id,
			timestamp: row.timestamp,
			actorId: row.actor_id,
			actorIp: row.actor_ip,
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DB stores string; validated at insert but linter can't follow
			action: row.action as AuditAction,
			resourceType: row.resource_type,
			resourceId: row.resource_id,
			details: row.details ? JSON.parse(row.details) : null,
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DB stores string; validated at insert but linter can't follow
			status: row.status as AuditStatus | null,
		};
	}
}
