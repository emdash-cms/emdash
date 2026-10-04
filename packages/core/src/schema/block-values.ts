import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { z, type ZodType } from "zod";

import type { Database } from "../database/types.js";
import { BlockTypeRegistry } from "./block-type-registry.js";
import type { BlockType, BlockTypeVersion } from "./block-types.js";
import { SchemaError } from "./registry.js";
import type { CollectionWithFields, Field } from "./types.js";
import { generateBlockFieldSchema } from "./zod-generator.js";

export interface BlockWriteOptions {
	migrateBlocks?: boolean;
	replaceBlocks?: boolean;
	restoreBlocks?: boolean;
}

export interface StoredBlockValue extends Record<string, unknown> {
	_type: string;
	_version: number;
	_key: string;
}

export type ResolvedBlockTypes = ReadonlyMap<string, BlockType>;

export async function resolveBlockTypes(db: Kysely<Database>): Promise<ResolvedBlockTypes> {
	const blockTypes = await new BlockTypeRegistry(db).listBlockTypes();
	return new Map(blockTypes.map((type) => [type.slug, type]));
}

async function fingerprintResolvedTypes(
	allowedTypes: readonly string[],
	retiredTypes: readonly string[],
	types: readonly BlockType[],
): Promise<string> {
	const payload = JSON.stringify({
		allowedTypes,
		retiredTypes,
		types: types.map((type) => ({
			slug: type.slug,
			currentVersion: type.currentVersion,
			versions: type.versions.map((version) => ({
				version: version.version,
				fingerprint: version.fingerprint,
			})),
		})),
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `blocks-field:v1:sha256:${hex}`;
}

export async function expandCollectionBlockFields(
	db: Kysely<Database>,
	collection: CollectionWithFields,
): Promise<CollectionWithFields> {
	const blockFields = collection.fields.filter((field) => field.type === "blocks");
	if (blockFields.length === 0) return collection;
	const resolved = await resolveBlockTypes(db);
	const fields = await Promise.all(
		collection.fields.map(async (field) => {
			if (field.type !== "blocks") return field;
			const allowedTypes = field.validation?.allowedTypes ?? [];
			const retiredTypes = field.validation?.retiredTypes ?? [];
			const slugs = [
				...allowedTypes,
				...retiredTypes.filter((slug) => !allowedTypes.includes(slug)),
			];
			const blockTypes = slugs.map((slug) => {
				const type = resolved.get(slug);
				if (!type) unsupported(field.slug, `block type "${slug}" is unavailable`);
				return type;
			});
			return {
				...field,
				blockTypes,
				blockTypeFingerprint: await fingerprintResolvedTypes(
					allowedTypes,
					retiredTypes,
					blockTypes,
				),
			};
		}),
	);
	return { ...collection, fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(path: string, message: string): never {
	throw new SchemaError(`${path}: ${message}`, "VALIDATION_ERROR", {
		issues: [{ path, code: "custom", message }],
	});
}

function unsupported(path: string, message: string): never {
	throw new SchemaError(`${path}: ${message}`, "UNSUPPORTED_FIELD_TYPE", { path });
}

function versionFor(type: BlockType, version: number, path: string): BlockTypeVersion {
	const definition = type.versions.find((candidate) => candidate.version === version);
	if (!definition)
		unsupported(path, `block type "${type.slug}" has no retained version ${version}`);
	if (definition.unsupportedTypes?.length) {
		unsupported(path, `block type "${type.slug}" version ${version} uses unsupported field types`);
	}
	return definition;
}

function blockSchema(
	typeSlug: string,
	definition: BlockTypeVersion,
): z.ZodObject<Record<string, ZodType>> {
	const shape: Record<string, ZodType> = {
		_type: z.literal(typeSlug),
		_version: z.literal(definition.version),
		_key: z.string().min(1),
	};
	for (const field of definition.fields) shape[field.slug] = generateBlockFieldSchema(field);
	return z.object(shape).strict();
}

function existingByKey(value: unknown, path: string): Map<string, Record<string, unknown>> {
	if (value === undefined || value === null) return new Map();
	if (!Array.isArray(value)) validationError(path, "stored blocks value is not an array");
	const result = new Map<string, Record<string, unknown>>();
	for (const [index, block] of value.entries()) {
		if (!isRecord(block)) validationError(`${path}[${index}]`, "stored block is not an object");
		if (typeof block._key !== "string" || block._key.length === 0) {
			validationError(`${path}[${index}]._key`, "stored block key is missing");
		}
		if (result.has(block._key)) {
			validationError(`${path}[${index}]._key`, "stored block key is duplicated");
		}
		result.set(block._key, block);
	}
	return result;
}

function normalizeBlockArray(
	field: Field,
	value: unknown,
	existingValue: unknown,
	types: ReadonlyMap<string, BlockType>,
	options: BlockWriteOptions,
): StoredBlockValue[] {
	const path = field.slug;
	if (!Array.isArray(value)) validationError(path, "must be an array");
	const minItems = field.validation?.minItems ?? 0;
	const maxItems = field.validation?.maxItems;
	if (value.length < minItems) validationError(path, `must contain at least ${minItems} blocks`);
	if (maxItems !== undefined && value.length > maxItems) {
		validationError(path, `must contain at most ${maxItems} blocks`);
	}

	const allowed = new Set(field.validation?.allowedTypes ?? []);
	const retired = new Set(field.validation?.retiredTypes ?? []);
	const existing = existingByKey(existingValue, path);
	const incomingKeyCount = value.filter(
		(block) => isRecord(block) && block._key !== undefined,
	).length;
	if (options.replaceBlocks && incomingKeyCount > 0) {
		validationError(path, "replaceBlocks requires an entirely keyless replacement array");
	}
	if (!options.replaceBlocks && existing.size > 0 && value.length > 0 && incomingKeyCount === 0) {
		validationError(path, "updating an existing blocks field requires keys or replaceBlocks");
	}

	const seen = new Set<string>();
	return value.map((rawBlock, index) => {
		const blockPath = `${path}[${index}]`;
		if (!isRecord(rawBlock)) validationError(blockPath, "must be an object");
		if (typeof rawBlock._type !== "string" || rawBlock._type.length === 0) {
			validationError(`${blockPath}._type`, "must be a block type slug");
		}
		if (
			rawBlock._version !== undefined &&
			(typeof rawBlock._version !== "number" ||
				!Number.isInteger(rawBlock._version) ||
				rawBlock._version < 1)
		) {
			validationError(`${blockPath}._version`, "must be a positive integer");
		}
		if (
			rawBlock._key !== undefined &&
			(typeof rawBlock._key !== "string" || rawBlock._key.length === 0)
		) {
			validationError(`${blockPath}._key`, "must be a non-empty string");
		}

		const previous = typeof rawBlock._key === "string" ? existing.get(rawBlock._key) : undefined;
		const type = types.get(rawBlock._type);
		if (!type) unsupported(`${blockPath}._type`, `block type "${rawBlock._type}" is unavailable`);
		if (previous) {
			if (previous._type !== rawBlock._type) {
				validationError(`${blockPath}._type`, "cannot change an existing block's type");
			}
		} else if (
			!allowed.has(rawBlock._type) &&
			!(options.restoreBlocks && retired.has(rawBlock._type))
		) {
			const reason = retired.has(rawBlock._type) ? "is retired" : "is not allowed by this field";
			validationError(`${blockPath}._type`, `block type "${rawBlock._type}" ${reason}`);
		}

		let version: number;
		if (previous) {
			if (typeof previous._version !== "number" || !Number.isInteger(previous._version)) {
				validationError(`${blockPath}._version`, "stored block version is invalid");
			}
			version = rawBlock._version === undefined ? previous._version : rawBlock._version;
			if (version !== previous._version) {
				if (!options.migrateBlocks) {
					validationError(`${blockPath}._version`, "cannot change without migrateBlocks");
				}
				if (version !== type.currentVersion) {
					validationError(`${blockPath}._version`, "migration target must be the active version");
				}
			}
		} else {
			version = rawBlock._version === undefined ? type.currentVersion : rawBlock._version;
			if (version !== type.currentVersion && !options.restoreBlocks) {
				validationError(`${blockPath}._version`, "new blocks must use the active version");
			}
		}

		const key = options.replaceBlocks ? ulid() : (rawBlock._key ?? ulid());
		if (seen.has(key)) validationError(`${blockPath}._key`, "must be unique within the field");
		seen.add(key);
		const definition = versionFor(type, version, `${blockPath}._version`);
		const normalized: Record<string, unknown> = {
			...rawBlock,
			_type: rawBlock._type,
			_version: version,
			_key: key,
		};
		if (!previous) {
			for (const nestedField of definition.fields) {
				if (normalized[nestedField.slug] === undefined && nestedField.defaultValue !== undefined) {
					normalized[nestedField.slug] = structuredClone(nestedField.defaultValue);
				}
			}
		}
		for (const nestedField of definition.fields) {
			if (nestedField.required && normalized[nestedField.slug] === "") {
				validationError(`${blockPath}.${nestedField.slug}`, "required field cannot be empty");
			}
		}
		const parsed = blockSchema(type.slug, definition).safeParse(normalized);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const issuePath = issue?.path.length ? `.${issue.path.map(String).join(".")}` : "";
			validationError(`${blockPath}${issuePath}`, issue?.message ?? "invalid block value");
		}
		return {
			...normalized,
			_type: rawBlock._type,
			_version: version,
			_key: key,
		};
	});
}

export async function normalizeBlocksData(
	db: Kysely<Database>,
	collection: CollectionWithFields,
	data: Record<string, unknown>,
	existingData: Record<string, unknown> = {},
	options: BlockWriteOptions = {},
	partial = true,
	resolvedTypes?: ResolvedBlockTypes,
): Promise<Record<string, unknown>> {
	const blockFields = collection.fields.filter(
		(field) => field.type === "blocks" && (!partial || Object.hasOwn(data, field.slug)),
	);
	if (blockFields.length === 0) return data;
	const types = resolvedTypes ?? (await resolveBlockTypes(db));
	const normalized = { ...data };
	for (const field of blockFields) {
		normalized[field.slug] = normalizeBlockArray(
			field,
			Object.hasOwn(data, field.slug) ? data[field.slug] : [],
			existingData[field.slug],
			types,
			options,
		);
	}
	return normalized;
}
