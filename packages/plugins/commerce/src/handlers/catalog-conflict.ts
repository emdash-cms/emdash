import type { StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

export type Collection<T> = StorageCollection<T>;

export type CollectionWithUniqueInsert<T> = Collection<T> & {
	putIfAbsent?: (id: string, data: T) => Promise<boolean>;
};

export type ConflictHint = {
	where: Record<string, unknown>;
	message: string;
};

export const getNowIso = (): string => {
	return new Date(Date.now()).toISOString();
};

export const asCollection = <T>(raw: unknown): Collection<T> => {
	return raw as Collection<T>;
};

export const asOptionalCollection = <T>(raw: unknown): Collection<T> | null => {
	return raw ? (raw as Collection<T>) : null;
};

function looksLikeUniqueConstraintMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("unique constraint failed") ||
		normalized.includes("uniqueness violation") ||
		normalized.includes("duplicate key value violates unique constraint") ||
		normalized.includes("duplicate entry") ||
		normalized.includes("constraint failed:") ||
		normalized.includes("sqlerrorcode=primarykey")
	);
}

export function readErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const maybeCode = (error as Record<string, unknown>).code;
	if (typeof maybeCode === "string" && maybeCode.length > 0) {
		return maybeCode;
	}
	if (typeof maybeCode === "number") {
		return String(maybeCode);
	}
	const maybeCause = (error as Record<string, unknown>).cause;
	return typeof maybeCause === "object" ? readErrorCode(maybeCause) : undefined;
}

export const isUniqueConstraintViolation = (error: unknown, seen = new Set<unknown>()): boolean => {
	if (error == null || seen.has(error)) return false;
	seen.add(error);

	if (readErrorCode(error) === "23505") return true;

	if (error instanceof Error) {
		if (looksLikeUniqueConstraintMessage(error.message)) return true;
		return isUniqueConstraintViolation((error as Error & { cause?: unknown }).cause, seen);
	}

	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		const message = record.message;
		if (typeof message === "string" && looksLikeUniqueConstraintMessage(message)) return true;
		const cause = record.cause;
		if (cause) {
			return isUniqueConstraintViolation(cause, seen);
		}
	}

	return false;
};

const throwConflict = (message: string): never => {
	throw PluginRouteError.badRequest(message);
};

export async function assertNoConflict<T extends object>(
	collection: Collection<T>,
	where: Record<string, unknown>,
	excludeId?: string,
	message = "Resource already exists",
): Promise<void> {
	const result = await collection.query({ where, limit: 2 } as Parameters<Collection<T>["query"]>[0]);
	for (const item of result.items) {
		if (item.id !== excludeId) {
			throwConflict(message);
		}
	}
}

export async function putWithConflictHandling<T extends object>(
	collection: CollectionWithUniqueInsert<T>,
	id: string,
	data: T,
	conflict?: ConflictHint,
): Promise<void> {
	if (collection.putIfAbsent) {
		try {
			const inserted = await collection.putIfAbsent(id, data);
			if (!inserted) {
				throwConflict(conflict?.message ?? "Resource already exists");
			}
			return;
		} catch (error) {
			if (isUniqueConstraintViolation(error) && conflict) {
				throwConflict(conflict.message);
			}
			throw error;
		}
	}

	if (conflict) {
		await assertNoConflict(collection, conflict.where, undefined, conflict.message);
	}

	await collection.put(id, data);
}

export async function putWithUpdateConflictHandling<T extends object>(
	collection: CollectionWithUniqueInsert<T>,
	id: string,
	data: T,
	conflict?: ConflictHint,
): Promise<void> {
	if (conflict && !collection.putIfAbsent) {
		await assertNoConflict(collection, conflict.where, id, conflict.message);
	}

	try {
		await collection.put(id, data);
		return;
	} catch (error) {
		if (isUniqueConstraintViolation(error) && conflict) {
			throwConflict(conflict.message);
		}
		throw error;
	}
}
