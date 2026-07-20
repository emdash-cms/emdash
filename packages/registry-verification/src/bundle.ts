import type { DeclaredAccess, PluginManifest } from "@emdash-cms/plugin-types";
import { pluginManifestSchema, reconcileManifestAccess } from "@emdash-cms/plugin-types";
import { createGzipDecoder } from "modern-tar";

import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	MAX_BUNDLE_DECOMPRESSED_BYTES,
	MAX_BUNDLE_FILE_BYTES,
	MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_SIZE,
	MAX_BUNDLE_TAR_ENTRY_COUNT,
} from "./bundle-limits.js";
import { verificationError } from "./errors.js";
import type { VerificationResult } from "./errors.js";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const OCTAL_PATTERN = /^[0-7]+$/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ValidatePluginBundleOptions {
	expectedSlug?: string;
	expectedVersion?: string;
}

export interface ValidatedPluginBundle {
	manifest: PluginManifest;
	declaredAccess: DeclaredAccess;
	backend: Uint8Array;
	admin?: Uint8Array;
}

interface ParsedFile {
	name: string;
	data: Uint8Array;
}

export async function validatePluginBundle(
	compressed: Uint8Array,
	options: ValidatePluginBundleOptions = {},
): Promise<VerificationResult<ValidatedPluginBundle>> {
	if (compressed.byteLength > MAX_BUNDLE_COMPRESSED_BYTES) {
		return verificationError(
			"BUNDLE_COMPRESSED_SIZE_EXCEEDED",
			"The compressed plugin bundle exceeds the size limit.",
		);
	}

	const decompressed = await decompressBundle(compressed);
	if (!decompressed.success) return decompressed;
	const files = parseTar(decompressed.value);
	if (!files.success) return files;

	const manifestFile = files.value.get("manifest.json");
	if (!manifestFile) {
		return verificationError(
			"BUNDLE_MISSING_MANIFEST",
			"The plugin bundle is missing manifest.json.",
		);
	}
	const backend = files.value.get("backend.js");
	if (!backend) {
		return verificationError("BUNDLE_MISSING_BACKEND", "The plugin bundle is missing backend.js.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(manifestFile.data));
	} catch {
		return verificationError(
			"BUNDLE_INVALID_MANIFEST",
			"The plugin bundle manifest is not valid JSON.",
		);
	}
	const validated = pluginManifestSchema.safeParse(parsed);
	if (!validated.success) {
		return verificationError(
			"BUNDLE_INVALID_MANIFEST",
			"The plugin bundle manifest failed schema validation.",
		);
	}
	const manifest = reconcileManifestAccess(validated.data);
	if (options.expectedSlug !== undefined && manifest.id !== options.expectedSlug) {
		return verificationError(
			"BUNDLE_ID_MISMATCH",
			"The plugin bundle manifest id does not match the expected plugin.",
		);
	}
	if (options.expectedVersion !== undefined && manifest.version !== options.expectedVersion) {
		return verificationError(
			"BUNDLE_VERSION_MISMATCH",
			"The plugin bundle manifest version does not match the expected version.",
		);
	}

	const result: ValidatedPluginBundle = {
		manifest,
		declaredAccess: manifest.declaredAccess ?? {},
		backend: backend.data,
	};
	const admin = files.value.get("admin.js");
	if (admin) result.admin = admin.data;
	return { success: true, value: result };
}

async function decompressBundle(bytes: Uint8Array): Promise<VerificationResult<Uint8Array>> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = source.pipeThrough(createGzipDecoder()).getReader();
	} catch {
		return verificationError("BUNDLE_INVALID_ARCHIVE", "The plugin bundle is not valid gzip data.");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_BUNDLE_DECOMPRESSED_BYTES) {
				await reader.cancel().catch(() => undefined);
				return verificationError(
					"BUNDLE_DECOMPRESSED_SIZE_EXCEEDED",
					"The decompressed plugin bundle exceeds the size limit.",
				);
			}
			chunks.push(value);
		}
	} catch {
		return verificationError("BUNDLE_INVALID_ARCHIVE", "The plugin bundle is not valid gzip data.");
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { success: true, value: output };
}

function parseTar(bytes: Uint8Array): VerificationResult<Map<string, ParsedFile>> {
	if (bytes.byteLength < TAR_END_BYTES || bytes.byteLength % TAR_BLOCK_BYTES !== 0) {
		return invalidArchive();
	}
	const files = new Map<string, ParsedFile>();
	const rawPaths = new Set<string>();
	const normalizedPaths = new Set<string>();
	let offset = 0;
	let fileCount = 0;
	let entryCount = 0;
	let totalFileBytes = 0;
	let ended = false;

	while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (isZeroBlock(header)) {
			if (!isZeroBlock(bytes.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_END_BYTES))) {
				return invalidArchive();
			}
			if (bytes.subarray(offset + TAR_END_BYTES).some((byte) => byte !== 0))
				return invalidArchive();
			ended = true;
			break;
		}
		if (!validChecksum(header)) return invalidArchive();
		entryCount += 1;
		if (entryCount > MAX_BUNDLE_TAR_ENTRY_COUNT) {
			return verificationError(
				"BUNDLE_FILE_COUNT_EXCEEDED",
				"The plugin bundle contains too many archive entries.",
			);
		}

		const rawName = readTarPath(header);
		if (!rawName.success) return rawName;
		const typeFlag = header[156];
		const type = typeFlag === 0 ? "file" : String.fromCharCode(typeFlag ?? 0);
		const isDirectory = type === "5";
		const normalized = normalizePath(rawName.value, isDirectory);
		if (!normalized.success) return normalized;
		if (rawPaths.has(rawName.value) || normalizedPaths.has(normalized.value)) {
			return verificationError(
				"BUNDLE_PATH_COLLISION",
				"The plugin bundle contains duplicate or ambiguous paths.",
			);
		}
		rawPaths.add(rawName.value);
		normalizedPaths.add(normalized.value);

		const size = readOctal(header.subarray(124, 136));
		if (size === null || !Number.isSafeInteger(size)) return invalidArchive();
		const bodyStart = offset + TAR_BLOCK_BYTES;
		const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
		const nextOffset = bodyStart + paddedSize;
		if (nextOffset > bytes.byteLength) return invalidArchive();

		if (isDirectory) {
			if (size !== 0) return invalidArchive();
		} else if (type === "file" || type === "0") {
			fileCount += 1;
			if (fileCount > MAX_BUNDLE_FILE_COUNT) {
				return verificationError(
					"BUNDLE_FILE_COUNT_EXCEEDED",
					"The plugin bundle contains too many files.",
				);
			}
			if (size > MAX_BUNDLE_FILE_BYTES) {
				return verificationError(
					"BUNDLE_FILE_SIZE_EXCEEDED",
					"A file in the plugin bundle exceeds the per-file size limit.",
				);
			}
			totalFileBytes += size;
			if (totalFileBytes > MAX_BUNDLE_SIZE) {
				return verificationError(
					"BUNDLE_DECOMPRESSED_SIZE_EXCEEDED",
					"The plugin bundle file contents exceed the size limit.",
				);
			}
			files.set(normalized.value, {
				name: normalized.value,
				data: bytes.slice(bodyStart, bodyStart + size),
			});
		} else {
			return verificationError(
				"BUNDLE_UNSUPPORTED_ENTRY",
				"The plugin bundle contains an unsupported archive entry type.",
			);
		}
		offset = nextOffset;
	}
	if (!ended) return invalidArchive();
	return { success: true, value: files };
}

function readTarPath(header: Uint8Array): VerificationResult<string> {
	const name = readTarString(header.subarray(0, 100));
	const prefix = readTarString(header.subarray(345, 500));
	if (name === null || prefix === null || name.length === 0) {
		return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains a malformed path.");
	}
	return { success: true, value: prefix ? `${prefix}/${name}` : name };
}

function readTarString(field: Uint8Array): string | null {
	const terminator = field.indexOf(0);
	const end = terminator === -1 ? field.length : terminator;
	if (terminator !== -1 && field.subarray(terminator + 1).some((byte) => byte !== 0)) return null;
	try {
		return decoder.decode(field.subarray(0, end));
	} catch {
		return null;
	}
}

function normalizePath(raw: string, isDirectory: boolean): VerificationResult<string> {
	if (
		raw.includes("\\") ||
		raw.startsWith("/") ||
		WINDOWS_DRIVE_PATTERN.test(raw) ||
		hasControlCharacter(raw) ||
		raw.endsWith("/") !== isDirectory
	) {
		return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains an unsafe path.");
	}
	const parts = raw.split("/");
	if (isDirectory) parts.pop();
	const normalized: string[] = [];
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "" || part === "..") {
			return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains an unsafe path.");
		}
		normalized.push(part.normalize("NFC"));
	}
	if (normalized.length === 0) {
		return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains a malformed path.");
	}
	return { success: true, value: normalized.join("/") };
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function readOctal(field: Uint8Array): number | null {
	const text = new TextDecoder().decode(field).replaceAll("\0", "").trim();
	if (!OCTAL_PATTERN.test(text)) return null;
	const value = Number.parseInt(text, 8);
	return Number.isSafeInteger(value) ? value : null;
}

function validChecksum(header: Uint8Array): boolean {
	const expected = readOctal(header.subarray(148, 156));
	if (expected === null) return false;
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	return actual === expected;
}

function isZeroBlock(block: Uint8Array): boolean {
	return block.byteLength === TAR_BLOCK_BYTES && block.every((byte) => byte === 0);
}

function invalidArchive(): VerificationResult<never> {
	return verificationError(
		"BUNDLE_INVALID_ARCHIVE",
		"The plugin bundle is not a valid tar archive.",
	);
}
