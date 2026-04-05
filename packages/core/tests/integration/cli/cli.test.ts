/**
 * E2E tests for CLI commands against a real Astro dev server.
 *
 * Shells out to the actual `emdash` binary with --url and --token
 * flags, verifying real command output and exit codes.
 *
 * Runs by default. Requires built artifacts (auto-builds if missing).
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const exec = promisify(execFile);

const PORT = 4398; // Different port from client integration tests

// Path to the built CLI binary
const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

describe("CLI Integration", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	/** Run an emdash CLI command and return stdout */
	async function cli(...args: string[]): Promise<string> {
		const { stdout } = await exec(
			"node",
			[CLI_BIN, ...args, "--url", ctx.baseUrl, "--token", ctx.token, "--json"],
			{
				timeout: 15_000,
			},
		);
		return stdout;
	}

	/** Run CLI and parse JSON output */
	async function cliJson<T = unknown>(...args: string[]): Promise<T> {
		const stdout = await cli(...args);
		return JSON.parse(stdout) as T;
	}

	// -----------------------------------------------------------------------
	// Schema commands
	// -----------------------------------------------------------------------

	describe("schema", () => {
		it("lists collections", async () => {
			const result = await cliJson<{ slug: string }[]>("schema", "list");
			expect(Array.isArray(result)).toBe(true);
			const slugs = result.map((c) => c.slug);
			expect(slugs).toContain("posts");
			expect(slugs).toContain("pages");
		});

		it("gets a single collection", async () => {
			const result = await cliJson<{ slug: string; label: string }>("schema", "get", "posts");
			expect(result.slug).toBe("posts");
			expect(result.label).toBe("Posts");
		});

		it("creates and deletes a collection", async () => {
			const created = await cliJson<{ slug: string }>(
				"schema",
				"create",
				"cli_temp",
				"--label",
				"CLI Temp",
			);
			expect(created.slug).toBe("cli_temp");

			// Verify it exists
			const list = await cliJson<{ slug: string }[]>("schema", "list");
			expect(list.map((c) => c.slug)).toContain("cli_temp");

			// Delete
			await cli("schema", "delete", "cli_temp", "--force");

			// Verify it's gone
			const listAfter = await cliJson<{ slug: string }[]>("schema", "list");
			expect(listAfter.map((c) => c.slug)).not.toContain("cli_temp");
		});

		it("adds and removes fields", async () => {
			// Create a temp collection
			await cli("schema", "create", "cli_fields", "--label", "Fields Test");

			// Add a field
			const field = await cliJson<{ slug: string; type: string }>(
				"schema",
				"add-field",
				"cli_fields",
				"name",
				"--type",
				"string",
				"--label",
				"Name",
			);
			expect(field.slug).toBe("name");
			expect(field.type).toBe("string");

			// Remove the field
			await cli("schema", "remove-field", "cli_fields", "name");

			// Clean up
			await cli("schema", "delete", "cli_fields", "--force");
		});
	});

	// -----------------------------------------------------------------------
	// Content commands
	// -----------------------------------------------------------------------

	describe("content", () => {
		it("lists content", async () => {
			const result = await cliJson<{ items: { data: Record<string, unknown> }[] }>(
				"content",
				"list",
				"posts",
			);
			expect(result.items.length).toBeGreaterThanOrEqual(2);
		});

		it("gets content by id", async () => {
			const postId = ctx.contentIds["posts"]![0]!;
			const result = await cliJson<{ data: { title: string } }>("content", "get", "posts", postId);
			expect(result.data.title).toBe("First Post");
		});

		it("creates, updates, and deletes content", async () => {
			// Create
			const created = await cliJson<{ id: string; slug: string }>(
				"content",
				"create",
				"posts",
				"--data",
				JSON.stringify({ title: "CLI Post", excerpt: "From CLI" }),
				"--slug",
				"cli-post",
			);
			expect(created.id).toBeDefined();
			expect(created.slug).toBe("cli-post");

			// Update (get first to obtain _rev, then update with it)
			const fetched = await cliJson<{ _rev: string }>("content", "get", "posts", created.id);
			const updated = await cliJson<{ data: { title: string } }>(
				"content",
				"update",
				"posts",
				created.id,
				"--rev",
				fetched._rev,
				"--data",
				JSON.stringify({ title: "Updated CLI Post" }),
			);
			expect(updated.data.title).toBe("Updated CLI Post");

			// Delete
			await cli("content", "delete", "posts", created.id);
		});

		it("publishes and unpublishes content", async () => {
			const item = await cliJson<{ id: string }>(
				"content",
				"create",
				"posts",
				"--data",
				JSON.stringify({ title: "Pub Test" }),
			);

			await cli("content", "publish", "posts", item.id);
			await cli("content", "unpublish", "posts", item.id);

			// Clean up
			await cli("content", "delete", "posts", item.id);
		});
	});

	// -----------------------------------------------------------------------
	// Content lifecycle: schedule and restore
	// -----------------------------------------------------------------------

	describe("content lifecycle", () => {
		it("schedules content for publishing", async () => {
			const item = await cliJson<{ id: string }>(
				"content",
				"create",
				"posts",
				"--data",
				JSON.stringify({ title: "CLI Schedule Test" }),
			);

			// Schedule does not produce JSON output, just a success message
			await cli("content", "schedule", "posts", item.id, "--at", "2027-06-01T09:00:00Z");

			// Verify via get
			const fetched = await cliJson<{ scheduledAt: string }>("content", "get", "posts", item.id);
			expect(fetched.scheduledAt).toBe("2027-06-01T09:00:00Z");

			// Clean up
			await cli("content", "delete", "posts", item.id);
		});

		it("restores a trashed item", async () => {
			const item = await cliJson<{ id: string }>(
				"content",
				"create",
				"posts",
				"--data",
				JSON.stringify({ title: "CLI Restore Test" }),
			);

			// Delete (soft trash)
			await cli("content", "delete", "posts", item.id);

			// Restore
			await cli("content", "restore", "posts", item.id);

			// Should be accessible again (auto-published before deletion, so restored as published)
			const fetched = await cliJson<{ status: string }>("content", "get", "posts", item.id);
			expect(fetched.status).toBe("published");

			// Final cleanup
			await cli("content", "delete", "posts", item.id);
		});
	});

	// -----------------------------------------------------------------------
	// Media commands
	// -----------------------------------------------------------------------

	describe("media", () => {
		it("uploads, lists, gets, and deletes media", async () => {
			// Create a temp file to upload
			const { writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const { tmpdir } = await import("node:os");

			// 1x1 PNG pixel
			const pngBytes = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
				0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
				0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
				0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]);
			const tmpFile = join(tmpdir(), "emdash-cli-test.png");
			writeFileSync(tmpFile, pngBytes);

			// Upload
			const uploaded = await cliJson<{ id: string; filename: string }>(
				"media",
				"upload",
				tmpFile,
				"--alt",
				"CLI test image",
			);
			expect(uploaded.id).toBeDefined();
			expect(uploaded.filename).toBe("emdash-cli-test.png");

			// List
			const list = await cliJson<{ items: { id: string }[] }>("media", "list");
			const ids = list.items.map((m) => m.id);
			expect(ids).toContain(uploaded.id);

			// Get
			const fetched = await cliJson<{ id: string; filename: string }>("media", "get", uploaded.id);
			expect(fetched.id).toBe(uploaded.id);

			// Delete
			await cli("media", "delete", uploaded.id);

			// Clean up temp file
			const { unlinkSync } = await import("node:fs");
			unlinkSync(tmpFile);
		});
	});

	// -----------------------------------------------------------------------
	// Search command
	// -----------------------------------------------------------------------

	describe("search", () => {
		it("searches content", async () => {
			// Search should work even if no results (the command shouldn't error)
			const result = await cliJson<unknown[]>("search", "First Post");
			expect(Array.isArray(result)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Auth commands
	// -----------------------------------------------------------------------

	describe("auth", () => {
		it("whoami returns user info with token auth", async () => {
			const result = await cliJson<{ email: string; role: string }>("whoami");
			expect(result.email).toBe("dev@emdash.local");
			expect(result.role).toBe("admin");
		});
	});
});
