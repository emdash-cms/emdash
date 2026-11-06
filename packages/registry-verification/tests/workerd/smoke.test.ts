import { packTar } from "modern-tar";
import { describe, expect, it } from "vitest";

import {
	computeMultihash,
	fetchReleaseArtifact,
	fetchVerifiedResource,
	validatePluginBundle,
} from "../../src/index.js";

const encoder = new TextEncoder();

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("registry verification in workerd", () => {
	it("computes checksums and fetches through injected dependencies", async () => {
		const checksum = await computeMultihash(encoder.encode("hello"));
		expect(checksum).toEqual({
			success: true,
			value: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
		});

		const resource = await fetchVerifiedResource("https://artifact.example.test/package.tgz", {
			fetch: async () => new Response(encoder.encode("artifact")),
			resolveHostname: async () => ["203.0.113.5"],
		});
		expect(resource).toMatchObject({ success: true, value: { status: 200 } });
		if (resource.success) expect(new TextDecoder().decode(resource.value.bytes)).toBe("artifact");
	});

	it("validates a canonical plugin bundle", async () => {
		const manifest = encoder.encode(
			JSON.stringify({
				id: "workerd-plugin",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			}),
		);
		const tar = await packTar([
			{
				header: { name: "manifest.json", size: manifest.byteLength, type: "file" },
				body: manifest,
			},
			{ header: { name: "backend.js", size: 1, type: "file" }, body: encoder.encode("x") },
		]);
		const result = await validatePluginBundle(await gzip(tar), {
			expectedSlug: "workerd-plugin",
			expectedVersion: "1.0.0",
		});
		expect(result).toMatchObject({ success: true, value: { manifest: { id: "workerd-plugin" } } });
	});

	it("resolves a blob artifact through the publisher PDS", async () => {
		const bytes = encoder.encode("bundle");
		const result = await fetchReleaseArtifact(
			{
				record: {
					did: "did:plc:abcdefghijklmnopqrstuvwx",
					collection: "com.emdashcms.experimental.package.release",
					rkey: "workerd-plugin:1.0.0",
					cid: "bafyreig7jlyqew5vpur7kzjk5nwz7kx7f2jvcm2payqv6xnaylb3h5or7a",
				},
				pdsEndpoint: "https://pds.example.test",
				artifact: {
					blob: {
						$type: "blob",
						ref: {
							$link: "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q",
						},
						mimeType: "application/gzip",
						size: bytes.byteLength,
					},
					checksum: "bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a",
				},
			},
			{
				fetch: async () => new Response(bytes),
				resolveHostname: async () => ["203.0.113.5"],
			},
		);

		expect(result).toMatchObject({ success: true, value: { source: "blob", bytes } });
	});
});
