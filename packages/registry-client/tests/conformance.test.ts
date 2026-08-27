import type { FetchHandlerObject } from "@atcute/client";
import { describe, expect, it } from "vitest";

import { runPdsScopeConformance } from "../src/conformance/index.js";

const DID = "did:plc:g0conformance" as const;
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";

interface ScopeHandlerOptions {
	allowProfileCreate?: boolean;
	updateStatus?: number;
}

class ScopeHandler implements FetchHandlerObject {
	readonly #records = new Map<string, { uri: string; cid: string; value: unknown }>();
	readonly #options: ScopeHandlerOptions;

	constructor(options: ScopeHandlerOptions = {}) {
		this.#options = options;
	}

	async handle(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, "https://pds.test");
		const body = parseBody(init.body);
		const input = (body["input"] ?? body) as Record<string, unknown>;
		const collection = input["collection"] as string | undefined;
		const rkey = input["rkey"] as string | undefined;
		const key = collection && rkey ? `${collection}/${rkey}` : "";

		switch (url.pathname) {
			case "/xrpc/com.atproto.repo.createRecord": {
				if (
					collection !== RELEASE_COLLECTION &&
					!(this.#options.allowProfileCreate && collection?.endsWith("package.profile"))
				) {
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
				return stored ? Response.json(stored) : errorResponse(400, "RecordNotFound");
			}
			case "/xrpc/com.atproto.repo.putRecord":
				return errorResponse(this.#options.updateStatus ?? 403, "AuthScopeMismatch");
			case "/xrpc/com.atproto.repo.deleteRecord":
				return errorResponse(403, "AuthScopeMismatch");
			default:
				return errorResponse(404, "MethodNotFound");
		}
	}
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
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler(),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "abc123",
		});

		expect(report.passed).toBe(true);
		expect(report.probes.map((probe) => [probe.id, probe.outcome])).toEqual([
			["release-create", "allowed"],
			["release-readback", "allowed"],
			["release-update", "denied"],
			["release-delete", "denied"],
			["profile-create", "denied"],
			["unrelated-create", "denied"],
		]);
	});

	it("fails when the grant permits profile creation", async () => {
		const report = await runPdsScopeConformance({
			handler: new ScopeHandler({ allowProfileCreate: true }),
			did: DID,
			pds: "https://pds.test",
			provider: "test",
			runId: "def456",
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
		});

		expect(report.passed).toBe(false);
		expect(report.probes.find((probe) => probe.id === "release-update")).toMatchObject({
			outcome: "error",
			passed: false,
			status: 503,
		});
	});

	it("rejects unsafe run identifiers before writing", async () => {
		await expect(
			runPdsScopeConformance({
				handler: new ScopeHandler(),
				did: DID,
				pds: "https://pds.test",
				provider: "test",
				runId: "../../escape",
			}),
		).rejects.toThrow("runId");
	});
});
