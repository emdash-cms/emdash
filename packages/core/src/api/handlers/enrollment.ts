import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

type EnrollmentRow = {
	id: string;
	service_id: string;
	order_id: string | null;
	order_item_id: string | null;
	customer_id: string | null;
	quantity: number;
	starts_at: string | null;
	ends_at: string | null;
	status: string;
	customer_snapshot: string | null;
	service_snapshot: string | null;
	created_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface ShopEnrollmentSummary {
	id: string;
	serviceId: string;
	orderId: string | null;
	orderItemId: string | null;
	customerId: string | null;
	quantity: number;
	startsAt: string | null;
	endsAt: string | null;
	status: string;
	customerName: string | null;
	serviceName: string | null;
	capacity: number | null;
	enrolled: number;
	createdAt: string | null;
}

function snapshotValue(snapshot: string | null, key: string): string | null {
	if (!snapshot) return null;
	try {
		const parsed: unknown = JSON.parse(snapshot);
		if (isRecord(parsed) && key in parsed) {
			const value = parsed[key];
			return typeof value === "string" ? value : null;
		}
	} catch {
		return null;
	}
	return null;
}

function snapshotNumber(snapshot: string | null, key: string): number | null {
	if (!snapshot) return null;
	try {
		const parsed: unknown = JSON.parse(snapshot);
		if (!isRecord(parsed) || !(key in parsed)) return null;
		const value = parsed[key];
		return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function toEnrollment(row: EnrollmentRow, enrolled: number): ShopEnrollmentSummary {
	return {
		id: row.id,
		serviceId: row.service_id,
		orderId: row.order_id,
		orderItemId: row.order_item_id,
		customerId: row.customer_id,
		quantity: row.quantity,
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		status: row.status,
		customerName: snapshotValue(row.customer_snapshot, "name"),
		serviceName: snapshotValue(row.service_snapshot, "name"),
		capacity: snapshotNumber(row.service_snapshot, "capacity"),
		enrolled,
		createdAt: row.created_at ?? null,
	};
}

export async function handleShopEnrollmentList(
	db: Kysely<Database>,
	status?: string,
): Promise<ApiResult<ShopEnrollmentSummary[]>> {
	try {
		let query = db.selectFrom("_emdash_shop_enrollments").selectAll().orderBy("created_at", "desc");
		if (status && status !== "all") query = query.where("status", "=", status);
		const rows = await query.execute();
		const enrolledByService = new Map<string, number>();
		for (const row of rows) {
			if (row.status === "cancelled") continue;
			enrolledByService.set(
				row.service_id,
				(enrolledByService.get(row.service_id) ?? 0) + row.quantity,
			);
		}
		return {
			success: true,
			data: rows.map((row) => toEnrollment(row, enrolledByService.get(row.service_id) ?? 0)),
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ENROLLMENTS_ERROR", message: "Failed to list open enrollments" },
		};
	}
}

export async function handleShopEnrollmentUpdate(
	db: Kysely<Database>,
	id: string,
	status: string,
	startsAt?: string,
	endsAt?: string,
): Promise<ApiResult<ShopEnrollmentSummary>> {
	try {
		if (!["pending_schedule", "scheduled", "cancelled"].includes(status)) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: "Invalid enrollment status" },
			};
		}
		if (
			status === "scheduled" &&
			(!startsAt || !endsAt || new Date(startsAt) >= new Date(endsAt))
		) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: "A valid enrollment schedule is required" },
			};
		}
		const result = await db
			.updateTable("_emdash_shop_enrollments")
			.set({
				status,
				...(startsAt !== undefined ? { starts_at: startsAt } : {}),
				...(endsAt !== undefined ? { ends_at: endsAt } : {}),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", id)
			.executeTakeFirst();
		if (Number(result.numUpdatedRows ?? 0) === 0)
			return { success: false, error: { code: "NOT_FOUND", message: "Enrollment not found" } };
		const row = await db
			.selectFrom("_emdash_shop_enrollments")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row
			? {
					success: true,
					data: toEnrollment(row, row.status === "cancelled" ? 0 : row.quantity),
				}
			: { success: false, error: { code: "NOT_FOUND", message: "Enrollment not found" } };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ENROLLMENT_UPDATE_ERROR", message: "Failed to update open enrollment" },
		};
	}
}
