import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	MAX_BUNDLE_DECOMPRESSED_BYTES,
	MAX_BUNDLE_FILE_BYTES,
	MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_SIZE,
	MAX_BUNDLE_TAR_ENTRY_COUNT,
} from "@emdash-cms/registry-verification/bundle";
import { multihashFromBlobCid, verifyMultihash } from "@emdash-cms/registry-verification/checksum";

const TAR_BLOCK_BYTES = 512;
const ROOT_FILES = new Set(["manifest.json", "backend.js", "admin.js", "README.md", "icon.png"]);
const REQUIRED_FILES = ["manifest.json", "backend.js"] as const;
const SCREENSHOT_RE = /^screenshots\/[^/]+\.(?:png|jpe?g)$/i;
const TEXT_FILE_RE = /\.(?:js|mjs|json|md)$/i;
const OCTAL_RE = /^[0-7]+$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type BundleAnomalyCode =
	| "compressed-size-exceeded"
	| "decompressed-size-exceeded"
	| "invalid-gzip"
	| "malformed-archive"
	| "entry-count-exceeded"
	| "file-count-exceeded"
	| "file-size-exceeded"
	| "symlink"
	| "hardlink"
	| "unsupported-entry-type"
	| "path-traversal"
	| "unsafe-path"
	| "duplicate-entry"
	| "unexpected-entry"
	| "missing-required-entry"
	| "invalid-text-encoding";

export interface BundleAnomaly {
	code: BundleAnomalyCode;
	entryIndex?: number;
	name?: string;
}

export interface BundleFile {
	path: string;
	entryIndex: number;
	byteLength: number;
	text?: string;
}

export interface UnpackedBundle {
	files: readonly BundleFile[];
	anomalies: readonly BundleAnomaly[];
}

export interface PackageArtifactReference {
	checksum: string;
	blobCid?: string;
}

export class PackageIntegrityError extends Error {
	override readonly name = "PackageIntegrityError";
}

/**
 * Throws when the bytes do not match the checksum the signed release record
 * declares, because the scan would otherwise describe different code from the
 * code a site installs.
 */
export async function verifyPackageBytes(
	bytes: Uint8Array,
	artifact: PackageArtifactReference,
): Promise<void> {
	if (artifact.blobCid !== undefined) {
		const expected = multihashFromBlobCid(artifact.blobCid);
		if (!expected.success || expected.value !== artifact.checksum) {
			throw new PackageIntegrityError("package checksum does not match its blob reference");
		}
	}
	const verified = await verifyMultihash(bytes, artifact.checksum);
	if (!verified.success) {
		throw new PackageIntegrityError(`package checksum rejected: ${verified.error.code}`);
	}
}

/**
 * Reads a package bundle into memory without evaluating any of it. Archive
 * properties that a well-formed bundle never has are reported as anomalies so
 * the scan can continue over the remaining entries.
 */
export async function unpackPackageBundle(compressed: Uint8Array): Promise<UnpackedBundle> {
	if (compressed.byteLength > MAX_BUNDLE_COMPRESSED_BYTES) {
		return { files: [], anomalies: [{ code: "compressed-size-exceeded" }] };
	}
	const anomalies: BundleAnomaly[] = [];
	const decompressed = await gunzipBounded(compressed);
	if (decompressed.anomaly) anomalies.push({ code: decompressed.anomaly });
	if (!decompressed.bytes) return { files: [], anomalies };
	const files = readTarEntries(decompressed.bytes, anomalies);
	for (const required of REQUIRED_FILES) {
		if (!files.some((file) => file.path === required)) {
			anomalies.push({ code: "missing-required-entry", name: required });
		}
	}
	return { files, anomalies };
}

async function gunzipBounded(
	bytes: Uint8Array,
): Promise<{ bytes?: Uint8Array; anomaly?: BundleAnomalyCode }> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let anomaly: BundleAnomalyCode | undefined;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			const remaining = MAX_BUNDLE_DECOMPRESSED_BYTES - total;
			if (next.value.byteLength > remaining) {
				chunks.push(next.value.subarray(0, remaining));
				total += remaining;
				anomaly = "decompressed-size-exceeded";
				await reader.cancel().catch(() => undefined);
				break;
			}
			chunks.push(next.value);
			total += next.value.byteLength;
		}
	} catch {
		await reader.cancel().catch(() => undefined);
		return { anomaly: "invalid-gzip" };
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return anomaly ? { bytes: output, anomaly } : { bytes: output };
}

function readTarEntries(bytes: Uint8Array, anomalies: BundleAnomaly[]): BundleFile[] {
	const files: BundleFile[] = [];
	const seen = new Set<string>();
	let offset = 0;
	let entryIndex = 0;
	let fileCount = 0;
	let totalFileBytes = 0;
	while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (isZeroBlock(header)) {
			const trailer = bytes.subarray(offset + TAR_BLOCK_BYTES * 2);
			if (
				!isZeroBlock(bytes.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_BLOCK_BYTES * 2)) ||
				trailer.some((byte) => byte !== 0)
			) {
				anomalies.push({ code: "malformed-archive" });
			}
			return files;
		}
		const size = readOctal(header.subarray(124, 136));
		if (!validChecksum(header) || size === null) {
			anomalies.push({ code: "malformed-archive", entryIndex });
			return files;
		}
		if (entryIndex >= MAX_BUNDLE_TAR_ENTRY_COUNT) {
			anomalies.push({ code: "entry-count-exceeded", entryIndex });
			return files;
		}
		const bodyStart = offset + TAR_BLOCK_BYTES;
		const nextOffset = bodyStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
		if (nextOffset > bytes.byteLength) {
			anomalies.push({ code: "malformed-archive", entryIndex });
			return files;
		}
		const typeFlag = header[156] ?? 0;
		const type = typeFlag === 0 ? "0" : String.fromCharCode(typeFlag);
		const rawName = readTarPath(header);
		const name = rawName === null ? undefined : displayName(rawName);
		const report = (code: BundleAnomalyCode) =>
			anomalies.push({ code, entryIndex, ...(name === undefined ? {} : { name }) });

		const path = rawName === null ? null : normalizePath(rawName, type === "5");
		if (path === null || path.kind === "unsafe") {
			report("unsafe-path");
		} else if (path.kind === "traversal") {
			report("path-traversal");
		} else if (path.value !== "") {
			const collisionKey = path.value.normalize("NFC").toLowerCase();
			if (seen.has(collisionKey)) report("duplicate-entry");
			seen.add(collisionKey);
		}

		if (type === "2") {
			report("symlink");
		} else if (type === "1") {
			report("hardlink");
		} else if (type === "5") {
			if (size !== 0) report("malformed-archive");
			if (path?.kind === "ok" && path.value !== "" && path.value !== "screenshots") {
				report("unexpected-entry");
			}
		} else if (type !== "0") {
			report("unsupported-entry-type");
		} else if (path?.kind === "ok") {
			if (!isExpectedFile(path.value)) report("unexpected-entry");
			fileCount += 1;
			totalFileBytes += size;
			if (fileCount > MAX_BUNDLE_FILE_COUNT) {
				report("file-count-exceeded");
			} else if (size > MAX_BUNDLE_FILE_BYTES || totalFileBytes > MAX_BUNDLE_SIZE) {
				report("file-size-exceeded");
			} else {
				const data = bytes.subarray(bodyStart, bodyStart + size);
				const file: BundleFile = { path: path.value, entryIndex, byteLength: size };
				if (TEXT_FILE_RE.test(path.value)) {
					try {
						file.text = decoder.decode(data);
					} catch {
						report("invalid-text-encoding");
					}
				}
				files.push(file);
			}
		}
		entryIndex += 1;
		offset = nextOffset;
	}
	anomalies.push({ code: "malformed-archive" });
	return files;
}

function isExpectedFile(path: string): boolean {
	return ROOT_FILES.has(path) || SCREENSHOT_RE.test(path);
}

function readTarPath(header: Uint8Array): string | null {
	const name = readTarString(header.subarray(0, 100));
	const prefix = readTarString(header.subarray(345, 500));
	if (name === null || prefix === null || name.length === 0) return null;
	return prefix ? `${prefix}/${name}` : name;
}

function readTarString(field: Uint8Array): string | null {
	const terminator = field.indexOf(0);
	const end = terminator === -1 ? field.length : terminator;
	if (field.subarray(end).some((byte) => byte !== 0)) return null;
	try {
		return decoder.decode(field.subarray(0, end));
	} catch {
		return null;
	}
}

type NormalizedPath = { kind: "ok"; value: string } | { kind: "traversal" } | { kind: "unsafe" };

function normalizePath(raw: string, isDirectory: boolean): NormalizedPath {
	if (raw.includes("\\") || hasControlCharacter(raw)) return { kind: "unsafe" };
	if (raw.startsWith("/") || WINDOWS_DRIVE_RE.test(raw)) return { kind: "traversal" };
	if (isDirectory !== raw.endsWith("/")) return { kind: "unsafe" };
	const parts = raw.split("/");
	if (isDirectory) parts.pop();
	const normalized: string[] = [];
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "..") return { kind: "traversal" };
		if (part === "") return { kind: "unsafe" };
		normalized.push(part);
	}
	return { kind: "ok", value: normalized.join("/") };
}

function displayName(raw: string): string {
	let output = "";
	for (const character of raw) {
		const code = character.codePointAt(0)!;
		output += code <= 0x1f || code === 0x7f ? "�" : character;
		if (output.length >= 128) break;
	}
	return output;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function readOctal(field: Uint8Array): number | null {
	const text = new TextDecoder().decode(field).replaceAll("\0", "").trim();
	if (!OCTAL_RE.test(text)) return null;
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
