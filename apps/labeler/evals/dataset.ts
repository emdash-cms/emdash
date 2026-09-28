import {
	isModerationFindingCategory,
	type ModerationFindingCategory,
} from "@emdash-cms/registry-moderation";

import { sha256Hex } from "../src/ai/hash.js";
import manifestData from "./datasets/v1/manifest.json";
import type {
	EvalBudgets,
	EvalExpectation,
	EvalFixture,
	EvalPartition,
	ImageEvalFixture,
	SealedEvalDataset,
	TextEvalFixture,
} from "./types.js";
import { sealedEvalDatasetBrand } from "./types.js";

export const PROMOTION_REQUIRED_PARTITIONS = [
	"gold-prohibited",
	"benign",
	"borderline",
	"prompt-injection",
	"unicode-confusable",
	"multilingual",
	"long-input",
	"image-clean",
	"image-prohibited",
	"holdout",
	"redacted-shadow",
] as const satisfies readonly EvalPartition[];

const PARTITIONS: readonly EvalPartition[] = PROMOTION_REQUIRED_PARTITIONS;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_PROTECTED_ASSETS = 256;
const MAX_PROTECTED_ASSET_BYTES = 4 * 1024 * 1024;
const sealedDatasets = new WeakSet<object>();
const sealedAssets = new WeakMap<object, ReadonlyMap<string, Uint8Array>>();

export interface ProtectedHoldoutInjection {
	fixtureBytes: Uint8Array;
}

export interface DatasetLoadOptions {
	readFile(relativePath: string): Promise<Uint8Array>;
	protectedHoldout?: ProtectedHoldoutInjection;
}

export async function loadEvalDataset(options: DatasetLoadOptions): Promise<SealedEvalDataset> {
	const manifest = parseManifest(manifestData);
	const verifiedFiles = new Map<string, Uint8Array>();
	for (const [path, expectedHash] of Object.entries(manifest.files)) {
		const bytes = new Uint8Array(await options.readFile(path));
		const actualHash = await sha256Hex(bytes);
		if (actualHash !== expectedHash) {
			throw new Error(`evaluation dataset hash mismatch: ${path}`);
		}
		verifiedFiles.set(path, bytes);
	}
	const publicDatasetHash = await aggregateDatasetHash(manifest.files);
	if (publicDatasetHash !== manifest.publicDatasetHash) {
		throw new Error("evaluation dataset aggregate hash mismatch");
	}

	const publicBytes = verifiedFiles.get(manifest.publicFixturePath);
	if (!publicBytes) throw new Error("evaluation public fixture file is not in the manifest");
	const publicFixtures = parseFixtureBytes(publicBytes, false, manifest.datasetVersion);
	let holdoutFixtures: EvalFixture[] = [];
	let holdoutAssets = new Map<string, Uint8Array>();
	let datasetHash = publicDatasetHash;
	if (options.protectedHoldout) {
		const holdoutBytes = new Uint8Array(options.protectedHoldout.fixtureBytes);
		const holdout = await parseCommittedProtectedHoldout(
			holdoutBytes,
			manifest.holdoutCommitment,
			manifest.holdoutDatasetVersion,
		);
		holdoutFixtures = holdout.fixtures;
		holdoutAssets = holdout.assets;
		datasetHash = await aggregateDatasetHash({
			...manifest.files,
			[manifest.holdoutFixturePath]: manifest.holdoutCommitment,
		});
		if (datasetHash !== manifest.promotionDatasetHash) {
			throw new Error("evaluation promotion dataset aggregate hash mismatch");
		}
	}

	const fixtures = [...publicFixtures, ...holdoutFixtures];
	assertUniqueFixtureIds(fixtures);
	const partitions = [...new Set(fixtures.map(({ partition }) => partition))].toSorted();
	const assets = new Map<string, Uint8Array>();
	for (const [assetId, path] of Object.entries(manifest.assets)) {
		const bytes = verifiedFiles.get(path);
		if (!bytes) throw new Error(`evaluation asset is not in the manifest: ${assetId}`);
		assets.set(assetId, new Uint8Array(bytes));
	}
	for (const [assetId, bytes] of holdoutAssets) {
		if (assets.has(assetId)) throw new TypeError(`evaluation asset ID is duplicated: ${assetId}`);
		assets.set(assetId, new Uint8Array(bytes));
	}
	for (const fixture of fixtures) {
		if (fixture.kind === "image" && !assets.has(fixture.input.assetId)) {
			throw new Error(`evaluation image asset is missing: ${fixture.input.assetId}`);
		}
	}
	const promotionComplete =
		manifest.promotionEnabled &&
		PROMOTION_REQUIRED_PARTITIONS.every((partition) => partitions.includes(partition));
	const dataset: SealedEvalDataset = deepFreeze({
		schemaVersion: 1 as const,
		datasetVersion: manifest.datasetVersion,
		datasetHash,
		fixtures,
		assets: Object.fromEntries([
			...Object.entries(manifest.assets),
			...Array.from(holdoutAssets.keys(), (id) => [id, "protected"]),
		]),
		budgets: manifest.budgets,
		holdoutCommitment: manifest.holdoutCommitment,
		partitions,
		promotionComplete,
		[sealedEvalDatasetBrand]: true,
	});
	sealedDatasets.add(dataset);
	sealedAssets.set(dataset, assets);
	return dataset;
}

export async function parseCommittedProtectedHoldout(
	bytes: Uint8Array,
	expectedCommitment: string,
	expectedDatasetVersion: string,
): Promise<{ fixtures: EvalFixture[]; assets: Map<string, Uint8Array> }> {
	if (!SHA256_RE.test(expectedCommitment)) {
		throw new TypeError("protected holdout commitment is invalid");
	}
	if ((await sha256Hex(bytes)) !== expectedCommitment) {
		throw new Error("protected holdout commitment does not match the dataset manifest");
	}
	const value = decodeFixtureJson(bytes);
	const file = object(value, "protected dataset file");
	const fixtures = parseFixtureFile(file, true, expectedDatasetVersion);
	const assetSource = object(file["assets"], "protected dataset assets");
	const entries = Object.entries(assetSource);
	if (entries.length > MAX_PROTECTED_ASSETS) {
		throw new RangeError("protected dataset contains too many assets");
	}
	const assets = new Map<string, Uint8Array>();
	for (const [assetId, assetValue] of entries) {
		if (!assetId || assetId.length > 128) throw new TypeError("protected asset ID is invalid");
		const asset = object(assetValue, `protected asset ${assetId}`);
		if (asset["mimeType"] !== "image/png") {
			throw new TypeError(`protected asset ${assetId} has an invalid MIME type`);
		}
		const expectedHash = parseHash(asset["sha256"], `protected asset ${assetId}`);
		const encoded = string(asset["base64"], `protected asset ${assetId}.base64`);
		if (!BASE64_RE.test(encoded)) {
			throw new TypeError(`protected asset ${assetId} is not canonical base64`);
		}
		const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		if (decoded.byteLength > MAX_PROTECTED_ASSET_BYTES) {
			throw new RangeError(`protected asset ${assetId} exceeds its byte limit`);
		}
		if ((await sha256Hex(decoded)) !== expectedHash) {
			throw new Error(`protected asset ${assetId} hash mismatch`);
		}
		assets.set(assetId, decoded);
	}
	const referencedAssets = new Set(
		fixtures.flatMap((fixture) => (fixture.kind === "image" ? [fixture.input.assetId] : [])),
	);
	if (
		referencedAssets.size !== assets.size ||
		[...referencedAssets].some((assetId) => !assets.has(assetId))
	) {
		throw new TypeError("protected image fixtures and assets must match exactly");
	}
	return { fixtures, assets };
}

export function assertSealedEvalDataset(value: unknown): asserts value is SealedEvalDataset {
	if (typeof value !== "object" || value === null || !sealedDatasets.has(value)) {
		throw new TypeError("evaluation dataset must be sealed from verified fixture and asset bytes");
	}
}

export function readSealedEvalAsset(dataset: SealedEvalDataset, assetId: string): Uint8Array {
	assertSealedEvalDataset(dataset);
	const bytes = sealedAssets.get(dataset)?.get(assetId);
	if (!bytes) throw new Error(`sealed evaluation asset is missing: ${assetId}`);
	return new Uint8Array(bytes);
}

export async function assertDatasetFileHashes(
	readFile: (relativePath: string) => Promise<Uint8Array>,
): Promise<void> {
	await loadEvalDataset({ readFile });
}

async function aggregateDatasetHash(files: Readonly<Record<string, string>>): Promise<string> {
	const index = Object.entries(files)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([path, fileHash]) => `${path}:${fileHash}`)
		.join("\n");
	return sha256Hex(`${index}\n`);
}

function parseFixtureBytes(
	bytes: Uint8Array,
	holdout: boolean,
	expectedDatasetVersion: string,
): EvalFixture[] {
	const value = decodeFixtureJson(bytes);
	return parseFixtureFile(value, holdout, expectedDatasetVersion);
}

function decodeFixtureJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new TypeError("evaluation fixture bytes are not valid UTF-8 JSON");
	}
}

function parseFixtureFile(
	value: unknown,
	holdout: boolean,
	expectedDatasetVersion: string,
): EvalFixture[] {
	const file = object(value, "dataset file");
	if (file["schemaVersion"] !== 1 || file["datasetVersion"] !== expectedDatasetVersion) {
		throw new TypeError("evaluation dataset file version is invalid");
	}
	if (!Array.isArray(file["fixtures"])) throw new TypeError("dataset fixtures must be an array");
	return file["fixtures"].map((fixture, index) => parseFixture(fixture, index, holdout));
}

function parseFixture(value: unknown, index: number, holdout: boolean): EvalFixture {
	const fixture = object(value, `fixture[${index}]`);
	const id = string(fixture["id"], `fixture[${index}].id`);
	const partitionValue = fixture["partition"];
	if (!isEvalPartition(partitionValue)) {
		throw new TypeError(`fixture ${id} has an invalid partition`);
	}
	const partition = partitionValue;
	if ((partition === "holdout") !== holdout) {
		throw new TypeError(`fixture ${id} crosses the holdout boundary`);
	}
	const expected = parseExpected(fixture["expected"], id);
	if (fixture["kind"] === "text") {
		const input = object(fixture["input"], `${id}.input`);
		if (!Array.isArray(input["text"]) || !Array.isArray(input["links"])) {
			throw new TypeError(`${id} text input is invalid`);
		}
		const parsed: TextEvalFixture = {
			id,
			kind: "text",
			partition,
			input: {
				text: input["text"].map((item, itemIndex) => {
					const field = object(item, `${id}.text[${itemIndex}]`);
					if (field["format"] !== "plain" && field["format"] !== "markdown") {
						throw new TypeError(`${id} has an invalid text format`);
					}
					return {
						ref: string(field["ref"], `${id}.text.ref`),
						value: string(field["value"], `${id}.text.value`),
						format: field["format"],
					};
				}),
				links: input["links"].map((item, itemIndex) => {
					const link = object(item, `${id}.links[${itemIndex}]`);
					const usage = link["usage"];
					if (
						usage !== "author" &&
						usage !== "security" &&
						usage !== "repository" &&
						usage !== "sbom" &&
						usage !== "markdown"
					) {
						throw new TypeError(`${id} has an invalid link usage`);
					}
					return {
						ref: string(link["ref"], `${id}.link.ref`),
						url: string(link["url"], `${id}.link.url`),
						usage,
					};
				}),
			},
			expected,
		};
		return parsed;
	}
	if (fixture["kind"] === "image") {
		const input = object(fixture["input"], `${id}.input`);
		if (input["mimeType"] !== "image/png") throw new TypeError(`${id} has an invalid MIME type`);
		const parsed: ImageEvalFixture = {
			id,
			kind: "image",
			partition,
			input: {
				assetId: string(input["assetId"], `${id}.assetId`),
				evidenceRef: string(input["evidenceRef"], `${id}.evidenceRef`),
				mimeType: "image/png",
			},
			expected,
		};
		return parsed;
	}
	throw new TypeError(`fixture ${id} has an invalid kind`);
}

function parseExpected(value: unknown, id: string): EvalExpectation {
	const expected = object(value, `${id}.expected`);
	if (!Array.isArray(expected["categories"])) {
		throw new TypeError(`${id} expected categories must be an array`);
	}
	const categories: ModerationFindingCategory[] = expected["categories"].map((category) => {
		if (!isModerationFindingCategory(category)) {
			throw new TypeError(`${id} has an unknown expected category`);
		}
		return category;
	});
	const outcome = expected["outcome"];
	if (outcome !== "pass" && outcome !== "review") {
		throw new TypeError(`${id} has an invalid expected outcome`);
	}
	return { categories, outcome };
}

function parseManifest(value: unknown): {
	datasetVersion: string;
	promotionEnabled: boolean;
	holdoutDatasetVersion: string;
	publicDatasetHash: string;
	promotionDatasetHash: string;
	publicFixturePath: string;
	holdoutFixturePath: string;
	holdoutCommitment: string;
	files: Record<string, string>;
	assets: Record<string, string>;
	budgets: EvalBudgets;
} {
	const manifest = object(value, "dataset manifest");
	if (manifest["schemaVersion"] !== 1) throw new TypeError("dataset manifest version is invalid");
	const files = stringRecord(manifest["files"], "manifest.files");
	const assets = stringRecord(manifest["assets"], "manifest.assets");
	const holdout = object(manifest["holdout"], "manifest.holdout");
	const source = object(manifest["budgets"], "manifest.budgets");
	const budget = (key: keyof EvalBudgets): number => {
		const configured = source[key];
		if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
			throw new TypeError(`manifest budget ${key} is invalid`);
		}
		return configured;
	};
	return {
		datasetVersion: string(manifest["datasetVersion"], "manifest.datasetVersion"),
		promotionEnabled: boolean(manifest["promotionEnabled"], "manifest.promotionEnabled"),
		holdoutDatasetVersion: string(holdout["datasetVersion"], "manifest.holdout.datasetVersion"),
		publicDatasetHash: parseHash(manifest["publicDatasetHash"], "manifest.publicDatasetHash"),
		promotionDatasetHash: parseHash(
			manifest["promotionDatasetHash"],
			"manifest.promotionDatasetHash",
		),
		publicFixturePath: string(manifest["publicFixturePath"], "manifest.publicFixturePath"),
		holdoutFixturePath: string(holdout["fixturePath"], "manifest.holdout.fixturePath"),
		holdoutCommitment: parseHash(holdout["commitment"], "manifest.holdout.commitment"),
		files: Object.fromEntries(
			Object.entries(files).map(([path, configuredHash]) => [
				path,
				parseHash(configuredHash, path),
			]),
		),
		assets,
		budgets: {
			maxFalseNegativesPerCategory: budget("maxFalseNegativesPerCategory"),
			maxFalsePositivesPerCategory: budget("maxFalsePositivesPerCategory"),
			maxInvalidOutputs: budget("maxInvalidOutputs"),
			maxModelErrors: budget("maxModelErrors"),
			maxBenignReviewRate: budget("maxBenignReviewRate"),
			maxOutcomeMismatches: budget("maxOutcomeMismatches"),
			maxRepeatedRunDisagreementRate: budget("maxRepeatedRunDisagreementRate"),
			maxP95LatencyMs: budget("maxP95LatencyMs"),
			maxConfiguredUnits: budget("maxConfiguredUnits"),
		},
	};
}

function assertUniqueFixtureIds(fixtures: readonly EvalFixture[]): void {
	if (new Set(fixtures.map(({ id }) => id)).size !== fixtures.length) {
		throw new TypeError("evaluation fixture IDs must be unique");
	}
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (!isObject(value)) throw new TypeError(`${field} must be an object`);
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvalPartition(value: unknown): value is EvalPartition {
	return typeof value === "string" && PARTITIONS.some((partition) => partition === value);
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} is invalid`);
	return value;
}

function parseHash(value: unknown, field: string): string {
	const result = string(value, field);
	if (!SHA256_RE.test(result)) throw new TypeError(`${field} must be a SHA-256 hash`);
	return result;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
	const record = object(value, field);
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [key, string(item, `${field}.${key}`)]),
	);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (ArrayBuffer.isView(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
