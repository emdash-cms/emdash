/**
 * `emdash site export|import` against real transfer routes: an origin and a
 * target site are each served over HTTP by the route handlers, and the CLI
 * talks to them through the real client, exactly as it would to a deployed
 * site.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { Role } from "@emdash-cms/auth";
import { runCommand } from "citty";
import { consola } from "consola";
import type { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as capabilitiesGet } from "../../../src/astro/routes/api/admin/transfer/capabilities.js";
import { POST as exportAdvancePost } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/advance.js";
import { GET as exportFileGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/files/[...path].js";
import { GET as exportGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/index.js";
import { GET as exportManifestGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/manifest.js";
import {
	GET as exportsGet,
	POST as exportsPost,
} from "../../../src/astro/routes/api/admin/transfer/exports/index.js";
import { POST as abandonPost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/abandon.js";
import { POST as importAdvancePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/advance.js";
import { POST as analyzePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/analyze.js";
import { POST as cancelPost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/cancel.js";
import { POST as executePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/execute.js";
import { PUT as filePut } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/files/[...path].js";
import { GET as importGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/index.js";
import { GET as missingGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/missing.js";
import { GET as planGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/plan.js";
import { GET as receiptGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/receipt.js";
import {
	GET as importsGet,
	POST as importsPost,
} from "../../../src/astro/routes/api/admin/transfer/imports/index.js";
import { GET as usersGet } from "../../../src/astro/routes/api/admin/users/index.js";
import { siteCommand } from "../../../src/cli/commands/site.js";
import { exportPartsPath, exportSidecarPath, runSiteExport } from "../../../src/cli/site/export.js";
import {
	analyzePackage,
	confirmPackage,
	resumeImport,
	type AnalyzeOutcome,
	type CompletedImport,
} from "../../../src/cli/site/import.js";
import { describeError, type TransferRuntime } from "../../../src/cli/site/shared.js";
import { EmDashClient, type Interceptor } from "../../../src/client/index.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { readSitePackageArchive } from "../../../src/transfer/container/tar.js";
import { sha256Hex } from "../../../src/transfer/format/digest.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../utils/transfer/origin-site.js";

type Handler = (context: never) => Promise<Response> | Response;

const LOGIN_SCOPES = ["admin"];
const ADMIN = { id: "site-admin", role: Role.ADMIN };
const TARGET_BOB = { id: "target_bob", email: "Bob@Example.com" };

const ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler; params: string[] }> = [
	route("GET", "/admin/users", usersGet),
	route("GET", "/admin/transfer/capabilities", capabilitiesGet),
	route("GET", "/admin/transfer/exports", exportsGet),
	route("POST", "/admin/transfer/exports", exportsPost),
	route("GET", "/admin/transfer/exports/:id", exportGet),
	route("POST", "/admin/transfer/exports/:id/advance", exportAdvancePost),
	route("GET", "/admin/transfer/exports/:id/manifest", exportManifestGet),
	route("GET", "/admin/transfer/exports/:id/files/*path", exportFileGet),
	route("GET", "/admin/transfer/imports", importsGet),
	route("POST", "/admin/transfer/imports", importsPost),
	route("GET", "/admin/transfer/imports/:id", importGet),
	route("GET", "/admin/transfer/imports/:id/missing", missingGet),
	route("PUT", "/admin/transfer/imports/:id/files/*path", filePut),
	route("POST", "/admin/transfer/imports/:id/analyze", analyzePost),
	route("GET", "/admin/transfer/imports/:id/plan", planGet),
	route("POST", "/admin/transfer/imports/:id/execute", executePost),
	route("POST", "/admin/transfer/imports/:id/advance", importAdvancePost),
	route("GET", "/admin/transfer/imports/:id/receipt", receiptGet),
	route("POST", "/admin/transfer/imports/:id/cancel", cancelPost),
	route("POST", "/admin/transfer/imports/:id/abandon", abandonPost),
];

function route(method: string, path: string, handler: Handler) {
	const params: string[] = [];
	const source = path
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				params.push(segment.slice(1));
				return "([^/]+)";
			}
			if (segment.startsWith("*")) {
				params.push(segment.slice(1));
				return "(.+)";
			}
			return segment;
		})
		.join("/");
	return { method, pattern: new RegExp(`^/_emdash/api${source}$`), handler, params };
}

interface Site {
	db: Kysely<Database>;
	storage: MemoryStorage;
	tokenScopes: string[];
	server: Server;
	url: string;
	requests: Array<{ method: string; path: string; status: number }>;
}

async function serve(db: Kysely<Database>, storage: MemoryStorage): Promise<Site> {
	const site = {
		db,
		storage,
		tokenScopes: LOGIN_SCOPES,
		requests: [],
	} as unknown as Site;
	site.server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";
		const match = ROUTES.map((candidate) => ({
			candidate,
			groups: candidate.method === method ? candidate.pattern.exec(url.pathname) : null,
		})).find((entry) => entry.groups);
		let response: Response;
		if (!match?.groups) {
			response = Response.json(
				{ error: { code: "NOT_FOUND", message: "Not found" } },
				{ status: 404 },
			);
		} else {
			const params = Object.fromEntries(
				match.candidate.params.map((name, index) => [
					name,
					decodeURIComponent(match.groups![index + 1]!),
				]),
			);
			const headers = new Headers();
			for (const [name, value] of Object.entries(req.headers)) {
				if (typeof value === "string") headers.set(name, value);
			}
			const hasBody = method !== "GET" && method !== "HEAD";
			const request = new Request(url, {
				method,
				headers,
				body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
				...(hasBody ? { duplex: "half" } : {}),
			});
			response = await match.candidate.handler({
				request,
				url,
				params,
				locals: {
					emdash: { db: site.db, storage: site.storage, config: {} },
					user: ADMIN,
					tokenScopes: site.tokenScopes,
				},
			} as never);
		}
		site.requests.push({ method, path: url.pathname, status: response.status });
		res.writeHead(response.status, Object.fromEntries(response.headers));
		if (!response.body) {
			res.end();
			return;
		}
		await response.body.pipeTo(Writable.toWeb(res)).catch(() => res.destroy());
	});
	await new Promise<void>((resolve) => site.server.listen(0, "127.0.0.1", resolve));
	site.url = `http://127.0.0.1:${(site.server.address() as AddressInfo).port}`;
	return site;
}

function clientFor(site: Site, interceptors: Interceptor[] = []): EmDashClient {
	return new EmDashClient({ baseUrl: site.url, token: "test-token", interceptors });
}

/** Fails requests matching `when` with a non-retryable error once `after` matching requests went through. */
function interruptAfter(
	after: number,
	when: (request: Request) => boolean,
): { interceptor: Interceptor; seen: () => number } {
	let seen = 0;
	return {
		interceptor: async (request, next) => {
			if (when(request)) {
				if (seen >= after) throw new Error("connection lost");
				seen++;
			}
			return next(request);
		},
		seen: () => seen,
	};
}

function silentRuntime(): TransferRuntime & { lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		reporter: {
			info: (message) => lines.push(message),
			warn: (message) => lines.push(`warn: ${message}`),
		},
		retry: { attempts: 3, baseDelayMs: 1 },
		sleep: async () => {},
	};
}

async function operationRows(db: Kysely<Database>, kind: "export" | "import") {
	return db
		.selectFrom("_emdash_transfer_operations")
		.select(["id", "state"])
		.where("kind", "=", kind)
		.execute();
}

function capture(stream: NodeJS.WriteStream): { text: () => string; restore: () => void } {
	let text = "";
	const write = stream.write.bind(stream);
	stream.write = ((chunk: string | Uint8Array) => {
		text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof stream.write;
	return { text: () => text, restore: () => (stream.write = write) };
}

/**
 * Run `emdash site`. With `terminal`, stdout is a TTY and consola prints
 * info messages, as for a person at a terminal.
 */
async function runCli(
	args: string[],
	options: { terminal?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdout = capture(process.stdout);
	const stderr = capture(process.stderr);
	const isTTY = process.stdout.isTTY;
	const { level, stdout: consolaStdout, stderr: consolaStderr } = consola.options;
	if (options.terminal) {
		process.stdout.isTTY = true;
		consola.level = 3;
		consola.options.stdout = process.stdout;
		consola.options.stderr = process.stderr;
	}
	process.exitCode = undefined;
	try {
		await runCommand(siteCommand, { rawArgs: args });
	} finally {
		stdout.restore();
		stderr.restore();
		process.stdout.isTTY = isTTY;
		consola.level = level;
		consola.options.stdout = consolaStdout;
		consola.options.stderr = consolaStderr;
	}
	const exitCode = Number(process.exitCode ?? 0);
	process.exitCode = undefined;
	return { stdout: stdout.text(), stderr: stderr.text(), exitCode };
}

function isPut(request: Request): boolean {
	return request.method === "PUT";
}

describe("emdash site", () => {
	let dir: string;
	let origin: Site;
	let target: Site;
	let originSite: OriginSite;
	let originDb: Kysely<Database>;
	let targetDb: Kysely<Database>;

	beforeAll(() => {
		consola.level = -999;
	});

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "emdash-site-cli-"));
		originDb = await setupTestDatabase();
		const originStorage = createMemoryStorage();
		originSite = await buildOriginSite(originDb, originStorage);
		origin = await serve(originDb, originStorage);

		targetDb = await setupTestDatabase();
		await applySeed(targetDb, defaultSeed, { includeContent: false, onConflict: "skip" });
		await targetDb
			.insertInto("users")
			.values({
				id: TARGET_BOB.id,
				email: TARGET_BOB.email,
				name: "Target Bob",
				avatar_url: null,
				role: Role.ADMIN,
				email_verified: 1,
				data: null,
			})
			.execute();
		target = await serve(targetDb, createMemoryStorage());
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
	});

	afterEach(async () => {
		setI18nConfig(null);
		await new Promise((resolve) => origin.server.close(resolve));
		await new Promise((resolve) => target.server.close(resolve));
		await teardownTestDatabase(originDb);
		await teardownTestDatabase(targetDb);
		rmSync(dir, { recursive: true, force: true });
	});

	async function exportPackage(): Promise<string> {
		const output = join(dir, "site.emdash");
		await runSiteExport(
			{ client: clientFor(origin), baseUrl: origin.url, outputPath: output, comments: true },
			silentRuntime(),
		);
		return output;
	}

	it("exports a package whose files all match the export's manifest", async () => {
		const output = join(dir, "site.emdash");
		const { stdout, exitCode } = await runCli([
			"export",
			"--output",
			output,
			"--url",
			origin.url,
			"--token",
			"t",
			"--json",
		]);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		expect(result).toMatchObject({ output, resumed: false });
		expect(result.packageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(existsSync(exportSidecarPath(output))).toBe(false);
		expect(existsSync(`${output}.partial`)).toBe(false);

		const files = await readSitePackageArchive(readFileSync(output));
		expect(files.size).toBe(result.files);
		expect(readFileSync(output).byteLength).toBe(result.bytes);
		const hero = originSite.media.find((item) => item.id === originSite.ids.heroMedia)!;
		expect(files.get(`media/${await sha256Hex(hero.bytes)}`)).toEqual(hero.bytes);
		const exportId = String(result.operationId);
		for (const [path, bytes] of files) {
			if (path === "manifest.json") continue;
			const response = await clientFor(origin).transferExportFile(exportId, path);
			expect(response.sha256).toBe(await sha256Hex(bytes));
		}
		expect(origin.requests.some((request) => request.path.endsWith("/archive"))).toBe(false);
	});

	it("leaves comments out with --no-comments", async () => {
		const output = join(dir, "site.emdash");
		const { exitCode } = await runCli([
			"export",
			"-o",
			output,
			"--no-comments",
			"--url",
			origin.url,
			"--token",
			"t",
			"--json",
		]);
		expect(exitCode).toBe(0);
		const files = await readSitePackageArchive(readFileSync(output));
		const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
			features: string[];
			records: Record<string, unknown>;
		};
		expect(manifest.features).not.toContain("comments");
		expect(manifest.records.comment).toBeUndefined();
	});

	it("resumes an interrupted export instead of starting another", async () => {
		const output = join(dir, "site.emdash");
		const cut = interruptAfter(1, (request) => request.url.endsWith("/advance"));
		const first = runSiteExport(
			{
				client: clientFor(origin, [cut.interceptor]),
				baseUrl: origin.url,
				outputPath: output,
				comments: true,
			},
			silentRuntime(),
		);
		await expect(first).rejects.toThrow("connection lost");
		expect(cut.seen()).toBe(1);
		const sidecar = JSON.parse(readFileSync(exportSidecarPath(output), "utf8")) as {
			operationId: string;
		};
		const [interrupted] = await operationRows(originDb, "export");
		expect(interrupted?.id).toBe(sidecar.operationId);

		const result = await runSiteExport(
			{ client: clientFor(origin), baseUrl: origin.url, outputPath: output, comments: true },
			silentRuntime(),
		);
		expect(result).toMatchObject({ operationId: sidecar.operationId, resumed: true });
		expect(await operationRows(originDb, "export")).toEqual([
			{ id: sidecar.operationId, state: "complete" },
		]);
		expect(existsSync(exportSidecarPath(output))).toBe(false);
		expect((await readSitePackageArchive(readFileSync(output))).size).toBe(result.files);
	});

	it("resumes an interrupted download without exporting again", async () => {
		const output = join(dir, "site.emdash");
		const cut = interruptAfter(2, (request) => request.url.includes("/files/"));
		await expect(
			runSiteExport(
				{
					client: clientFor(origin, [cut.interceptor]),
					baseUrl: origin.url,
					outputPath: output,
					comments: true,
				},
				silentRuntime(),
			),
		).rejects.toThrow("connection lost");
		expect(existsSync(output)).toBe(false);
		expect(existsSync(`${output}.partial`)).toBe(false);
		const advancesBefore = origin.requests.filter((r) => r.path.endsWith("/advance")).length;
		const isFileRequest = (r: { path: string }) => r.path.includes("/files/");
		const firstDownloads = origin.requests.filter(isFileRequest).map((r) => r.path);
		expect(firstDownloads).toHaveLength(2);
		const before = origin.requests.length;

		const runtime = silentRuntime();
		const result = await runSiteExport(
			{ client: clientFor(origin), baseUrl: origin.url, outputPath: output, comments: true },
			runtime,
		);
		expect(result.resumed).toBe(true);
		expect(await operationRows(originDb, "export")).toEqual([
			{ id: result.operationId, state: "complete" },
		]);
		expect(origin.requests.filter((r) => r.path.endsWith("/advance"))).toHaveLength(advancesBefore);
		const secondDownloads = origin.requests.slice(before).filter(isFileRequest);
		expect(secondDownloads.filter((r) => firstDownloads.includes(r.path))).toEqual([]);
		expect(secondDownloads).toHaveLength(result.files - 1 - firstDownloads.length);
		expect(runtime.lines).toContain("Reused 2 files downloaded by an earlier run");
		expect((await readSitePackageArchive(readFileSync(output))).size).toBe(result.files);
		expect(existsSync(exportPartsPath(output))).toBe(false);
	});

	it("refuses a downloaded manifest that is not the export's", async () => {
		const output = join(dir, "site.emdash");
		const swapManifest: Interceptor = async (request, next) => {
			const response = await next(request);
			if (!request.url.endsWith("/manifest")) return response;
			const text = (await response.text()).replace(
				/"createdAt":"[^"]*"/,
				'"createdAt":"2000-01-01T00:00:00.000Z"',
			);
			return new Response(text, { status: response.status, headers: response.headers });
		};
		const failure = await runSiteExport(
			{
				client: clientFor(origin, [swapManifest]),
				baseUrl: origin.url,
				outputPath: output,
				comments: true,
			},
			silentRuntime(),
		).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "TRANSFER_PACKAGE_DIGEST_MISMATCH" });
		expect(existsSync(output)).toBe(false);
	});

	it("downloads a kept file again when it no longer verifies", async () => {
		const output = join(dir, "site.emdash");
		const hero = originSite.media.find((item) => item.id === originSite.ids.heroMedia)!;
		const heroDigest = await sha256Hex(hero.bytes);
		const heroPath = `media/${heroDigest}`;
		const cut = interruptAfter(0, (request) => request.url.includes("/files/media/"));
		await expect(
			runSiteExport(
				{
					client: clientFor(origin, [cut.interceptor]),
					baseUrl: origin.url,
					outputPath: output,
					comments: true,
				},
				silentRuntime(),
			),
		).rejects.toThrow("connection lost");
		mkdirSync(exportPartsPath(output), { recursive: true });
		const damaged = Uint8Array.from(hero.bytes);
		damaged[0] = damaged[0]! ^ 0xff;
		writeFileSync(join(exportPartsPath(output), heroDigest), damaged);
		const before = origin.requests.length;

		await runSiteExport(
			{ client: clientFor(origin), baseUrl: origin.url, outputPath: output, comments: true },
			silentRuntime(),
		);
		expect(
			origin.requests.slice(before).filter((r) => r.path.endsWith(`/files/${heroPath}`)),
		).toHaveLength(1);
		expect((await readSitePackageArchive(readFileSync(output))).get(heroPath)).toEqual(hero.bytes);
	});

	it("prints progress to stderr and the result to stdout in a terminal", async () => {
		const output = join(dir, "site.emdash");
		const { stdout, stderr, exitCode } = await runCli(
			["export", "-o", output, "--url", origin.url, "--token", "t"],
			{ terminal: true },
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(`to ${output}`);
		expect(stdout).toContain("Package digest:");
		expect(stdout).not.toContain("Started export");
		expect(stderr).toContain("Started export");
		expect(stderr).toContain("is complete; downloading");
	});

	it("starts a fresh export when the sidecar was written with different options", async () => {
		const output = join(dir, "site.emdash");
		writeFileSync(
			exportSidecarPath(output),
			JSON.stringify({
				version: 1,
				baseUrl: origin.url,
				comments: false,
				idempotencyKey: "emdash-cli-export-old",
				operationId: null,
			}),
		);
		const runtime = silentRuntime();
		const result = await runSiteExport(
			{ client: clientFor(origin), baseUrl: origin.url, outputPath: output, comments: true },
			runtime,
		);
		expect(result.resumed).toBe(false);
		expect(runtime.lines.some((line) => line.startsWith("warn: Ignoring"))).toBe(true);
	});

	it("refuses a package with a damaged file before contacting the site", async () => {
		const output = await exportPackage();
		const archive = readFileSync(output);
		const hero = originSite.media.find((item) => item.id === originSite.ids.heroMedia)!;
		const offset = archive.indexOf(Buffer.from(hero.bytes));
		expect(offset).toBeGreaterThan(0);
		archive[offset] = archive[offset]! ^ 0xff;
		const damaged = join(dir, "damaged.emdash");
		writeFileSync(damaged, archive);

		const { stdout, exitCode } = await runCli([
			"import",
			damaged,
			"--analyze",
			"--url",
			target.url,
			"--token",
			"t",
			"--json",
		]);
		expect(exitCode).toBe(1);
		const body = JSON.parse(stdout) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
		expect(body.error.message).toContain(`media/${await sha256Hex(hero.bytes)}`);
		expect(target.requests).toEqual([]);
	});

	it("resumes an interrupted upload without re-sending verified files", async () => {
		const output = await exportPackage();
		const totalFiles = (await readSitePackageArchive(readFileSync(output))).size - 1;
		const cut = interruptAfter(3, isPut);
		await expect(
			analyzePackage(
				clientFor(target, [cut.interceptor]),
				output,
				{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
				silentRuntime(),
			),
		).rejects.toThrow("connection lost");
		const firstPuts = target.requests.filter((r) => r.method === "PUT" && r.status === 200);
		expect(firstPuts.length).toBeGreaterThanOrEqual(3);
		const before = target.requests.length;

		const outcome = (await analyzePackage(
			clientFor(target),
			output,
			{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
			silentRuntime(),
		)) as AnalyzeOutcome;
		expect(outcome.operation.state).toBe("planned");
		const secondPuts = target.requests.slice(before).filter((r) => r.method === "PUT");
		expect(secondPuts.every((r) => r.status === 200)).toBe(true);
		const firstPaths = new Set(firstPuts.map((r) => r.path));
		expect(secondPuts.filter((r) => firstPaths.has(r.path))).toEqual([]);
		expect(firstPuts.length + secondPuts.length).toBe(totalFiles);
		expect(await operationRows(targetDb, "import")).toHaveLength(1);
	});

	it("retries a transient upload failure", async () => {
		const output = await exportPackage();
		let failed = false;
		const flaky: Interceptor = async (request, next) => {
			if (!failed && isPut(request)) {
				failed = true;
				return Response.json(
					{ error: { code: "TRANSFER_STORAGE_ERROR", message: "Storage hiccup" } },
					{ status: 503 },
				);
			}
			return next(request);
		};
		const runtime = silentRuntime();
		const outcome = (await analyzePackage(
			clientFor(target, [flaky]),
			output,
			{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
			runtime,
		)) as AnalyzeOutcome;
		expect(failed).toBe(true);
		expect(outcome.operation.state).toBe("planned");
		expect(runtime.lines.some((line) => line.includes("retrying"))).toBe(true);
	});

	it("reports a token without a transfer scope", async () => {
		const output = await exportPackage();
		target.tokenScopes = ["content:read"];
		const { stdout, exitCode } = await runCli([
			"import",
			output,
			"--analyze",
			"--url",
			target.url,
			"--token",
			"t",
			"--json",
		]);
		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout)).toEqual({
			error: {
				code: "INSUFFICIENT_SCOPE",
				message: "Token lacks required scope: transfer:analyze or transfer:execute",
			},
		});
	});

	it("prints every difference from the source site in the plan", async () => {
		const output = await exportPackage();
		const { stdout, exitCode } = await runCli(
			["import", output, "--analyze", "--url", target.url, "--token", "t"],
			{ terminal: true },
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Differences from the source site");
		expect(stdout).toMatch(
			/media_url_relativized \[\w+(, \w+)*\] x\d+: Media links were made relative/,
		);
		expect(stdout).toMatch(/principal_unmapped x\d+: Some content will have no author/);
		expect(stdout).toMatch(
			/seeded_scaffold_removed x\d+: Starter content will be removed\n.*collection \d+/,
		);
	});

	it("refuses --confirm without --plan", async () => {
		const { stdout, exitCode } = await runCli([
			"import",
			join(dir, "site.emdash"),
			"--confirm",
			"--url",
			target.url,
			"--json",
		]);
		expect(exitCode).toBe(1);
		expect((JSON.parse(stdout) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
		expect(target.requests).toEqual([]);
	});

	it("rejects a principal mapping for a principal the package does not have", async () => {
		const output = await exportPackage();
		const { stdout, exitCode } = await runCli([
			"import",
			output,
			"--analyze",
			"--map-principal",
			"nobody@example.com=none",
			"--url",
			target.url,
			"--token",
			"t",
			"--json",
		]);
		expect(exitCode).toBe(1);
		const body = JSON.parse(stdout) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("INVALID_ARGUMENT");
		expect(body.error.message).toContain("nobody@example.com");
	});

	it(
		"analyzes with decisions, executes the confirmed plan, and resumes an interrupted execution",
		{ timeout: 600_000 },
		async () => {
			const output = await exportPackage();
			const cliTarget = ["--url", target.url, "--token", "t", "--json"];

			const analyzed = await runCli([
				"import",
				output,
				"--analyze",
				"--map-principal",
				"alice@example.com=none",
				"--map-principal",
				`${originSite.ids.bob}=bob@example.com`,
				"--use-target-title",
				...cliTarget,
			]);
			expect(analyzed.exitCode).toBe(0);
			const plan = JSON.parse(analyzed.stdout) as {
				operationId: string;
				state: string;
				packageDigest: string;
				planDigest: string;
				executable: boolean;
				plan: {
					blockers: unknown[];
					decisions: { principalMappings: Record<string, string | null>; siteTitle: string };
				};
			};
			expect(plan).toMatchObject({ state: "planned", executable: true });
			expect(plan.plan.blockers).toEqual([]);
			expect(plan.plan.decisions.principalMappings).toMatchObject({
				[originSite.ids.alice]: null,
				[originSite.ids.bob]: TARGET_BOB.id,
			});
			expect(plan.plan.decisions.siteTitle).toBe("target");

			const again = await runCli(["import", output, "--analyze", ...cliTarget]);
			expect((JSON.parse(again.stdout) as { planDigest: string }).planDigest).toBe(plan.planDigest);

			const stale = await runCli([
				"import",
				output,
				"--plan",
				`sha256:${"0".repeat(64)}`,
				"--confirm",
				...cliTarget,
			]);
			expect(stale.exitCode).toBe(1);
			expect((JSON.parse(stale.stdout) as { error: { code: string } }).error.code).toBe(
				"TRANSFER_PLAN_DIGEST_MISMATCH",
			);

			const cut = interruptAfter(0, (request) => request.url.endsWith("/advance"));
			await expect(
				confirmPackage(
					clientFor(target, [cut.interceptor]),
					output,
					plan.planDigest,
					silentRuntime(),
				),
			).rejects.toThrow("connection lost");

			const status = await runCli(["import", "status", plan.operationId, ...cliTarget]);
			expect(status.exitCode).toBe(0);
			const statusBody = JSON.parse(status.stdout) as {
				operation: { state: string; stage: string };
			};
			expect(statusBody.operation).toMatchObject({ state: "planned", stage: "reserve" });

			const resumed = await runCli(["import", "resume", plan.operationId, ...cliTarget]);
			expect(resumed.exitCode).toBe(0);
			const completed = JSON.parse(resumed.stdout) as CompletedImport;
			expect(completed).toMatchObject({
				operationId: plan.operationId,
				state: "complete",
				receiptDigestValid: true,
				receipt: {
					packageDigest: plan.packageDigest,
					planDigest: plan.planDigest,
					verification: "verified",
				},
			});

			const confirmedAgain = await runCli([
				"import",
				output,
				"--plan",
				plan.planDigest,
				"--confirm",
				...cliTarget,
			]);
			expect(confirmedAgain.exitCode).toBe(0);
			expect(JSON.parse(confirmedAgain.stdout)).toEqual(completed);

			const receipt = await runCli(["import", "receipt", plan.operationId, ...cliTarget]);
			expect(JSON.parse(receipt.stdout)).toEqual(completed);
			expect(await operationRows(targetDb, "import")).toEqual([
				{ id: plan.operationId, state: "complete" },
			]);
		},
	);

	it("asks for the package file to resume an import that is still uploading", async () => {
		const output = await exportPackage();
		const cut = interruptAfter(1, isPut);
		await expect(
			analyzePackage(
				clientFor(target, [cut.interceptor]),
				output,
				{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
				silentRuntime(),
			),
		).rejects.toThrow("connection lost");
		const [row] = await operationRows(targetDb, "import");

		const error = await resumeImport(clientFor(target), row!.id, null, silentRuntime()).catch(
			(caught: unknown) => caught,
		);
		expect(describeError(error).code).toBe("PACKAGE_FILE_REQUIRED");

		const outcome = (await resumeImport(
			clientFor(target),
			row!.id,
			output,
			silentRuntime(),
		)) as AnalyzeOutcome;
		expect(outcome.operation).toMatchObject({ id: row!.id, state: "planned" });
	});

	it("cancels an import that has not written anything", async () => {
		const output = await exportPackage();
		const outcome = (await analyzePackage(
			clientFor(target),
			output,
			{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
			silentRuntime(),
		)) as AnalyzeOutcome;
		const id = outcome.operation.id;
		const cliTarget = ["--url", target.url, "--token", "t"];

		const cancelled = await runCli(["import", "cancel", id, "--yes", ...cliTarget], {
			terminal: true,
		});
		expect(cancelled.exitCode).toBe(0);
		expect(cancelled.stdout).toContain(`Import ${id} is cancelled.`);
		expect(cancelled.stdout).toContain("It had not written anything to this site.");
		expect(await operationRows(targetDb, "import")).toEqual([{ id, state: "cancelled" }]);

		const status = await runCli(["import", "status", id, ...cliTarget, "--json"]);
		expect(status.exitCode).toBe(1);
		expect(JSON.parse(status.stdout)).toMatchObject({ operation: { id, state: "cancelled" } });

		const again = await runCli(["import", "cancel", id, ...cliTarget, "--json"]);
		expect(again.exitCode).toBe(0);
		expect(JSON.parse(again.stdout)).toMatchObject({ operationId: id, state: "cancelled" });
	});

	it(
		"explains how to recover when an import stopped after writing to the site",
		{ timeout: 600_000 },
		async () => {
			const output = await exportPackage();
			const cliTarget = ["--url", target.url, "--token", "t"];
			const analyzed = await runCli(["import", output, "--analyze", ...cliTarget, "--json"]);
			const { operationId: id, planDigest } = JSON.parse(analyzed.stdout) as {
				operationId: string;
				planDigest: string;
			};

			target.storage.beforeUpload = (key) => {
				if (!key.startsWith("transfers/")) throw new Error("storage unavailable");
			};
			const failure = await confirmPackage(
				clientFor(target),
				output,
				planDigest,
				silentRuntime(),
			).catch((error: unknown) => error);
			target.storage.beforeUpload = undefined;
			expect(describeError(failure).code).toBe("TRANSFER_STORAGE_ERROR");

			const status = await runCli(["import", "status", id, ...cliTarget], { terminal: true });
			expect(status.exitCode).toBe(1);
			expect(status.stdout).toContain(`Import ${id}: failed`);
			expect(status.stdout).toContain(
				`site writes stay blocked until you abandon it: emdash site import abandon ${id}`,
			);

			const cancel = await runCli(["import", "cancel", id, ...cliTarget, "--json"]);
			expect(cancel.exitCode).toBe(1);
			expect(JSON.parse(cancel.stdout)).toEqual({
				error: {
					code: "TRANSFER_INVALID_STATE",
					message: `Import ${id} has already ended as failed.`,
				},
			});

			const rerun = await runCli(["import", output, "--analyze", ...cliTarget, "--json"]);
			expect(rerun.exitCode).toBe(1);
			const blocked = JSON.parse(rerun.stdout) as { error: { code: string; message: string } };
			expect(blocked.error.message).toBe(
				`Import ${id} failed after it started writing, so this site holds partial data from it and blocks writes. Abandon it with \`emdash site import abandon ${id}\`, then reset this site or set up a new one before importing again.`,
			);

			const isTTY = process.stdin.isTTY;
			process.stdin.isTTY = false;
			try {
				const unconfirmed = await runCli(["import", "abandon", id, ...cliTarget], {
					terminal: true,
				});
				expect(unconfirmed.exitCode).toBe(1);
				expect(unconfirmed.stderr).toContain("Pass --yes to abandon import");
			} finally {
				process.stdin.isTTY = isTTY;
			}
			expect(await operationRows(targetDb, "import")).toEqual([{ id, state: "failed" }]);

			const abandoned = await runCli(["import", "abandon", id, "-y", ...cliTarget], {
				terminal: true,
			});
			expect(abandoned.exitCode).toBe(0);
			expect(abandoned.stdout).toContain(`Import ${id} is abandoned.`);
			expect(abandoned.stdout).toContain("Data the import already wrote was not removed.");

			const afterAbandon = await runCli(["import", output, "--analyze", ...cliTarget, "--json"]);
			expect(afterAbandon.exitCode).toBe(1);
			expect(JSON.parse(afterAbandon.stdout)).toEqual({
				error: {
					code: "TRANSFER_TARGET_NOT_EMPTY",
					message: `Import ${id} wrote partial data to this site before it was abandoned. Reset this site or set up a new one before importing again.`,
				},
			});

			const abandonedStatus = await runCli(["import", "status", id, ...cliTarget, "--json"]);
			expect(abandonedStatus.exitCode).toBe(1);
		},
	);
});
