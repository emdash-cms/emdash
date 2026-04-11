/**
 * Capability Enforcement Integration Tests (v2)
 *
 * Tests the capability-based access gating in the v2 plugin context.
 * v2 always enforces capabilities - there's no "trusted mode" bypass.
 *
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import {
	PluginContextFactory,
	createContentAccess,
	createContentAccessWithWrite,
	createHttpAccess,
	createUnrestrictedHttpAccess,
	createBlockedHttpAccess,
	createLogAccess,
	createStorageAccess,
	createKVAccess,
	createSiteInfo,
	createUrlHelper,
	createUserAccess,
} from "../../../src/plugins/context.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

// Test regex patterns
const NOT_ALLOWED_FETCH_REGEX = /not allowed to fetch from host/;
const NO_ALLOWED_FETCH_REGEX = /not allowed to fetch/;
const NO_NETWORK_FETCH_REGEX = /does not have the "network:fetch" capability/;
const SEO_NOT_ENABLED_REGEX = /does not have SEO enabled/;

/**
 * Create a minimal resolved plugin for testing
 */
function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: {
			pages: [],
			widgets: [],
			fieldWidgets: {},
		},
		hooks: {},
		routes: {},
		settings: undefined,
		...overrides,
	};
}

describe("Capability Enforcement Integration (v2)", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(async () => {
		// Create in-memory SQLite database
		sqliteDb = new Database(":memory:");

		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({
				database: sqliteDb,
			}),
		});

		// Run migrations
		await runMigrations(db);

		// Create test content table with actual field columns (not JSON data column)
		// The ContentRepository expects real columns for each field
		await sql`
			CREATE TABLE IF NOT EXISTS ec_posts (
				id TEXT PRIMARY KEY,
				slug TEXT,
				status TEXT DEFAULT 'draft',
				author_id TEXT,
				primary_byline_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				updated_at TEXT DEFAULT (datetime('now')),
				published_at TEXT,
				deleted_at TEXT,
				version INTEGER DEFAULT 1,
				locale TEXT NOT NULL DEFAULT 'en',
				translation_group TEXT,
				title TEXT,
				content TEXT,
				UNIQUE(slug, locale)
			)
		`.execute(db);

		// Insert test content with actual column values
		await sql`
			INSERT INTO ec_posts (id, slug, status, title, content, locale, translation_group)
			VALUES 
				('post-1', 'hello-world', 'published', 'Hello World', 'Content 1', 'en', 'post-1'),
				('post-2', 'second-post', 'draft', 'Second Post', 'Content 2', 'en', 'post-2')
		`.execute(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	describe("Content Access", () => {
		describe("createContentAccess (read-only)", () => {
			it("can read content by ID", async () => {
				const access = createContentAccess(db);
				const post = await access.get("posts", "post-1");

				expect(post).not.toBeNull();
				expect(post!.id).toBe("post-1");
				expect(post!.data.title).toBe("Hello World");
			});

			it("can list content", async () => {
				const access = createContentAccess(db);
				const result = await access.list("posts");

				expect(result.items).toHaveLength(2);
				expect(result.hasMore).toBe(false);
			});

			it("returns null for non-existent content", async () => {
				const access = createContentAccess(db);
				const post = await access.get("posts", "non-existent");
				expect(post).toBeNull();
			});
		});

		describe("createContentAccessWithWrite", () => {
			it("includes read methods", async () => {
				const access = createContentAccessWithWrite(db);

				expect(typeof access.get).toBe("function");
				expect(typeof access.list).toBe("function");
			});

			it("includes write methods", async () => {
				const access = createContentAccessWithWrite(db);

				expect(typeof access.create).toBe("function");
				expect(typeof access.update).toBe("function");
				expect(typeof access.delete).toBe("function");
			});

			it("can create new content", async () => {
				const access = createContentAccessWithWrite(db);

				const created = await access.create("posts", {
					title: "New Post",
					content: "New content",
				});

				expect(created.id).toBeDefined();
				expect(created.data.title).toBe("New Post");

				// Verify it was created
				const found = await access.get("posts", created.id);
				expect(found).not.toBeNull();
			});
		});

		describe("SEO panel integration", () => {
			beforeEach(async () => {
				// Register the "posts" collection with SEO enabled so the plugin
				// content API routes `seo` writes to the core SEO panel.
				await sql`
					INSERT INTO _emdash_collections (slug, label, label_singular, has_seo)
					VALUES ('posts', 'Posts', 'Post', 1)
				`.execute(db);
			});

			it("returns seo defaults from get() for SEO-enabled collections", async () => {
				const access = createContentAccess(db);
				const post = await access.get("posts", "post-1");

				expect(post).not.toBeNull();
				expect(post!.seo).toEqual({
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				});
			});

			it("omits seo from get() for collections without SEO enabled", async () => {
				// Reset has_seo on posts so it behaves like a non-SEO collection
				await db
					.updateTable("_emdash_collections")
					.set({ has_seo: 0 })
					.where("slug", "=", "posts")
					.execute();

				const access = createContentAccess(db);
				const post = await access.get("posts", "post-1");

				expect(post).not.toBeNull();
				expect(post!.seo).toBeUndefined();
			});

			it("update() routes `seo` to the SEO panel instead of failing on missing column", async () => {
				const access = createContentAccessWithWrite(db);

				// Regression for #374: previously this threw
				// "SQLite error: no such column: seo"
				const updated = await access.update("posts", "post-1", {
					seo: {
						title: "Custom SEO Title",
						description: "A better meta description",
						canonical: "https://example.com/canonical",
						noIndex: false,
					},
				});

				expect(updated.seo).toEqual({
					title: "Custom SEO Title",
					description: "A better meta description",
					image: null,
					canonical: "https://example.com/canonical",
					noIndex: false,
				});

				// Verify it persisted via a subsequent read
				const fresh = await access.get("posts", "post-1");
				expect(fresh!.seo?.title).toBe("Custom SEO Title");
				expect(fresh!.seo?.description).toBe("A better meta description");
			});

			it("update() accepts field updates alongside seo in a single call", async () => {
				const access = createContentAccessWithWrite(db);

				const updated = await access.update("posts", "post-1", {
					title: "Updated Title",
					seo: {
						title: "SEO Title",
						description: "SEO Description",
					},
				});

				expect(updated.data.title).toBe("Updated Title");
				expect(updated.seo?.title).toBe("SEO Title");
				expect(updated.seo?.description).toBe("SEO Description");
			});

			it("update() only overwrites explicitly-set seo fields (partial updates)", async () => {
				const access = createContentAccessWithWrite(db);

				await access.update("posts", "post-1", {
					seo: { title: "Initial Title", description: "Initial Description" },
				});

				const updated = await access.update("posts", "post-1", {
					seo: { title: "Updated Title" },
				});

				expect(updated.seo?.title).toBe("Updated Title");
				// description must not be clobbered by a partial update
				expect(updated.seo?.description).toBe("Initial Description");
			});

			it("create() routes `seo` to the SEO panel", async () => {
				const access = createContentAccessWithWrite(db);

				const created = await access.create("posts", {
					title: "New Post",
					content: "Body",
					seo: {
						title: "Brand New SEO",
						description: "New Description",
					},
				});

				expect(created.data.title).toBe("New Post");
				expect(created.seo?.title).toBe("Brand New SEO");
				expect(created.seo?.description).toBe("New Description");

				const fresh = await access.get("posts", created.id);
				expect(fresh!.seo?.title).toBe("Brand New SEO");
			});

			it("update() throws when seo is provided on a collection without SEO enabled", async () => {
				// Disable SEO on posts
				await db
					.updateTable("_emdash_collections")
					.set({ has_seo: 0 })
					.where("slug", "=", "posts")
					.execute();

				const access = createContentAccessWithWrite(db);

				await expect(
					access.update("posts", "post-1", {
						seo: { title: "Won't work" },
					}),
				).rejects.toThrow(SEO_NOT_ENABLED_REGEX);
			});

			it("list() hydrates seo for each item in SEO-enabled collections", async () => {
				const access = createContentAccessWithWrite(db);

				await access.update("posts", "post-1", {
					seo: { title: "Post One SEO" },
				});
				await access.update("posts", "post-2", {
					seo: { title: "Post Two SEO" },
				});

				const result = await access.list("posts");
				expect(result.items).toHaveLength(2);

				const byId = new Map(result.items.map((i) => [i.id, i]));
				expect(byId.get("post-1")?.seo?.title).toBe("Post One SEO");
				expect(byId.get("post-2")?.seo?.title).toBe("Post Two SEO");
			});
		});
	});

	describe("HTTP Access", () => {
		describe("createHttpAccess (with host restrictions)", () => {
			it("allows requests to allowed hosts", async () => {
				const http = createHttpAccess("test-plugin", ["example.com"]);

				// We can't actually make the request in tests, but we can verify
				// the function doesn't throw for allowed hosts
				expect(typeof http.fetch).toBe("function");
			});

			it("blocks requests to non-allowed hosts", async () => {
				const http = createHttpAccess("test-plugin", ["example.com"]);

				await expect(http.fetch("https://evil.com/api")).rejects.toThrow(NOT_ALLOWED_FETCH_REGEX);
			});

			it("supports wildcard host patterns", { timeout: 15000 }, async () => {
				const http = createHttpAccess("test-plugin", ["*.example.com"]);

				// Should not throw for subdomains
				// (Can't test actual fetch, but verify pattern matching logic)
				await expect(http.fetch("https://api.example.com/test")).rejects.not.toThrow(
					NO_ALLOWED_FETCH_REGEX,
				);
			});
		});

		describe("createBlockedHttpAccess", () => {
			it("always throws", async () => {
				const http = createBlockedHttpAccess("no-network-plugin");

				await expect(http.fetch("https://example.com")).rejects.toThrow(NO_NETWORK_FETCH_REGEX);
			});
		});

		describe("createUnrestrictedHttpAccess", () => {
			it("returns an HttpAccess with a fetch function", () => {
				const http = createUnrestrictedHttpAccess("unrestricted-plugin");
				expect(typeof http.fetch).toBe("function");
			});

			it("does not throw for any host", async () => {
				const http = createUnrestrictedHttpAccess("unrestricted-plugin");
				// Can't make a real request in tests, but verify it doesn't throw a
				// host-validation error — it will throw a network error instead.
				await expect(http.fetch("https://any-host-at-all.example.com/test")).rejects.not.toThrow(
					NOT_ALLOWED_FETCH_REGEX,
				);
			});
		});
	});

	describe("Storage Access", () => {
		it("creates collection accessors from config", () => {
			const storage = createStorageAccess(db, "test-plugin", {
				events: { indexes: ["type"] },
				cache: { indexes: ["key"] },
			});

			expect(storage.events).toBeDefined();
			expect(storage.cache).toBeDefined();
		});

		it("provides full StorageCollection API", () => {
			const storage = createStorageAccess(db, "test-plugin", {
				items: { indexes: [] },
			});

			const collection = storage.items;
			expect(typeof collection.get).toBe("function");
			expect(typeof collection.put).toBe("function");
			expect(typeof collection.delete).toBe("function");
			expect(typeof collection.exists).toBe("function");
			expect(typeof collection.getMany).toBe("function");
			expect(typeof collection.putMany).toBe("function");
			expect(typeof collection.deleteMany).toBe("function");
			expect(typeof collection.query).toBe("function");
			expect(typeof collection.count).toBe("function");
		});

		it("isolates storage between plugins", async () => {
			const storage1 = createStorageAccess(db, "plugin-1", {
				items: { indexes: [] },
			});
			const storage2 = createStorageAccess(db, "plugin-2", {
				items: { indexes: [] },
			});

			await storage1.items.put("doc-1", { value: "from plugin 1" });

			// Plugin 2 should not see plugin 1's data
			const fromPlugin2 = await storage2.items.get("doc-1");
			expect(fromPlugin2).toBeNull();

			// Plugin 1 should still see its data
			const fromPlugin1 = await storage1.items.get("doc-1");
			expect(fromPlugin1).toEqual({ value: "from plugin 1" });
		});
	});

	describe("KV Access", () => {
		it("prefixes keys with plugin ID", async () => {
			const optionsRepo = new OptionsRepository(db);
			const kv = createKVAccess(optionsRepo, "test-plugin");

			await kv.set("my-key", { foo: "bar" });

			// Verify the key is prefixed in the database
			const rawValue = await optionsRepo.get("plugin:test-plugin:my-key");
			expect(rawValue).toEqual({ foo: "bar" });
		});

		it("isolates KV between plugins", async () => {
			const optionsRepo = new OptionsRepository(db);
			const kv1 = createKVAccess(optionsRepo, "plugin-1");
			const kv2 = createKVAccess(optionsRepo, "plugin-2");

			await kv1.set("shared-key", "value from 1");
			await kv2.set("shared-key", "value from 2");

			expect(await kv1.get("shared-key")).toBe("value from 1");
			expect(await kv2.get("shared-key")).toBe("value from 2");
		});

		it("supports listing keys with prefix", async () => {
			const optionsRepo = new OptionsRepository(db);
			const kv = createKVAccess(optionsRepo, "test-plugin");

			await kv.set("settings:theme", "dark");
			await kv.set("settings:lang", "en");
			await kv.set("cache:user-1", { name: "John" });

			const settings = await kv.list("settings:");
			expect(settings).toHaveLength(2);
			expect(settings.map((s) => s.key).toSorted()).toEqual(["settings:lang", "settings:theme"]);
		});
	});

	describe("Log Access", () => {
		it("prefixes messages with plugin ID", () => {
			const log = createLogAccess("test-plugin");

			// These just verify the methods exist and don't throw
			expect(() => log.debug("test message")).not.toThrow();
			expect(() => log.info("test message", { extra: "data" })).not.toThrow();
			expect(() => log.warn("test warning")).not.toThrow();
			expect(() => log.error("test error")).not.toThrow();
		});
	});

	describe("PluginContextFactory", () => {
		it("creates context with capability-gated access", () => {
			const factory = new PluginContextFactory({ db });

			const readOnlyPlugin = createTestPlugin({
				id: "reader",
				capabilities: ["read:content"],
			});

			const ctx = factory.createContext(readOnlyPlugin);

			// Content should be read-only (no create/update/delete)
			expect(ctx.content).toBeDefined();
			expect(typeof ctx.content!.get).toBe("function");
			expect(typeof ctx.content!.list).toBe("function");
			expect("create" in ctx.content!).toBe(false);
		});

		it("provides undefined content for plugins without capability", () => {
			const factory = new PluginContextFactory({ db });

			const noContentPlugin = createTestPlugin({
				id: "no-content",
				capabilities: ["network:fetch"],
			});

			const ctx = factory.createContext(noContentPlugin);
			expect(ctx.content).toBeUndefined();
		});

		it("provides http for plugins with network:fetch", () => {
			const factory = new PluginContextFactory({ db });

			const networkPlugin = createTestPlugin({
				id: "network",
				capabilities: ["network:fetch"],
				allowedHosts: ["api.example.com"],
			});

			const ctx = factory.createContext(networkPlugin);
			expect(ctx.http).toBeDefined();
			expect(typeof ctx.http!.fetch).toBe("function");
		});

		it("provides undefined http for plugins without capability", () => {
			const factory = new PluginContextFactory({ db });

			const noNetworkPlugin = createTestPlugin({
				id: "no-network",
				capabilities: [],
			});

			const ctx = factory.createContext(noNetworkPlugin);
			expect(ctx.http).toBeUndefined();
		});

		it("provides unrestricted http for plugins with network:fetch:any", () => {
			const factory = new PluginContextFactory({ db });

			const plugin = createTestPlugin({
				id: "unrestricted-network",
				capabilities: ["network:fetch:any", "network:fetch"],
			});

			const ctx = factory.createContext(plugin);
			expect(ctx.http).toBeDefined();
			expect(typeof ctx.http!.fetch).toBe("function");
		});

		it("prefers network:fetch:any over network:fetch when both present", async () => {
			const factory = new PluginContextFactory({ db });

			const plugin = createTestPlugin({
				id: "both-fetch",
				capabilities: ["network:fetch", "network:fetch:any"],
				allowedHosts: ["restricted.example.com"],
			});

			const ctx = factory.createContext(plugin);
			expect(ctx.http).toBeDefined();
			// With network:fetch:any, arbitrary hosts should not throw a host validation error
			await expect(ctx.http!.fetch("https://unrestricted.example.com/test")).rejects.not.toThrow(
				NOT_ALLOWED_FETCH_REGEX,
			);
		});

		it("always provides kv, storage, and log", () => {
			const factory = new PluginContextFactory({ db });

			const minimalPlugin = createTestPlugin({
				id: "minimal",
				capabilities: [],
				storage: {
					items: { indexes: [] },
				},
			});

			const ctx = factory.createContext(minimalPlugin);

			expect(ctx.kv).toBeDefined();
			expect(ctx.storage).toBeDefined();
			expect(ctx.storage.items).toBeDefined();
			expect(ctx.log).toBeDefined();
		});

		it("provides write:content access with create/update/delete", () => {
			const factory = new PluginContextFactory({ db });

			const writePlugin = createTestPlugin({
				id: "writer",
				capabilities: ["write:content"],
			});

			const ctx = factory.createContext(writePlugin);

			expect(ctx.content).toBeDefined();
			expect("create" in ctx.content!).toBe(true);
			expect("update" in ctx.content!).toBe(true);
			expect("delete" in ctx.content!).toBe(true);
		});

		it("always provides site info", () => {
			const factory = new PluginContextFactory({ db });

			const plugin = createTestPlugin({ id: "site-test", capabilities: [] });
			const ctx = factory.createContext(plugin);

			expect(ctx.site).toBeDefined();
			expect(typeof ctx.site.name).toBe("string");
			expect(typeof ctx.site.url).toBe("string");
			expect(typeof ctx.site.locale).toBe("string");
		});

		it("always provides url() helper", () => {
			const factory = new PluginContextFactory({
				db,
				siteInfo: { siteUrl: "https://example.com" },
			});

			const plugin = createTestPlugin({ id: "url-test", capabilities: [] });
			const ctx = factory.createContext(plugin);

			expect(typeof ctx.url).toBe("function");
			expect(ctx.url("/posts")).toBe("https://example.com/posts");
		});

		it("provides users for plugins with read:users", () => {
			const factory = new PluginContextFactory({ db });

			const plugin = createTestPlugin({
				id: "user-reader",
				capabilities: ["read:users"],
			});

			const ctx = factory.createContext(plugin);
			expect(ctx.users).toBeDefined();
			expect(typeof ctx.users!.get).toBe("function");
			expect(typeof ctx.users!.getByEmail).toBe("function");
			expect(typeof ctx.users!.list).toBe("function");
		});

		it("provides undefined users for plugins without read:users", () => {
			const factory = new PluginContextFactory({ db });

			const plugin = createTestPlugin({
				id: "no-users",
				capabilities: [],
			});

			const ctx = factory.createContext(plugin);
			expect(ctx.users).toBeUndefined();
		});
	});

	describe("Site Info", () => {
		it("creates site info with all options", () => {
			const info = createSiteInfo({
				siteName: "My Site",
				siteUrl: "https://example.com/",
				locale: "fr",
			});

			expect(info.name).toBe("My Site");
			expect(info.url).toBe("https://example.com"); // trailing slash stripped
			expect(info.locale).toBe("fr");
		});

		it("uses defaults for missing values", () => {
			const info = createSiteInfo({});

			expect(info.name).toBe("");
			expect(info.url).toBe("");
			expect(info.locale).toBe("en");
		});

		it("strips trailing slash from URL", () => {
			const info = createSiteInfo({ siteUrl: "https://example.com/" });
			expect(info.url).toBe("https://example.com");
		});
	});

	describe("URL Helper", () => {
		it("creates absolute URLs from paths", () => {
			const url = createUrlHelper("https://example.com");
			expect(url("/posts")).toBe("https://example.com/posts");
			expect(url("/")).toBe("https://example.com/");
		});

		it("strips trailing slash from base URL", () => {
			const url = createUrlHelper("https://example.com/");
			expect(url("/posts")).toBe("https://example.com/posts");
		});

		it("throws for paths not starting with /", () => {
			const url = createUrlHelper("https://example.com");
			expect(() => url("posts")).toThrow('URL path must start with "/"');
		});

		it("works with empty base URL", () => {
			const url = createUrlHelper("");
			expect(url("/posts")).toBe("/posts");
		});

		it("rejects protocol-relative paths (//)", () => {
			const url = createUrlHelper("https://example.com");
			expect(() => url("//evil.com")).toThrow("protocol-relative");
		});

		it("rejects protocol-relative paths with empty base URL", () => {
			const url = createUrlHelper("");
			expect(() => url("//evil.com/path")).toThrow("protocol-relative");
		});
	});

	describe("User Access", () => {
		let userRepo: UserRepository;

		beforeEach(async () => {
			userRepo = new UserRepository(db);

			// Create test users with all 5 role levels
			await userRepo.create({ email: "admin@test.com", name: "Admin User", role: "admin" });
			await userRepo.create({ email: "editor@test.com", name: "Editor User", role: "editor" });
			await userRepo.create({ email: "author@test.com", name: "Author User", role: "author" });
			await userRepo.create({
				email: "contrib@test.com",
				name: "Contributor User",
				role: "contributor",
			});
			await userRepo.create({
				email: "sub@test.com",
				name: "Subscriber User",
				role: "subscriber",
			});
		});

		it("gets user by ID", async () => {
			const user = await userRepo.findByEmail("admin@test.com");
			const access = createUserAccess(db);

			const result = await access.get(user!.id);
			expect(result).not.toBeNull();
			expect(result!.email).toBe("admin@test.com");
			expect(result!.name).toBe("Admin User");
			expect(result!.role).toBe(50); // admin = 50
		});

		it("gets user by email", async () => {
			const access = createUserAccess(db);

			const result = await access.getByEmail("editor@test.com");
			expect(result).not.toBeNull();
			expect(result!.email).toBe("editor@test.com");
			expect(result!.role).toBe(40); // editor = 40
		});

		it("returns null for non-existent user", async () => {
			const access = createUserAccess(db);

			expect(await access.get("non-existent")).toBeNull();
			expect(await access.getByEmail("nobody@test.com")).toBeNull();
		});

		it("lists users", async () => {
			const access = createUserAccess(db);

			const result = await access.list();
			expect(result.items).toHaveLength(5);
			// All users should have role as number
			for (const user of result.items) {
				expect(typeof user.role).toBe("number");
			}
		});

		it("excludes sensitive fields", async () => {
			const access = createUserAccess(db);

			const result = await access.list();
			for (const user of result.items) {
				// UserInfo should only have: id, email, name, role, createdAt
				const keys = Object.keys(user);
				expect(keys).toContain("id");
				expect(keys).toContain("email");
				expect(keys).toContain("name");
				expect(keys).toContain("role");
				expect(keys).toContain("createdAt");
				// Should NOT have sensitive fields
				expect(keys).not.toContain("avatarUrl");
				expect(keys).not.toContain("emailVerified");
				expect(keys).not.toContain("data");
				expect(keys).not.toContain("password_hash");
			}
		});

		it("converts role strings to numeric levels", async () => {
			const access = createUserAccess(db);

			const admin = await access.getByEmail("admin@test.com");
			const editor = await access.getByEmail("editor@test.com");
			const subscriber = await access.getByEmail("sub@test.com");

			expect(admin!.role).toBe(50);
			expect(editor!.role).toBe(40);
			expect(subscriber!.role).toBe(10);
		});

		it("respects limit on list", async () => {
			const access = createUserAccess(db);

			const result = await access.list({ limit: 2 });
			expect(result.items).toHaveLength(2);
			expect(result.nextCursor).toBeDefined();
		});

		it("clamps limit to maximum of 100", async () => {
			const access = createUserAccess(db);

			// Should not throw for large limits — just clamp
			const result = await access.list({ limit: 500 });
			expect(result.items).toHaveLength(5);
		});

		it("clamps negative limit to minimum of 1", async () => {
			const access = createUserAccess(db);

			// Negative limit should be clamped to 1, not passed through
			const result = await access.list({ limit: -999 });
			expect(result.items).toHaveLength(1);
		});

		it("preserves contributor (20) and author (30) roles", async () => {
			// beforeEach creates users via UserRepository with all 5 roles.
			// Verify that contributor (20) and author (30) survive the round-trip.
			const access = createUserAccess(db);

			const contributor = await access.getByEmail("contrib@test.com");
			expect(contributor).not.toBeNull();
			expect(contributor!.role).toBe(20);

			const author = await access.getByEmail("author@test.com");
			expect(author).not.toBeNull();
			expect(author!.role).toBe(30);
		});

		it("filters users by exact role number", async () => {
			// beforeEach creates one user per role level (10, 20, 30, 40, 50)
			const access = createUserAccess(db);

			const contributors = await access.list({ role: 20 });
			expect(contributors.items).toHaveLength(1);
			expect(contributors.items[0]!.email).toBe("contrib@test.com");
			expect(contributors.items[0]!.role).toBe(20);

			const authors = await access.list({ role: 30 });
			expect(authors.items).toHaveLength(1);
			expect(authors.items[0]!.email).toBe("author@test.com");
			expect(authors.items[0]!.role).toBe(30);

			const admins = await access.list({ role: 50 });
			expect(admins.items).toHaveLength(1);
			expect(admins.items[0]!.email).toBe("admin@test.com");
		});

		it("supports cursor-based pagination", async () => {
			const access = createUserAccess(db);
			const seen = new Set<string>();

			// Page through all 5 users one at a time
			let cursor: string | undefined;
			let pageCount = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const page = await access.list({ limit: 1, cursor });
				if (page.items.length === 0) break;

				expect(page.items).toHaveLength(1);
				const userId = page.items[0]!.id;
				expect(seen.has(userId)).toBe(false); // no duplicates
				seen.add(userId);
				pageCount++;

				if (!page.nextCursor) break; // last page
				cursor = page.nextCursor;
			}

			expect(seen.size).toBe(5);
			expect(pageCount).toBe(5);
		});
	});
});
