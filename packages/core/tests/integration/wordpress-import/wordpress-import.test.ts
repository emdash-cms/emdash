/**
 * E2E tests for WordPress import CLI
 *
 * Tests the full two-phase import flow:
 * - Phase 1: Prepare (analyze WXR, generate config)
 * - Phase 2: Execute (import content using config)
 *
 * Also tests: --dry-run, --resume, --json flags
 */

import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	prepareWordPressImport,
	executeWordPressImport,
	type MigrationConfig,
	type ImportProgress,
} from "../../../src/cli/commands/import/wordpress.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "sample-export.xml");

describe("WordPress Import Integration", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "emdash-wp-import-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("Phase 1: Prepare", () => {
		it("analyzes WXR and generates migration config", async () => {
			const configPath = join(testDir, ".wp-migration.json");

			await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: false,
			});

			// Check config was created
			const configContent = await readFile(configPath, "utf-8");
			const config: MigrationConfig = JSON.parse(configContent);

			// Verify site info
			expect(config.site.title).toBe("Test Blog");
			expect(config.site.url).toBe("https://example.com");

			// Verify collections discovered
			expect(config.collections.post).toEqual({
				collection: "posts",
				enabled: true,
				count: 3,
			});
			expect(config.collections.page).toEqual({
				collection: "pages",
				enabled: true,
				count: 2,
			});

			// nav_menu_item should be disabled (if it exists in the export)
			if (config.collections.nav_menu_item) {
				expect(config.collections.nav_menu_item.enabled).toBe(false);
			}

			// Verify custom fields discovered
			expect(config.fields._yoast_wpseo_title).toEqual({
				field: "seo.title",
				type: "string",
				enabled: true,
				count: 1,
				samples: expect.any(Array),
			});
			expect(config.fields._yoast_wpseo_metadesc?.field).toBe("seo.description");
			expect(config.fields._thumbnail_id?.field).toBe("featuredImage");
			expect(config.fields.custom_field?.enabled).toBe(true);

			// Internal fields should be disabled
			expect(config.fields._edit_last?.enabled).toBe(false);
		});

		it("generates suggested live.config.ts", async () => {
			const configPath = join(testDir, ".wp-migration.json");

			await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: false,
			});

			const liveConfigPath = join(testDir, "suggested-live.config.ts");
			const liveConfig = await readFile(liveConfigPath, "utf-8");

			// Collections are now created via Admin UI, so this generates helpful comments
			expect(liveConfig).toContain("Suggested EmDash collections");
			expect(liveConfig).toContain("/_emdash/admin/content-types");
			expect(liveConfig).toContain('post → "posts"');
			expect(liveConfig).toContain('page → "pages"');
			expect(liveConfig).toContain("portableText");
		});

		it("dry-run does not create files", async () => {
			const configPath = join(testDir, ".wp-migration.json");

			const result = await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: true,
				json: false,
			});

			// Result should indicate dry run
			expect(result.dryRun).toBe(true);
			expect(result.files).toContainEqual({
				path: configPath,
				action: "would_create",
			});

			// Files should NOT exist
			await expect(readFile(configPath)).rejects.toThrow();
			await expect(readFile(join(testDir, "suggested-live.config.ts"))).rejects.toThrow();
		});

		it("returns structured JSON result", async () => {
			const configPath = join(testDir, ".wp-migration.json");

			const result = await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: true,
			});

			expect(result.success).toBe(true);
			expect(result.phase).toBe("prepare");
			expect(result.summary.postsAnalyzed).toBe(7); // 3 posts + 2 pages + 1 attachment + 1 wp_block (excludes nav_menu_item)
			expect(result.files.length).toBe(2);
			expect(result.nextSteps.length).toBeGreaterThan(0);
		});

		it("disables ACF's internal post types", async () => {
			const wxrPath = join(testDir, "acf-export.xml");
			const configPath = join(testDir, ".wp-migration.json");
			const items = ["post", "acf-field-group", "acf-field"]
				.map(
					(type, i) => `<item>
					<title>Item ${i + 1}</title>
					<wp:post_id>${i + 1}</wp:post_id>
					<wp:post_type>${type}</wp:post_type>
					<wp:status>publish</wp:status>
					<wp:post_name>item-${i + 1}</wp:post_name>
				</item>`,
				)
				.join("\n");
			await writeFile(
				wxrPath,
				`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel>
		<title>Test Site</title>
		<link>https://example.com</link>
		${items}
	</channel>
</rss>`,
			);

			await prepareWordPressImport(wxrPath, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: false,
			});

			const config: MigrationConfig = JSON.parse(await readFile(configPath, "utf-8"));
			expect(config.collections.post?.enabled).toBe(true);
			expect(config.collections["acf-field-group"]?.enabled).toBe(false);
			expect(config.collections["acf-field"]?.enabled).toBe(false);
		});
	});

	describe("Phase 2: Execute", () => {
		let configPath: string;

		beforeEach(async () => {
			// Run prepare first to create config
			configPath = join(testDir, ".wp-migration.json");
			await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: false,
			});
		});

		it("imports posts and pages to correct directories", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			// Check posts directory
			const posts = await readdir(join(testDir, "posts"));
			expect(posts).toContain("hello-world.json");
			expect(posts).toContain("advanced-features.json");
			expect(posts).toContain("work-in-progress.json");
			expect(posts.length).toBe(3);

			// Check pages directory
			const pages = await readdir(join(testDir, "pages"));
			expect(pages).toContain("about.json");
			expect(pages).toContain("contact.json");
			expect(pages.length).toBe(2);
		});

		it("converts Gutenberg blocks to Portable Text", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const postContent = await readFile(join(testDir, "posts", "hello-world.json"), "utf-8");
			const post = JSON.parse(postContent);

			// Check content is Portable Text array
			expect(Array.isArray(post.content)).toBe(true);
			expect(post.content.length).toBeGreaterThan(0);

			// Check for expected block types
			const blockTypes = post.content.map((b: { _type: string }) => b._type);
			expect(blockTypes).toContain("block"); // paragraphs and headings

			// Check paragraph content
			const firstBlock = post.content[0];
			expect(firstBlock._type).toBe("block");
			expect(firstBlock.children[0].text).toContain("Welcome to our new blog");
		});

		it("maps custom fields correctly", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const postContent = await readFile(join(testDir, "posts", "hello-world.json"), "utf-8");
			const post = JSON.parse(postContent);

			// Check SEO fields (nested)
			expect(post.seo?.title).toBe("Hello World - Welcome Post");
			expect(post.seo?.description).toBe("Our first blog post welcoming visitors.");

			// Check custom field
			expect(post.custom_field).toBe("custom value");
		});

		it("preserves post metadata", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const postContent = await readFile(join(testDir, "posts", "hello-world.json"), "utf-8");
			const post = JSON.parse(postContent);

			expect(post.title).toBe("Hello World");
			expect(post.status).toBe("published");
			expect(post.author).toBe("admin");
			expect(post.excerpt).toBe("Welcome to our new blog!");
			expect(post.categories).toContain("tutorials");
			expect(post.tags).toContain("featured");

			// Check WordPress metadata preserved
			expect(post._wp.id).toBe(1);
			expect(post._wp.link).toBe("https://example.com/2025/01/hello-world/");
		});

		it("handles draft posts correctly", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const postContent = await readFile(join(testDir, "posts", "work-in-progress.json"), "utf-8");
			const post = JSON.parse(postContent);

			expect(post.status).toBe("draft");
		});

		it("creates redirects map", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const redirectsContent = await readFile(join(testDir, "_redirects.json"), "utf-8");
			const redirects = JSON.parse(redirectsContent);

			expect(redirects["https://example.com/2025/01/hello-world/"]).toBe("/posts/hello-world");
			expect(redirects["https://example.com/about/"]).toBe("/pages/about");
		});

		it("dry-run shows what would be created", async () => {
			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: true,
				json: false,
				resume: false,
			});

			expect(result.dryRun).toBe(true);
			expect(result.summary.postsImported).toBe(5);

			// Check files would be created
			const wouldCreate = result.files.filter((f) => f.action === "would_create");
			expect(wouldCreate.length).toBeGreaterThan(0);

			// Actual files should NOT exist
			await expect(readdir(join(testDir, "posts"))).rejects.toThrow();
		});

		it("creates progress file for resumability", async () => {
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			const progressContent = await readFile(join(testDir, ".wp-migration-progress.json"), "utf-8");
			const progress: ImportProgress = JSON.parse(progressContent);

			expect(progress.importedPosts.length).toBe(5);
			expect(progress.stats.importedPosts).toBe(5);
			expect(progress.stats.totalPosts).toBe(7); // 3 posts + 2 pages + 1 attachment + 1 wp_block (nav_menu_item excluded)
			expect(progress.errors.length).toBe(0);
		});

		it("resume skips already-imported posts", async () => {
			// First import
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			// Second import with resume
			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: true,
				resume: true,
			});

			// All should be skipped (resumed)
			expect(result.summary.postsImported).toBe(0);
			expect(result.summary.postsSkipped).toBe(7); // 5 content items + 1 attachment + 1 wp_block
		});

		it("resume imports only new posts", async () => {
			// First import
			await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: false,
				resume: false,
			});

			// Modify progress to simulate partial import
			const progressPath = join(testDir, ".wp-migration-progress.json");
			const progressContent = await readFile(progressPath, "utf-8");
			const progress: ImportProgress = JSON.parse(progressContent);

			// Remove last 2 posts from imported list
			progress.importedPosts = progress.importedPosts.slice(0, 3);
			progress.stats.importedPosts = 3;
			await writeFile(progressPath, JSON.stringify(progress, null, 2));

			// Delete those files too
			await rm(join(testDir, "pages", "about.json"));
			await rm(join(testDir, "pages", "contact.json"));

			// Resume import
			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: true,
				resume: true,
			});

			// Should import only the 2 missing pages
			expect(result.summary.postsImported).toBe(2);
			expect(result.summary.postsSkipped).toBe(5); // 3 + 1 attachment + 1 wp_block

			// Files should exist again
			const pages = await readdir(join(testDir, "pages"));
			expect(pages).toContain("about.json");
			expect(pages).toContain("contact.json");
		});

		it("returns structured JSON result", async () => {
			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: true,
				resume: false,
			});

			expect(result.success).toBe(true);
			expect(result.phase).toBe("execute");
			expect(result.summary.postsImported).toBe(5);
			expect(result.summary.errors).toBe(0);
			expect(result.files.length).toBeGreaterThan(0);
			expect(result.files.every((f) => f.action === "created")).toBe(true);
		});

		it("skips disabled post types", async () => {
			// Modify config to disable pages
			const config: MigrationConfig = JSON.parse(await readFile(configPath, "utf-8"));
			config.collections.page.enabled = false;
			await writeFile(configPath, JSON.stringify(config, null, 2));

			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: true,
				resume: false,
			});

			// Only posts should be imported
			expect(result.summary.postsImported).toBe(3);
			expect(result.summary.postsSkipped).toBe(4); // 2 pages + 1 attachment + 1 wp_block

			// Pages directory should not exist
			await expect(readdir(join(testDir, "pages"))).rejects.toThrow();
		});
	});

	describe("Edge Cases", () => {
		it("handles missing config file gracefully", async () => {
			const badConfigPath = join(testDir, "nonexistent.json");

			await expect(
				executeWordPressImport(FIXTURE_PATH, {
					outputDir: testDir,
					configPath: badConfigPath,
					skipMedia: true,
					verbose: false,
					dryRun: false,
					json: false,
					resume: false,
				}),
			).rejects.toThrow();
		});

		it("handles empty progress file on resume", async () => {
			// Create config first
			const configPath = join(testDir, ".wp-migration.json");
			await prepareWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				verbose: false,
				dryRun: false,
				json: false,
			});

			// Resume without prior import should work (fresh start)
			const result = await executeWordPressImport(FIXTURE_PATH, {
				outputDir: testDir,
				configPath,
				skipMedia: true,
				verbose: false,
				dryRun: false,
				json: true,
				resume: true,
			});

			expect(result.summary.postsImported).toBe(5);
		});
	});
});
