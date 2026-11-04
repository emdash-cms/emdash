import { validateJsonFieldName } from "../database/validate.js";
import type { RangeFilter, WhereClause, WhereValue } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`);
	}
	return value;
}

function operand(value: unknown): string | number {
	if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
		return value;
	}
	throw new TypeError("Storage guard operands must be strings or finite numbers");
}

function normalizeFilter(value: unknown): WhereValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string" || typeof value === "number") return operand(value);
	const filter = requireRecord(value, "Storage guard filter");
	const values = filter.in;
	if (Array.isArray(values)) {
		return { in: Array.from(values, operand) };
	}
	const prefix = filter.startsWith;
	if (typeof prefix === "string") {
		return { startsWith: prefix };
	}
	const range: RangeFilter = {};
	for (const key of ["gt", "gte", "lt", "lte"] as const) {
		if (key in filter) {
			const bound = filter[key];
			range[key] = bound === undefined ? undefined : operand(bound);
		}
	}
	return range;
}

export function parseStorageUpdate(value: unknown): {
	where: WhereClause;
	setEntries: Array<[string, unknown]>;
	deltaEntries: Array<[string, number]>;
} {
	const args = requireRecord(value, "Storage update arguments");
	if (Object.keys(args).some((key) => key !== "where" && key !== "set" && key !== "delta")) {
		throw new TypeError("Unknown storage update argument");
	}
	const where: WhereClause = {};
	for (const [field, filter] of Object.entries(requireRecord(args.where, "Storage where guard"))) {
		validateJsonFieldName(field);
		where[field] = normalizeFilter(filter);
	}
	const set = args.set === undefined ? {} : requireRecord(args.set, "Storage set");
	const delta = args.delta === undefined ? {} : requireRecord(args.delta, "Storage delta");
	const setEntries: Array<[string, unknown]> = [];
	for (const [field, entry] of Object.entries(set)) {
		if (entry === undefined) continue;
		validateJsonFieldName(field);
		const serialized = JSON.stringify(entry);
		if (serialized === undefined)
			throw new TypeError("Storage set values must be JSON serializable");
		const normalized: unknown = JSON.parse(serialized);
		setEntries.push([field, normalized]);
	}
	const setFields = new Set(setEntries.map(([field]) => field));
	const deltaEntries: Array<[string, number]> = [];
	for (const [field, entry] of Object.entries(delta)) {
		if (entry === undefined) continue;
		validateJsonFieldName(field);
		if (setFields.has(field)) throw new TypeError("Storage field appears in both set and delta");
		const spec = requireRecord(entry, "Storage numeric delta");
		const keys = Object.keys(spec);
		const key = keys[0];
		if (keys.length !== 1 || (key !== "inc" && key !== "dec")) {
			throw new TypeError("Storage delta must contain exactly one of inc or dec");
		}
		const amount = spec[key];
		if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
			throw new TypeError("Storage delta must be a safe integer");
		}
		deltaEntries.push([field, key === "dec" ? -amount : amount]);
	}
	if (setEntries.length + deltaEntries.length === 0) {
		throw new TypeError("Storage update requires at least one of set or delta");
	}
	return { where, setEntries, deltaEntries };
}
