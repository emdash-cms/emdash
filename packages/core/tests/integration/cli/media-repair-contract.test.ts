import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { formatRepairUsageSummary } from "../../../src/cli/commands/media.js";
import type {
	MediaUsageRepairResponse,
	MediaUsageRepairStatus,
} from "../../../src/client/index.js";
import { ensureBuilt } from "../server.js";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const REQUEST_PATH = "/_emdash/api/admin/media-usage/repair";
const STARTED_AT = "2026-07-07T12:00:00.000Z";
const COMPLETED_AT = "2026-07-07T12:00:01.000Z";

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RecordedRequest {
	method: string;
	url: string;
	body: unknown;
	headers: Record<string, string | string[] | undefined>;
}

describe("CLI media usage repair contract", () => {
	let server: Server;
	let baseUrl: string;
	let response: MediaUsageRepairResponse;
	let requests: RecordedRequest[];

	beforeAll(async () => {
		await ensureBuilt();

		server = createServer(async (req, res) => {
			const rawBody = await readRequestBody(req);
			requests.push({
				method: req.method ?? "GET",
				url: req.url ?? "",
				body: rawBody ? JSON.parse(rawBody) : undefined,
				headers: req.headers,
			});

			if (req.method !== "POST" || req.url !== REQUEST_PATH) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }));
				return;
			}

			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: response }));
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		if (!server) return;
		server.close();
		await once(server, "close");
	});

	beforeEach(() => {
		response = repairResponse("complete");
		requests = [];
	});

	it("rejects omitted repair scope before calling the client", async () => {
		const result = await runCli("media", "repair-usage");

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Specify exactly one of --collection or --all");
		expect(requests).toEqual([]);
	});

	it("rejects collection and all repair scopes together before calling the client", async () => {
		const result = await runCli("media", "repair-usage", "--collection", "posts", "--all");

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Specify exactly one of --collection or --all");
		expect(requests).toEqual([]);
	});

	it("rejects repeated collection scopes combined with all before calling the client", async () => {
		const result = await runCli(
			"media",
			"repair-usage",
			"--collection",
			"posts",
			"--collection",
			"pages",
			"--all",
		);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Specify exactly one of --collection or --all");
		expect(requests).toEqual([]);
	});

	it("maps collection scope flags to the media repair client request", async () => {
		const result = await runCli("media", "repair-usage", "--collection", "posts");

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(response);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: REQUEST_PATH,
			body: { scope: "collection", collection: "posts" },
		});
		expect(requests[0]?.headers["authorization"]).toBe("Bearer test-token");
		expect(requests[0]?.headers["x-emdash-request"]).toBe("1");
	});

	it("maps all scope flags to the media repair client request", async () => {
		const result = await runCli("media", "repair-usage", "--all");

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(response);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: REQUEST_PATH,
			body: { scope: "all" },
		});
	});

	it("uses EMDASH_URL when --url is omitted", async () => {
		const result = await runCliWithEnv(
			[
				CLI_BIN,
				"media",
				"repair-usage",
				"--collection",
				"posts",
				"--token",
				"test-token",
				"--json",
			],
			{ EMDASH_URL: baseUrl },
		);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(response);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: REQUEST_PATH,
			body: { scope: "collection", collection: "posts" },
		});
	});

	it.each([
		["complete", 0],
		["partial", 0],
		["stale", 0],
		["failed", 1],
	] as const)(
		"classifies a structured %s repair result with exit %i",
		async (status, expectedCode) => {
			response = repairResponse(status);

			const result = await runCli("media", "repair-usage", "--collection", "posts");

			expect(result.code).toBe(expectedCode);
			expect(result.stdout).toBe(JSON.stringify(response, null, 2) + "\n");
			expect(JSON.parse(result.stdout)).toEqual(response);
		},
	);

	it("formats all-content repair as all content even with one collection", () => {
		const summary = formatRepairUsageSummary(repairResponse("complete"), { scope: "all" });

		expect(summary).toEqual({
			level: "success",
			message:
				"Media usage repair complete for all content (1 collection) (indexed 2, failed 0, skipped 0, deleted 0).",
		});
	});

	it("formats stale repair with race explanation", () => {
		const summary = formatRepairUsageSummary(repairResponse("stale"), {
			scope: "collection",
			collection: "posts",
		});

		expect(summary.level).toBe("warn");
		expect(summary.message).toContain(
			"because another writer, repair, or stale marker won the race",
		);
		expect(summary.message).toContain("posts: stale, CONTENT_USAGE_REPAIR_CONFLICT");
	});

	it.each([
		["partial", "some sources or collections need attention", "INVALID_REPEATER_VALIDATION"],
		["failed", "Media usage repair failed", "COLLECTION_NOT_FOUND"],
	] as const)("formats %s repair with warning and error details", (status, warning, errorCode) => {
		const summary = formatRepairUsageSummary(repairResponse(status), {
			scope: "collection",
			collection: "posts",
		});

		expect(summary.level).toBe("warn");
		expect(summary.message).toContain(warning);
		expect(summary.message).toContain(`posts: ${status}, ${errorCode}`);
	});

	async function runCli(...args: string[]): Promise<CliResult> {
		return runCliWithEnv([CLI_BIN, ...args, "--url", baseUrl, "--token", "test-token", "--json"]);
	}

	async function runCliWithEnv(
		args: string[],
		env: Record<string, string> = {},
	): Promise<CliResult> {
		const child = spawn("node", args, {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		clearTimeout(timeout);

		return { code: code ?? 1, stdout, stderr };
	}
});

function repairResponse(status: MediaUsageRepairStatus): MediaUsageRepairResponse {
	const lastErrorCode =
		status === "complete"
			? null
			: status === "partial"
				? "INVALID_REPEATER_VALIDATION"
				: status === "stale"
					? "CONTENT_USAGE_REPAIR_CONFLICT"
					: "COLLECTION_NOT_FOUND";
	const indexedSourceCount = status === "failed" ? 0 : 2;
	const failedSourceCount = status === "partial" || status === "failed" ? 1 : 0;
	const skippedSourceCount = status === "stale" ? 1 : 0;
	const completedAt = status === "stale" ? null : COMPLETED_AT;

	return {
		status,
		indexedSourceCount,
		failedSourceCount,
		skippedSourceCount,
		deletedSourceCount: 0,
		collections: [
			{
				collection: "posts",
				status,
				indexedSourceCount,
				failedSourceCount,
				skippedSourceCount,
				deletedSourceCount: 0,
				lastErrorCode,
				startedAt: STARTED_AT,
				completedAt,
			},
		],
	};
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += String(chunk);
	}
	return body;
}
