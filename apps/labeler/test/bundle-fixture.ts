/**
 * Test helpers that build canonical plugin bundles (gzipped USTAR tar) and
 * their multibase checksums, entirely in-runtime (workerd `CompressionStream`,
 * no `node:zlib`). Shared by the acquisition unit tests and the orchestrator
 * acquire-stage test.
 */

import { computeMultihash } from "@emdash-cms/registry-verification";
import { packTar, type TarEntry } from "modern-tar";

const encoder = new TextEncoder();

export const FIXTURE_MANIFEST = {
	id: "test-plugin",
	version: "1.0.0",
	capabilities: ["write:content"],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
} as const;

export function file(name: string, body: string | Uint8Array): TarEntry {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	const compressed = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function bundleBytes(entries: TarEntry[]): Promise<Uint8Array> {
	return gzipBytes(await packTar(entries));
}

/** A valid bundle: manifest.json + backend.js, plus any extra entries. */
export async function canonicalBundle(extra: TarEntry[] = []): Promise<Uint8Array> {
	return bundleBytes([
		file("manifest.json", JSON.stringify(FIXTURE_MANIFEST)),
		file("backend.js", "export default {};"),
		...extra,
	]);
}

export async function checksumOf(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error(`could not hash fixture: ${result.error.code}`);
	return result.value;
}
