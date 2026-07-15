/**
 * Pure fixture conversion (plan W8.6). No filesystem or network — the runner
 * (`run.ts`) reads bytes off disk and passes them here. Converts a ported
 * legacy audit fixture into the adapters' `CodeAnalysisInput` /
 * `ImageAnalysisImage` shapes, parses PNG dimensions from the IHDR header
 * (no image dependency), hashes image bytes, and maps a legacy expectation
 * into the labeler policy vocabulary.
 */

import type { CodeAnalysisInput, CodeAnalysisMetadata } from "../src/code-ai-adapter.js";
import type { ImageAnalysisImage } from "../src/image-ai-adapter.js";
import {
	automatedBlockCategories,
	warningCategories,
	type ModerationPolicy,
} from "../src/policy.js";

/** Placeholder publisher DID for ported fixtures — the legacy corpus carried
 * no identity, and the adapter only needs a well-formed string. */
export const FIXTURE_PUBLISHER_DID = "did:plc:calibrationfixture0000000000";

export interface FixtureManifest {
	readonly id: string;
	readonly version: string;
	readonly capabilities?: readonly string[];
}

export interface RawFixtureFile {
	readonly path: string;
	readonly content: string;
}

/** A finding lane's expected outcome, re-expressed in labeler policy terms.
 * `review: true` marks a legacy expectation that does not translate cleanly and
 * needs human review rather than a machine-checked assertion. `toState` is
 * deliberately only `passed` or `blocked`: the warn-zone is inherently
 * ambiguous (a warning depends on the severity the model assigns), so the
 * corpus expresses it as `review`, never as a hard `warned` assertion — a
 * concrete `warned` expectation would have no false-positive/negative branch
 * and would silently escape the deltas. */
export interface LaneExpectation {
	readonly toState?: "passed" | "blocked";
	readonly categories?: readonly string[];
	readonly review?: boolean;
	readonly note?: string;
}

export interface Expectation {
	readonly code?: LaneExpectation;
	readonly image?: LaneExpectation;
}

export interface LegacyExpected {
	readonly verdict: "pass" | "warn" | "fail";
	readonly categories: readonly string[];
	readonly images?: "pass" | "warn" | "fail";
	readonly imageCategories?: readonly string[];
}

/**
 * Legacy audit category -> labeler policy label value. Categories absent from
 * this map have no labeler equivalent and force a `review` expectation rather
 * than a guess (e.g. `resource-abuse`, `nsfw`).
 */
export const LEGACY_CATEGORY_MAP: Readonly<Record<string, string>> = {
	"credential-harvesting": "credential-harvesting",
	"data-exfiltration": "data-exfiltration",
	obfuscation: "obfuscated-code",
	"brand-impersonation": "impersonation",
	misleading: "misleading-metadata",
};

function mapLane(
	verdict: "pass" | "warn" | "fail",
	legacyCategories: readonly string[],
	policy: ModerationPolicy,
): LaneExpectation {
	if (verdict === "pass") return { toState: "passed", categories: [] };

	const unmapped = legacyCategories.filter((category) => !(category in LEGACY_CATEGORY_MAP));
	if (unmapped.length > 0)
		return {
			review: true,
			note: `legacy category '${unmapped.join(", ")}' has no labeler policy mapping`,
		};

	if (verdict === "warn")
		return {
			review: true,
			note: "legacy verdict 'warn'; labeler outcome depends on the severity the model assigns",
		};

	const mapped = legacyCategories.map((category) => LEGACY_CATEGORY_MAP[category] as string);
	const blockCategories = automatedBlockCategories(policy);
	const blockingLabels = mapped.filter((label) => blockCategories.has(label));
	if (blockingLabels.length > 0)
		return { toState: "blocked", categories: [...new Set(blockingLabels)] };

	const warnCategories = warningCategories(policy);
	if (mapped.every((label) => warnCategories.has(label)))
		return {
			review: true,
			note: "legacy verdict 'fail' but its categories map only to warning-category labels",
		};

	return {
		review: true,
		note: "legacy expectation does not translate to a single labeler outcome",
	};
}

/**
 * Maps a legacy audit expectation into labeler terms. Deterministic — the
 * committed `expected.json` files are the output of this function, with a few
 * `note` strings hand-tuned for review context.
 */
export function mapLegacyExpectation(
	legacy: LegacyExpected,
	policy: ModerationPolicy,
): Expectation {
	const code = mapLane(legacy.verdict, legacy.categories, policy);
	if (legacy.images === undefined) return { code };
	const image = mapLane(legacy.images, legacy.imageCategories ?? [], policy);
	return { code, image };
}

export function parseExpectation(value: unknown): Expectation {
	if (!isRecord(value) || !isRecord(value.expect))
		throw new TypeError("expected.json must be an object with an `expect` key");
	const expect = value.expect;
	const result: { code?: LaneExpectation; image?: LaneExpectation } = {};
	if (expect.code !== undefined) result.code = parseLaneExpectation(expect.code, "code");
	if (expect.image !== undefined) result.image = parseLaneExpectation(expect.image, "image");
	return result;
}

function parseLaneExpectation(value: unknown, lane: string): LaneExpectation {
	if (!isRecord(value)) throw new TypeError(`expect.${lane} must be an object`);
	const result: {
		toState?: "passed" | "blocked";
		categories?: readonly string[];
		review?: boolean;
		note?: string;
	} = {};
	if (value.toState !== undefined) {
		// "warned" is intentionally rejected — see LaneExpectation. A warn-zone
		// prior belongs in `review`, not a hard assertion the deltas can't score.
		if (value.toState !== "passed" && value.toState !== "blocked")
			throw new TypeError(
				`expect.${lane}.toState must be "passed" or "blocked" (use review for the warn-zone), got: ${String(value.toState)}`,
			);
		result.toState = value.toState;
	}
	if (value.categories !== undefined) {
		if (!Array.isArray(value.categories) || !value.categories.every((c) => typeof c === "string"))
			throw new TypeError(`expect.${lane}.categories must be an array of strings`);
		result.categories = value.categories;
	}
	if (value.review !== undefined) {
		if (typeof value.review !== "boolean")
			throw new TypeError(`expect.${lane}.review must be a boolean`);
		result.review = value.review;
	}
	if (value.note !== undefined) {
		if (typeof value.note !== "string") throw new TypeError(`expect.${lane}.note must be a string`);
		result.note = value.note;
	}
	return result;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// "IHDR" — the first chunk's type, at offset 12 (after the 8-byte signature and
// the chunk's 4-byte length). Verifying it rejects a file whose 8-byte
// signature is right but whose first chunk isn't the header we read from.
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const;
const MAX_PNG_DIMENSION = 65_535;

export interface PngDimensions {
	readonly width: number;
	readonly height: number;
}

/**
 * Reads width/height from a PNG's IHDR chunk. The signature is 8 bytes, then a
 * 4-byte length and the 4-byte "IHDR" type, so width/height are the two
 * big-endian uint32s at offsets 16 and 20.
 */
export function parsePngDimensions(bytes: Uint8Array): PngDimensions {
	if (bytes.length < 24) throw new TypeError("PNG too short to contain an IHDR header");
	for (const [index, expected] of PNG_SIGNATURE.entries()) {
		if (bytes[index] !== expected) throw new TypeError("not a PNG (bad signature)");
	}
	for (const [index, expected] of IHDR_TYPE.entries()) {
		if (bytes[12 + index] !== expected) throw new TypeError("PNG first chunk is not IHDR");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION)
		throw new TypeError(`PNG dimensions out of range: ${width}x${height}`);
	return { width, height };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function manifestMetadata(manifest: FixtureManifest): CodeAnalysisMetadata {
	return {
		name: manifest.id,
		description: "",
		publisherDid: FIXTURE_PUBLISHER_DID,
		version: manifest.version,
	};
}

/**
 * Builds the code adapter's input from a fixture's raw files and manifest. The
 * manifest is included as an analyzable file so the model sees the full
 * declaration (e.g. secret settings fields), and its capabilities become
 * `declaredAccess`.
 */
export function buildCodeAnalysisInput(
	manifest: FixtureManifest,
	manifestRaw: string,
	files: readonly RawFixtureFile[],
): CodeAnalysisInput {
	return {
		files: [{ path: "manifest.json", content: manifestRaw }, ...files],
		declaredAccess: manifest.capabilities ?? [],
		metadata: manifestMetadata(manifest),
	};
}

export async function buildImageAnalysisImage(
	path: string,
	bytes: Uint8Array,
	kind: "icon" | "screenshot",
): Promise<ImageAnalysisImage> {
	const { width, height } = parsePngDimensions(bytes);
	return {
		path,
		mime: "image/png",
		sha256: await sha256Hex(bytes),
		dataBase64: toBase64(bytes),
		width,
		height,
		kind,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
