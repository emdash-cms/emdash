import type { StorageCollection } from "emdash";

import type { CommerceErrorCode } from "../kernel/errors.js";
import { inventoryStockDocId } from "../lib/inventory-stock.js";
import { LineConflictError, mergeLineItemsBySku } from "../lib/merge-line-items.js";
import { BundleSnapshotError, toInventoryDeductionLines } from "../lib/order-inventory-lines.js";
import type { OrderLineItem, StoredInventoryLedgerEntry, StoredInventoryStock } from "../types.js";

export { inventoryStockDocId };

type CollectionGetPut<T> = Pick<StorageCollection<T>, "get" | "put">;
type QueryCollection<T> = Pick<StorageCollection<T>, "query" | "put">;

type FinalizeInventoryPorts = {
	inventoryLedger: QueryCollection<StoredInventoryLedgerEntry>;
	inventoryStock: CollectionGetPut<StoredInventoryStock>;
};

export class InventoryFinalizeError extends Error {
	constructor(
		public code: CommerceErrorCode,
		message: string,
		public details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "InventoryFinalizeError";
	}
}

type InventoryMutation = {
	line: OrderLineItem;
	stockId: string;
	currentStock: StoredInventoryStock;
	nextStock: StoredInventoryStock;
	ledgerId: string;
};

function inventoryLedgerEntryId(orderId: string, productId: string, variantId: string): string {
	return `line:${encodeURIComponent(orderId)}:${encodeURIComponent(productId)}:${encodeURIComponent(variantId)}`;
}

function normalizeInventoryMutations(
	orderId: string,
	lineItems: OrderLineItem[],
	stockRows: Map<string, StoredInventoryStock>,
	nowIso: string,
): InventoryMutation[] {
	let merged: OrderLineItem[];
	try {
		merged = mergeLineItemsBySku(lineItems);
	} catch (error) {
		if (error instanceof LineConflictError) {
			throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", error.message, {
				orderId,
				reason: "line_conflict",
				productId: error.productId,
				variantId: error.variantId ?? null,
				expected: error.expected,
				actual: error.actual,
			});
		}
		const msg = error instanceof Error ? error.message : String(error);
		throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", msg, { orderId });
	}

	return merged.map((line) => {
		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const stock = stockRows.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{
					productId: line.productId,
				},
			);
		}
		if (stock.version !== line.inventoryVersion) {
			throw new InventoryFinalizeError(
				"INVENTORY_CHANGED",
				"Inventory version changed since checkout",
				{ productId: line.productId, expected: line.inventoryVersion, current: stock.version },
			);
		}
		if (stock.quantity < line.quantity) {
			throw new InventoryFinalizeError("INSUFFICIENT_STOCK", "Not enough stock to finalize order", {
				productId: line.productId,
				requested: line.quantity,
				available: stock.quantity,
			});
		}
		const variantId = line.variantId ?? "";
		return {
			line,
			stockId,
			currentStock: stock,
			nextStock: {
				...stock,
				version: stock.version + 1,
				quantity: stock.quantity - line.quantity,
				updatedAt: nowIso,
			},
			ledgerId: inventoryLedgerEntryId(orderId, line.productId, variantId),
		};
	});
}

async function applyInventoryMutation(
	ports: FinalizeInventoryPorts,
	orderId: string,
	nowIso: string,
	mutation: InventoryMutation,
): Promise<void> {
	const latest = await ports.inventoryStock.get(mutation.stockId);
	if (!latest) {
		throw new InventoryFinalizeError(
			"PRODUCT_UNAVAILABLE",
			`No inventory record for product ${mutation.line.productId}`,
			{
				productId: mutation.line.productId,
			},
		);
	}
	if (latest.version !== mutation.currentStock.version) {
		throw new InventoryFinalizeError(
			"INVENTORY_CHANGED",
			"Inventory changed between preflight and write",
			{
				productId: mutation.line.productId,
				expectedVersion: mutation.currentStock.version,
				currentVersion: latest.version,
			},
		);
	}
	if (latest.quantity < mutation.line.quantity) {
		throw new InventoryFinalizeError("INSUFFICIENT_STOCK", "Not enough stock at write time", {
			productId: mutation.line.productId,
			requested: mutation.line.quantity,
			available: latest.quantity,
		});
	}
	const entry: StoredInventoryLedgerEntry = {
		productId: mutation.line.productId,
		variantId: mutation.line.variantId ?? "",
		delta: -mutation.line.quantity,
		referenceType: "order",
		referenceId: orderId,
		createdAt: nowIso,
	};
	await ports.inventoryLedger.put(mutation.ledgerId, entry);
	await ports.inventoryStock.put(mutation.stockId, mutation.nextStock);
}

async function applyInventoryMutations(
	ports: FinalizeInventoryPorts,
	orderId: string,
	nowIso: string,
	stockRows: Map<string, StoredInventoryStock>,
	orderLines: OrderLineItem[],
): Promise<void> {
	const existing = await ports.inventoryLedger.query({
		where: { referenceType: "order", referenceId: orderId },
		limit: 1000,
	});
	const seen = new Set(existing.items.map((row) => row.id));

	let merged: OrderLineItem[];
	try {
		merged = toInventoryDeductionLines(orderLines);
	} catch (error) {
		if (error instanceof BundleSnapshotError) {
			throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", error.message, {
				reason:
					error.code === "MISSING_BUNDLE_SNAPSHOT"
						? "bundle_snapshot_incomplete"
						: "bundle_component_invalid_inventory",
				productId: error.productId,
			});
		}
		if (error instanceof LineConflictError) {
			throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", error.message, {
				reason: "line_conflict",
				productId: error.productId,
				variantId: error.variantId ?? null,
				expected: error.expected,
				actual: error.actual,
			});
		}
		const msg = error instanceof Error ? error.message : String(error);
		throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", msg, { orderId });
	}

	/**
	 * Reconcile pass: for lines where the ledger row was written but the stock
	 * write did not complete (crash between `inventoryLedger.put` and
	 * `inventoryStock.put` in `applyInventoryMutation`).
	 *
	 * `stock.version === line.inventoryVersion` means the stock was never updated
	 * despite the ledger entry existing — finish just the stock write.
	 * `stock.version > inventoryVersion` means the stock was already updated;
	 * nothing to do for that line.
	 */
	for (const line of merged) {
		const variantId = line.variantId ?? "";
		const stockId = inventoryStockDocId(line.productId, variantId);
		const ledgerId = inventoryLedgerEntryId(orderId, line.productId, variantId);
		if (!seen.has(ledgerId)) continue;
		const stock = stockRows.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{ productId: line.productId },
			);
		}
		if (stock.version === line.inventoryVersion) {
			await ports.inventoryStock.put(stockId, {
				...stock,
				version: stock.version + 1,
				quantity: stock.quantity - line.quantity,
				updatedAt: nowIso,
			});
		}
	}

	// Apply pass: lines that have no ledger entry yet.
	const linesNeedingWork: OrderLineItem[] = [];
	for (const line of merged) {
		const variantId = line.variantId ?? "";
		const ledgerId = inventoryLedgerEntryId(orderId, line.productId, variantId);
		if (seen.has(ledgerId)) continue;
		linesNeedingWork.push(line);
	}

	const planned = normalizeInventoryMutations(orderId, linesNeedingWork, stockRows, nowIso);
	for (const mutation of planned) {
		await applyInventoryMutation(ports, orderId, nowIso, mutation);
		seen.add(mutation.ledgerId);
	}
}

export function readCurrentStockRows(
	inventoryStock: CollectionGetPut<StoredInventoryStock>,
	lines: OrderLineItem[],
): Promise<Map<string, StoredInventoryStock>> {
	return (async () => {
		const out = new Map<string, StoredInventoryStock>();
		const stockLineById = new Map<string, OrderLineItem>();
		let deductionLines: OrderLineItem[];
		try {
			deductionLines = toInventoryDeductionLines(lines);
		} catch (error) {
			if (error instanceof BundleSnapshotError) {
				throw new InventoryFinalizeError(
					"ORDER_STATE_CONFLICT",
					`Unable to build inventory deduction lines: ${error.message}`,
					{
						reason:
							error.code === "MISSING_BUNDLE_SNAPSHOT"
								? "bundle_snapshot_incomplete"
								: "bundle_component_invalid_inventory",
						productId: error.productId,
					},
				);
			}
			if (error instanceof LineConflictError) {
				throw new InventoryFinalizeError(
					"ORDER_STATE_CONFLICT",
					`Unable to build inventory deduction lines: ${error.message}`,
					{
						reason: "line_conflict",
						productId: error.productId,
						variantId: error.variantId ?? null,
						expected: error.expected,
						actual: error.actual,
					},
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new InventoryFinalizeError(
				"ORDER_STATE_CONFLICT",
				`Unable to build inventory deduction lines: ${message}`,
				{
					reason: "bundle_snapshot_incomplete",
				},
			);
		}
		for (const line of deductionLines) {
			const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
			stockLineById.set(stockId, line);
		}

		const stockRows = await Promise.all(
			Array.from(stockLineById.entries()).map(async ([stockId, line]) => ({
				stockId,
				productId: line.productId,
				stock: await inventoryStock.get(stockId),
			})),
		);
		for (const { stockId, productId, stock } of stockRows) {
			if (!stock) {
				throw new InventoryFinalizeError(
					"PRODUCT_UNAVAILABLE",
					`No inventory record for product ${productId}`,
					{
						productId,
					},
				);
			}
			out.set(stockId, stock);
		}
		return out;
	})();
}

export async function applyInventoryForOrder(
	ports: FinalizeInventoryPorts,
	order: { lineItems: OrderLineItem[] },
	orderId: string,
	nowIso: string,
): Promise<void> {
	const stockRows = await readCurrentStockRows(ports.inventoryStock, order.lineItems);
	await applyInventoryMutations(ports, orderId, nowIso, stockRows, order.lineItems);
}

export function mapInventoryErrorToApiCode(code: CommerceErrorCode): CommerceErrorCode {
	return code === "PRODUCT_UNAVAILABLE" || code === "INSUFFICIENT_STOCK"
		? "PAYMENT_CONFLICT"
		: code;
}

export function isTerminalInventoryFailure(code: CommerceErrorCode): boolean {
	return (
		code === "PRODUCT_UNAVAILABLE" ||
		code === "INSUFFICIENT_STOCK" ||
		code === "INVENTORY_CHANGED" ||
		code === "ORDER_STATE_CONFLICT"
	);
}
