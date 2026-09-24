/**
 * Audit log entries for transfer actions. Entries carry operation and
 * approval ids, digests, counts, and error codes, never package content.
 */

import type { Kysely } from "kysely";

import {
	AuditRepository,
	type AuditAction,
	type AuditStatus,
} from "../database/repositories/audit.js";
import type { Database } from "../database/types.js";

export interface TransferAuditEntry {
	actorId: string;
	action: Extract<AuditAction, `transfer_${string}`>;
	resourceType: "transfer_operation" | "transfer_approval";
	resourceId: string;
	details?: Record<string, string | number | null>;
	status?: AuditStatus;
}

/**
 * Write an audit entry for a transfer action that has already taken effect.
 * A failed write is logged, not thrown, so it never reports a completed
 * action as failed.
 */
export async function recordTransferAudit(
	db: Kysely<Database>,
	entry: TransferAuditEntry,
): Promise<void> {
	try {
		await new AuditRepository(db).log({ status: "success", ...entry });
	} catch (error) {
		console.error("[transfer] Failed to write an audit log entry:", error);
	}
}
