import type { FetchHandlerObject } from "@atcute/client";
import { describe, expect, it } from "vitest";

import { runPdsScopeConformance } from "../src/conformance/index.js";

const DID = "did:plc:g0conformance" as const;
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const PACKAGE_BLOB_CID = "bafkreiczq2o3gsctsm5shhy6eim467kddwqankursy2upbir7k57zccj2i";
const IMAGE_BLOB_CID = "bafkreicddtwwsfvcuinbk3ryoanp4vn3274is2p3x7cw277athkh6jsuma";
const UNRELATED_BLOB_CID = "bafkreicecnx2gvntm6fbcrvnc336qze6st5u7qq7457igegamd3bzkx7ri";
const SCOPE_DENIAL = { status: 403 as const, error: "AuthScopeMismatch" };

interface ScopeHandlerOptions {
	alterReadbackBlob?: boolean;
	allowDelete?: boolean;
	allowProfileCreate?: boolean;
	allowUnrelatedCreate?: boolean;
	allowUnrelatedMime?: boolean;
	wrongPackageBlobCid?: boolean;
	updateError?: string;
	updateStatus?: number;
}

class ScopeHandler implements FetchHandlerObject {
	readonly #records = new Map<string, { uri: string; cid: string; value: unknown }>();
	readonly #options: ScopeHandlerOptions;
	readonly deletedKeys: string[] = [];

	constructor(options: ScopeHandlerOptions = {}) {
		this.#options = options;
	}

	async handle(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, "https://pds.test");
		if (url.pathname === "/xrpc/com.atproto.repo.uploadBlob") {
			const contentType = new Headers(init.headers).get("content-type") ?? "";
			const bytes = bodyBytes(init.body);
			if (
				contentType !== "application/gzip" &&
				contentType !== "image/png" &&
				!this.#options.allowUnrelatedMime
			) {
				return errorResponse(403, "AuthScopeMismatch");
			}
			return Response.json({
				blob: {
					$type: "blob",
					ref: {
						$link:
							contentType === "application/gzip"
								? this.#options.wrongPackageBlobCid
									? IMAGE_BLOB_CID
									: PACKAGE_BLOB_CID
								: contentType === "image/png"
									? IMAGE_BLOB_CID
									: UNRELATED_BLOB_CID,
					},
					mimeType: contentType,
					size: bytes.byteLength,
				},
			});
		}
		const body = parseBody(init.body);
		const input = (body["input"] ?? body) as Record<string, unknown>;
		const collection = input["collection"] as string | undefined;
		const rkey = input["rkey"] as string | undefined;
		const key = collection && rkey ? `${collection}/${rkey}` : "";

		switch (url.pathname) {
			case "/xrpc/com.atproto.repo.createRecord": {
				const allowed =
					collection === RELEASE_COLLECTION ||
					(this.#options.allowProfileCreate && collection?.endsWith("package.profile")) ||
					(this.#options.allowUnrelatedCreate &&
						collection === "com.emdashcms.experimental.conformance.probe");
				if (!allowed) {
					return errorResponse(403, "AuthScopeMismatch");
				}
				const uri = `at://${DID}/${key}`;
				const stored = { uri, cid: `bafy${this.#records.size + 1}`, value: input["record"] };
				this.#records.set(key, stored);
				return Response.json({ uri: stored.uri, cid: stored.cid });
			}
			case "/xrpc/com.atproto.repo.getRecord": {
				const queryCollection = url.searchParams.get("collection") ?? "";
				const queryRkey = url.searchParams.get("rkey") ?? "";
				const stored = this.#records.get(`${queryCollection}/${queryRkey}`);
				if (!stored) return errorResponse(400, "RecordNotFound");
				if (this.#options.alterReadbackBlob) {
					return Response.json({
						...stored,
						value: {
							artifacts: {
								package: {
									blob: {
										$type: "blob",
										ref: { $link: IMAGE_BLOB_CID },
										mimeType: "application/gzip",
										size: 20,
									},
								},
								icon: {
									blob: {
										$type: "blob",
										ref: { $link: IMAGE_BLOB_CID },
										mimeType: "image/png",
										size: 68,
									},
								},
							},
						},
					});
				}
				return Response.json(stored);
			}
			case "/xrpc/com.atproto.repo.putRecord":
				return errorResponse(
					this.#options.updateStatus ?? 403,
					this.#options.updateError ?? "AuthScopeMismatch",
				);
			case "/xrpc/com.atproto.repo.applyWrites":
				return errorResponse(403, "AuthScopeMismatch");
			case "/xrpc/com.atproto.repo.deleteRecord":
				if (!this.#options.allowDelete) return errorResponse(403, "AuthScopeMismatch");
				this.#records.delete(key);
				this.deletedKeys.push(key);
				return Response.json({});
			default:
				return errorResponse(404, "MethodNotFound");
		}
	}

	record(collection: string, rkey: string): unknown {
		return this.#records.get(`${collection}/${rkey}`)?.value;
	}
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	throw new TypeError("Mock scope handler expected a Uint8Array upload body");
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
	if (body === null || body === undefined) return {};
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
	}
	throw new TypeError("Mock scope handler expected a JSON string or Uint8Array body");
}

function errorResponse(status: number, error: string): Response {
	return Response.json({ error, message: error }, { status });
}

describe("PDS delegated-release scope conformance", () => {
	it("passes when only release create and public readback are allowed", async () => {
		const handler = new ScopeHandler();
		const report = await runPdsScopeConformance({
			handler,
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "abc123",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(true);
		expect(report.scopeDenial).toEqual(SCOPE_DENIAL);
		expect(report.blobs).toEqual({
			package: { cid: PACKAGE_BLOB_CID, mimeType: "application/gzip", size: 20 },
			image: { cid: IMAGE_BLOB_CID, mimeType: "image/png", size: 68 },
		});
		expect(report.probes.map((probe) => [probe.id, probe.outcome])).toEqual([
			["package-blob-upload", "allowed"],
			["image-blob-upload", "allowed"],
			["unrelated-blob-upload", "denied"],
			["release-create", "allowed"],
			["release-readback", "allowed"],
			["release-apply-update", "denied"],
			["release-apply-delete", "denied"],
			["release-update", "denied"],
			["release-delete", "denied"],
			["profile-create", "denied"],
			["unrelated-create", "denied"],
		]);
		expect(handler.record(RELEASE_COLLECTION, report.release.rkey)).toMatchObject({
			artifacts: {
				package: { blob: { ref: { $link: PACKAGE_BLOB_CID } } },
				icon: { blob: { ref: { $link: IMAGE_BLOB_CID } } },
			},
		});
	});

	it("fails when the grant permits profile creation", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ allowProfileCreate: true }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "def456",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "profile-create")).toMatchObject({
			outcome: "allowed",
			passed: false,
		});
	});

	it("does not count a server failure as an expected denial", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ updateStatus: 503 }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "ghi789",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "release-update")).toMatchObject({
			outcome: "error",
			passed: false,
			status: 503,
		});
	});

	it.each([
		[401, "ExpiredToken"],
		[429, "RateLimitExceeded"],
	])("does not count HTTP %i %s as an expected denial", async (status, error) => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ updateStatus: status, updateError: error }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "jkl012",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "release-update")).toMatchObject({
			outcome: "error",
			passed: false,
			status,
			error,
		});
	});

	it("requires the configured HTTP status and exact scope error", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler(),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "mno345",
			scopeDenial: { status: 403, error: "InsufficientScope" },
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "unrelated-blob-upload")).toMatchObject({
			outcome: "error",
			passed: false,
			status: 403,
			error: "AuthScopeMismatch",
		});
	});

	it("fails when the grant permits an unrelated blob MIME type", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ allowUnrelatedMime: true }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "pqr678",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "unrelated-blob-upload")).toMatchObject({
			outcome: "allowed",
			passed: false,
		});
	});

	it("fails when an allowed upload returns a CID for different bytes", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ wrongPackageBlobCid: true }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "yz0123",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "package-blob-upload")).toMatchObject({
			outcome: "error",
			passed: false,
			error: "TypeError",
		});
		expect(report.blobs.package).toBeNull();
	});

	it("fails when public readback does not contain the uploaded blob references", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ alterReadbackBlob: true }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "vwx234",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "release-readback")).toMatchObject({
			outcome: "error",
			passed: false,
			error: "TypeError",
		});
	});

	it("attempts cleanup only for forbidden records that the harness created", async () => {
		const handler = new ScopeHandler({
			allowDelete: true,
			allowProfileCreate: true,
			allowUnrelatedCreate: true,
		});
		const report = await runPdsScopeConformance({
			handler,
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "stu901",
			scopeDenial: SCOPE_DENIAL,
		});

		expect(report.passed).toBe(false);
		expect(report.cleanup).toEqual([
			{ resource: "profile-record", outcome: "deleted" },
			{ resource: "unrelated-record", outcome: "deleted" },
		]);
		expect(handler.deletedKeys).toEqual([
			`${RELEASE_COLLECTION}/${report.release.rkey}`,
			`com.emdashcms.experimental.package.profile/emdash_g0_profile_stu901`,
			`com.emdashcms.experimental.conformance.probe/g0_stu901`,
		]);
	});

	it("rejects unsafe run identifiers before writing", async () => {
		await expect(
			runPdsScopeConformance({
				handler: new ScopeHandler(),
				did: DID,
				pds: "https://pds.test",
				provider: "test",
				runId: "../../escape",
				scopeDenial: SCOPE_DENIAL,
			}),
		).rejects.toThrow("runId");
	});
});
