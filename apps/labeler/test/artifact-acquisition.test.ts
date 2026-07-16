import type { FetchImplementation, HostnameResolver } from "@emdash-cms/registry-verification";
import { describe, expect, it, vi } from "vitest";

import {
	acquireArtifact,
	ACQUISITION_FETCH_LIMITS,
	mirrorObjectKey,
	type AcquisitionDeps,
	type AcquisitionTarget,
	type ArtifactMirror,
} from "../src/artifact-acquisition.js";
import {
	bundleBytes,
	canonicalBundle,
	checksumOf,
	file,
	FIXTURE_MANIFEST,
	gzipBytes,
} from "./bundle-fixture.js";

const PUBLIC_ADDRESS = "203.0.113.5";
const PRIVATE_ADDRESS = "10.0.0.5";

const resolvePublic: HostnameResolver = async () => [PUBLIC_ADDRESS];

function respondWith(bytes: Uint8Array): FetchImplementation {
	return async () => new Response(bytes);
}

async function target(overrides: Partial<AcquisitionTarget> = {}): Promise<AcquisitionTarget> {
	const bytes = await canonicalBundle();
	return {
		url: "https://cdn.example.test/plugin.tgz",
		checksum: await checksumOf(bytes),
		slug: "test-plugin",
		version: "1.0.0",
		...overrides,
	};
}

function deps(overrides: Partial<AcquisitionDeps>): AcquisitionDeps {
	return {
		fetch: overrides.fetch ?? vi.fn(),
		resolveHostname: overrides.resolveHostname ?? resolvePublic,
		...(overrides.mirror ? { mirror: overrides.mirror } : {}),
		...(overrides.sources ? { sources: overrides.sources } : {}),
		...(overrides.limits ? { limits: overrides.limits } : {}),
	};
}

describe("acquireArtifact: declared-URL success", () => {
	it("fetches, checksum-verifies, and unpacks the bundle into the code file set", async () => {
		const bytes = await canonicalBundle();
		const result = await acquireArtifact(
			deps({ fetch: respondWith(bytes) }),
			await target({ checksum: await checksumOf(bytes) }),
		);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value.source).toBe("declared-url");
		expect(result.value.bundle.manifest.id).toBe("test-plugin");
		expect(result.value.files.map((f) => f.path)).toEqual(["manifest.json", "backend.js"]);
		expect(result.value.files.find((f) => f.path === "backend.js")?.content).toBe(
			"export default {};",
		);
	});

	it("excludes binary files from the code set but keeps them on the inventory", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
		const bytes = await canonicalBundle([file("icon.png", png)]);
		const result = await acquireArtifact(
			deps({ fetch: respondWith(bytes) }),
			await target({ checksum: await checksumOf(bytes) }),
		);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value.files.map((f) => f.path)).toEqual(["manifest.json", "backend.js"]);
		expect(result.value.bundle.files.map((f) => f.path)).toContain("icon.png");
	});

	it("defaults to mirror-first sources but resolves the declared URL when no mirror is bound", async () => {
		const bytes = await canonicalBundle();
		const fetch = vi.fn(respondWith(bytes));
		const result = await acquireArtifact(
			deps({ fetch }),
			await target({ checksum: await checksumOf(bytes) }),
		);

		expect(result.success).toBe(true);
		if (result.success) expect(result.value.source).toBe("declared-url");
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("acquireArtifact: integrity failures (permanent-mismatch)", () => {
	it("classifies a declared-URL checksum mismatch as artifact-integrity-failure", async () => {
		const served = await canonicalBundle([file("extra.js", "console.log(1);")]);
		const result = await acquireArtifact(deps({ fetch: respondWith(served) }), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "permanent-mismatch",
			code: "CHECKSUM_MISMATCH",
			source: "declared-url",
			disposition: { retry: false, finding: "artifact-integrity-failure" },
		});
	});

	it("rejects a pinned-coordinate drift before fetching", async () => {
		const fetch = vi.fn();
		const result = await acquireArtifact(
			deps({ fetch }),
			await target({ pinnedChecksum: "bdifferentchecksum" }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "permanent-mismatch",
			code: "COORDINATE_MISMATCH",
			disposition: { retry: false, finding: "artifact-integrity-failure" },
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("acquireArtifact: bundle rejections (policy-rejection → invalid-bundle)", () => {
	it("classifies a checksum-valid but malformed archive as invalid-bundle", async () => {
		// A valid gzip envelope whose payload is not a tar archive: it decodes,
		// then fails the (synchronous) tar parse — exercising the invalid-archive
		// classification without a streaming gzip-decode error.
		const notTar = await gzipBytes(new TextEncoder().encode("this is not a tar archive"));
		const result = await acquireArtifact(
			deps({ fetch: respondWith(notTar) }),
			await target({ checksum: await checksumOf(notTar) }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "policy-rejection",
			code: "BUNDLE_INVALID_ARCHIVE",
			disposition: { retry: false, finding: "invalid-bundle" },
		});
	});

	it("classifies a bundle missing its backend entrypoint as invalid-bundle", async () => {
		const noBackend = await bundleBytes([file("manifest.json", JSON.stringify({ id: "x" }))]);
		const result = await acquireArtifact(
			deps({ fetch: respondWith(noBackend) }),
			await target({ checksum: await checksumOf(noBackend) }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "policy-rejection",
			code: "BUNDLE_MISSING_BACKEND",
			disposition: { retry: false, finding: "invalid-bundle" },
		});
	});

	it("rejects a non-UTF-8 executable rather than silently dropping it from analysis", async () => {
		// A valid-JS backend with one invalid UTF-8 byte: structurally accepted by
		// the validator (which stores backend.js raw), but it must not vanish from
		// the analyzed file set — a lenient runtime still executes it.
		const encoder = new TextEncoder();
		const tainted = new Uint8Array([
			...encoder.encode("export default {"),
			0xff,
			...encoder.encode("};"),
		]);
		const bytes = await bundleBytes([
			file("manifest.json", JSON.stringify(FIXTURE_MANIFEST)),
			file("backend.js", tainted),
		]);
		const result = await acquireArtifact(
			deps({ fetch: respondWith(bytes) }),
			await target({ checksum: await checksumOf(bytes) }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "policy-rejection",
			code: "NON_UTF8_CODE_FILE",
			disposition: { retry: false, finding: "invalid-bundle" },
		});
	});
});

describe("acquireArtifact: transient failures", () => {
	it("classifies a network fault as transient (retryable)", async () => {
		// Real fetch rejects asynchronously after I/O; mirror that so the
		// rejection is never momentarily unhandled.
		const fetch: FetchImplementation = async () => {
			await Promise.resolve();
			throw new TypeError("connection reset");
		};
		const result = await acquireArtifact(deps({ fetch }), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "transient",
			code: "FETCH_FAILED",
			disposition: { retry: true },
		});
	});

	it("classifies an origin error status as transient", async () => {
		const fetch: FetchImplementation = async () => new Response("nope", { status: 503 });
		const result = await acquireArtifact(deps({ fetch }), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({ kind: "transient", code: "RESOURCE_STATUS_ERROR" });
		expect(result.error.disposition).toEqual({ retry: true });
	});

	it("treats a transport-oversized response as transient, never a public block", async () => {
		// The byte cap aborts the fetch before any checksum runs, so these bytes
		// are unverified — a MITM or misbehaving CDN must not turn a legitimate
		// plugin into a public invalid-bundle block (spec §9.4). The served bytes
		// deliberately do not match the target checksum, proving the abort is
		// pre-verification (a wrong checksum still yields RESOURCE_SIZE_EXCEEDED,
		// not CHECKSUM_MISMATCH).
		const oversized = await canonicalBundle([file("padding.js", "x".repeat(64))]);
		const result = await acquireArtifact(
			deps({ fetch: respondWith(oversized), limits: { maxBytes: 8 } }),
			await target(),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "transient",
			code: "RESOURCE_SIZE_EXCEEDED",
			disposition: { retry: true },
		});
	});

	it("treats a malformed declared checksum as transient, never a public block", async () => {
		// An undecodable declared checksum is a bad record or a labeler hash-support
		// gap, not tampering — no artifact was fetched or compared, so it must not
		// produce a public artifact-integrity-failure. It fails the pre-fetch
		// coordinate check.
		const fetch = vi.fn();
		const result = await acquireArtifact(
			deps({ fetch }),
			await target({ checksum: "not-a-multibase-multihash" }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "transient",
			code: "INVALID_MULTIHASH",
			disposition: { retry: true },
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("acquireArtifact: SSRF/policy rejections", () => {
	it("refuses a non-HTTPS declared URL without fetching", async () => {
		const fetch = vi.fn();
		const result = await acquireArtifact(
			deps({ fetch }),
			await target({ url: "http://cdn.example.test/plugin.tgz" }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "policy-rejection",
			code: "INVALID_URL",
			disposition: { retry: true },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses an IP-literal declared URL", async () => {
		const fetch = vi.fn();
		const result = await acquireArtifact(
			deps({ fetch }),
			await target({ url: "https://10.0.0.1/plugin.tgz" }),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({ kind: "policy-rejection", code: "HOST_REJECTED" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a redirect into a private address range", async () => {
		const fetch: FetchImplementation = async (url) =>
			url.hostname === "cdn.example.test"
				? new Response(null, { status: 302, headers: { location: "https://internal.test/x" } })
				: new Response(await canonicalBundle());
		const resolveHostname: HostnameResolver = async (hostname) =>
			hostname === "internal.test" ? [PRIVATE_ADDRESS] : [PUBLIC_ADDRESS];

		const result = await acquireArtifact(deps({ fetch, resolveHostname }), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "policy-rejection",
			code: "HOST_REJECTED",
			disposition: { retry: true },
		});
	});
});

describe("acquireArtifact: mirror source", () => {
	it("misses when no mirror binding is present and only the mirror is preferred", async () => {
		const fetch = vi.fn();
		const result = await acquireArtifact(deps({ fetch, sources: ["mirror"] }), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({
			kind: "mirror-miss",
			code: "MIRROR_MISS",
			source: "mirror",
			disposition: { retry: true },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("serves from the mirror when it holds the object, without fetching the declared URL", async () => {
		const bytes = await canonicalBundle();
		const fetch = vi.fn();
		const mirror: ArtifactMirror = { fetch: vi.fn(async () => bytes) };
		const result = await acquireArtifact(
			deps({ fetch, mirror }),
			await target({ checksum: await checksumOf(bytes) }),
		);

		expect(result.success).toBe(true);
		if (result.success) expect(result.value.source).toBe("mirror");
		expect(mirror.fetch).toHaveBeenCalledWith(mirrorObjectKey(await target()), expect.anything());
		expect(fetch).not.toHaveBeenCalled();
	});

	it("falls back to the declared URL when the mirror serves non-matching bytes", async () => {
		const good = await canonicalBundle();
		const stale = await canonicalBundle([file("stale.js", "old();")]);
		const mirror: ArtifactMirror = { fetch: async () => stale };
		const result = await acquireArtifact(
			deps({ fetch: respondWith(good), mirror }),
			await target({ checksum: await checksumOf(good) }),
		);

		expect(result.success).toBe(true);
		if (result.success) expect(result.value.source).toBe("declared-url");
	});
});

describe("mirrorObjectKey", () => {
	it("derives a deterministic key from release coordinates", async () => {
		expect(mirrorObjectKey(await target({ artifactId: "pkg-1" }))).toBe("test-plugin/1.0.0/pkg-1");
		expect(mirrorObjectKey(await target())).toBe("test-plugin/1.0.0/package");
	});

	it("uses the configured fetch limits by default", () => {
		expect(ACQUISITION_FETCH_LIMITS.maxRedirects).toBe(3);
	});
});
