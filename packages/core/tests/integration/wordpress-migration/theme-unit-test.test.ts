/**
 * Integration tests using WordPress Theme Unit Test data
 *
 * Tests the full WordPress migration pipeline against the official
 * WordPress Theme Unit Test dataset. The test data is downloaded from
 * GitHub on first run and cached locally.
 *
 * @see https://github.com/WordPress/theme-test-data
 */

import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, it, expect, beforeAll } from "vitest";

import { parseWxr } from "../../../src/cli/wxr/parser.js";

// Test regex patterns
const PARAGRAPH_WITH_TEXT_REGEX = /<p[^>]*>[^<]+<\/p>/;

const TEST_DATA_PATH = join(
	process.cwd(),
	"../../examples/wp-theme-unit-test/themeunittestdata.wordpress.xml",
);

const TEST_DATA_URL =
	"https://raw.githubusercontent.com/WordPress/theme-test-data/master/themeunittestdata.wordpress.xml";

/**
 * Download the WordPress theme unit test data if it doesn't exist locally.
 */
async function ensureTestData(): Promise<void> {
	if (existsSync(TEST_DATA_PATH)) return;

	console.log(`Downloading WordPress theme unit test data from ${TEST_DATA_URL}...`);
	const response = await fetch(TEST_DATA_URL);
	if (!response.ok) {
		throw new Error(`Failed to download test data: ${response.status} ${response.statusText}`);
	}
	const data = await response.text();
	await mkdir(dirname(TEST_DATA_PATH), { recursive: true });
	await writeFile(TEST_DATA_PATH, data, "utf-8");
	console.log(`Downloaded to ${TEST_DATA_PATH}`);
}

describe("WordPress Theme Unit Test Migration", () => {
	let wxrData: Awaited<ReturnType<typeof parseWxr>>;

	beforeAll(async () => {
		await ensureTestData();
		const stream = createReadStream(TEST_DATA_PATH, { encoding: "utf-8" });
		wxrData = await parseWxr(stream);
	});

	describe("WXR Parsing", () => {
		it("parses site metadata", () => {
			expect(wxrData.site.title).toBe("Theme Unit Test Data");
			expect(wxrData.site.link).toBe("https://wpthemetestdata.wordpress.com");
			expect(wxrData.site.language).toBe("en");
		});

		it("parses all posts", () => {
			// Theme Unit Test has many posts covering different scenarios
			expect(wxrData.posts.length).toBeGreaterThan(50);
		});

		it("parses all pages", () => {
			const pages = wxrData.posts.filter((p) => p.postType === "page");
			expect(pages.length).toBeGreaterThan(10);
		});

		it("parses categories with hierarchy", () => {
			expect(wxrData.categories.length).toBeGreaterThan(20);

			// Check for parent-child relationships
			const parentCategory = wxrData.categories.find((c) => c.nicename === "parent-category");
			expect(parentCategory).toBeDefined();

			const childCategory = wxrData.categories.find((c) => c.nicename === "child-category-01");
			expect(childCategory).toBeDefined();
			expect(childCategory?.parent).toBe("parent-category");
		});

		it("parses tags", () => {
			expect(wxrData.tags.length).toBeGreaterThan(50);

			// Check for specific tags
			const wpTag = wxrData.tags.find((t) => t.slug === "wordpress");
			expect(wpTag).toBeDefined();
			expect(wpTag?.name).toBe("WordPress");
		});

		it("parses authors", () => {
			expect(wxrData.authors.length).toBeGreaterThanOrEqual(1);

			const author = wxrData.authors.find((a) => a.login === "themereviewteam");
			expect(author).toBeDefined();
			expect(author?.displayName).toBe("Theme Reviewer");
		});

		it("parses attachments", () => {
			expect(wxrData.attachments.length).toBeGreaterThan(0);
		});

		it("parses post categories and tags", () => {
			// Find a post with both categories and tags
			const postsWithTaxonomies = wxrData.posts.filter(
				(p) => p.categories.length > 0 || p.tags.length > 0,
			);
			expect(postsWithTaxonomies.length).toBeGreaterThan(0);
		});
	});

	describe("Gutenberg Block Conversion", () => {
		it("converts paragraph blocks", () => {
			const post = wxrData.posts.find((p) => p.content?.includes("wp:paragraph"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			expect(result.length).toBeGreaterThan(0);

			const block = result.find((b) => b._type === "block");
			expect(block).toBeDefined();
		});

		it("converts heading blocks with different levels", () => {
			const post = wxrData.posts.find((p) => p.title === "WP 6.1 Font size scale");
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");

			// Should have h2 headings
			const headings = result.filter(
				(b) => b._type === "block" && (b as any).style?.startsWith("h"),
			);
			expect(headings.length).toBeGreaterThan(0);
		});

		it("converts list blocks", () => {
			// Find a post with list content
			const post = wxrData.posts.find((p) => p.content?.includes("wp:list"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			const listItems = result.filter((b) => b._type === "block" && (b as any).listItem);
			expect(listItems.length).toBeGreaterThan(0);
		});

		it("converts image blocks", () => {
			const post = wxrData.posts.find((p) => p.content?.includes("wp:image"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			const images = result.filter((b) => b._type === "image");
			expect(images.length).toBeGreaterThan(0);
		});

		it("converts quote blocks", () => {
			const post = wxrData.posts.find((p) => p.content?.includes("wp:quote"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			const quotes = result.filter((b) => b._type === "block" && (b as any).style === "blockquote");
			expect(quotes.length).toBeGreaterThan(0);
		});

		it("converts code blocks", () => {
			const post = wxrData.posts.find((p) => p.content?.includes("wp:code"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			const codeBlocks = result.filter((b) => b._type === "code");
			expect(codeBlocks.length).toBeGreaterThan(0);
		});

		it("converts group blocks by flattening", () => {
			const post = wxrData.posts.find((p) => p.content?.includes("wp:group"));
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			// Groups should be flattened - no group type in output
			const groups = result.filter((b) => b._type === "group");
			expect(groups.length).toBe(0);

			// But their content should still be present
			expect(result.length).toBeGreaterThan(0);
		});

		it("handles classic editor content", () => {
			// Find a post in the "Classic" category
			const classicPost = wxrData.posts.find((p) => p.categories.includes("classic"));
			expect(classicPost).toBeDefined();
			expect(classicPost!.content?.trim()).toBeTruthy();

			const result = gutenbergToPortableText(classicPost!.content);
			expect(result.length).toBeGreaterThan(0);
		});

		it("preserves inline formatting", () => {
			const post = wxrData.posts.find(
				(p) => p.content?.includes("<strong>") || p.content?.includes("<em>"),
			);
			expect(post).toBeDefined();

			const result = gutenbergToPortableText(post!.content || "");
			const blocksWithMarks = result.filter(
				(b) => b._type === "block" && (b as any).children?.some((c: any) => c.marks?.length > 0),
			);
			// Inline <strong>/<em> must survive as Portable Text marks.
			expect(blocksWithMarks.length).toBeGreaterThan(0);
		});

		it("handles empty content gracefully", () => {
			const result = gutenbergToPortableText("");
			expect(result).toEqual([]);
		});

		it("handles malformed blocks gracefully", () => {
			// Test with incomplete block markers
			const malformed = "<!-- wp:paragraph --><p>Test<!-- /wp:paragraph";
			const result = gutenbergToPortableText(malformed);
			// Should not throw, may produce partial output or fallback
			expect(Array.isArray(result)).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		it("handles posts with special characters in title", () => {
			// Find posts with special characters
			const specialPosts = wxrData.posts.filter(
				(p) => p.title?.includes("&") || p.title?.includes("<") || p.title?.includes('"'),
			);
			// The fixture contains such titles, and they must parse without being dropped.
			expect(specialPosts.length).toBeGreaterThan(0);
		});

		it("handles posts with very long content", () => {
			// Find the longest post
			const longestPost = wxrData.posts.reduce((longest, current) => {
				const currentLength = current.content?.length || 0;
				const longestLength = longest?.content?.length || 0;
				return currentLength > longestLength ? current : longest;
			}, wxrData.posts[0]);

			expect(longestPost?.content).toBeTruthy();

			const result = gutenbergToPortableText(longestPost!.content!);
			expect(result.length).toBeGreaterThan(0);
		});

		it("handles deeply nested blocks", () => {
			// Find posts with nested structures (columns, groups)
			const nestedPost = wxrData.posts.find(
				(p) => p.content?.includes("wp:columns") || p.content?.includes("wp:group"),
			);
			expect(nestedPost).toBeDefined();

			const result = gutenbergToPortableText(nestedPost!.content || "");
			expect(result.length).toBeGreaterThan(0);
		});

		it("handles posts with embeds", () => {
			// The theme-unit-test fixture predates block embeds and contains none, so
			// feed a known wp:embed block directly to verify the converter emits an
			// embed node rather than silently skipping.
			const content = `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=abc123","type":"video","providerNameSlug":"youtube"} -->
<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">
https://www.youtube.com/watch?v=abc123
</div></figure>
<!-- /wp:embed -->`;

			const result = gutenbergToPortableText(content);
			const embeds = result.filter((b) => b._type === "embed");
			expect(embeds.length).toBeGreaterThan(0);
		});
	});

	describe("Content Integrity", () => {
		it("preserves all text content through conversion", () => {
			// Take a sample of posts and verify text isn't lost
			const samplePosts = wxrData.posts.slice(0, 10);
			let assertedCount = 0;

			for (const post of samplePosts) {
				if (!post.content) continue;

				const result = gutenbergToPortableText(post.content);

				// Extract all text from result
				const extractedText = result
					.map((block) => {
						if (block._type === "block" && (block as any).children) {
							return (block as any).children.map((c: any) => c.text || "").join("");
						}
						if (block._type === "code") {
							return (block as any).code || "";
						}
						return "";
					})
					.join(" ")
					.trim();

				// If there was content, we should have extracted some text
				// (unless it was all images/embeds)
				if (post.content.includes("<p>") || post.content.includes("wp:paragraph")) {
					// Only check if there was actual text content
					const hasTextContent = PARAGRAPH_WITH_TEXT_REGEX.test(post.content);
					if (hasTextContent) {
						expect(extractedText.length).toBeGreaterThan(0);
						assertedCount++;
					}
				}
			}

			// Guard against the loop silently asserting nothing.
			expect(assertedCount).toBeGreaterThan(0);
		});
	});

	describe("Statistics", () => {
		it("reports conversion statistics", () => {
			let totalPosts = 0;
			let successfulConversions = 0;
			let failedConversions = 0;
			let totalBlocks = 0;
			const blockTypes = new Map<string, number>();

			for (const post of wxrData.posts) {
				totalPosts++;
				try {
					const result = gutenbergToPortableText(post.content || "");
					successfulConversions++;
					totalBlocks += result.length;

					for (const block of result) {
						const type = block._type;
						blockTypes.set(type, (blockTypes.get(type) || 0) + 1);
					}
				} catch {
					failedConversions++;
				}
			}

			// Log statistics (visible in test output with --reporter=verbose)
			console.log("\n=== WordPress Migration Statistics ===");
			console.log(`Total posts: ${totalPosts}`);
			console.log(`Successful: ${successfulConversions}`);
			console.log(`Failed: ${failedConversions}`);
			console.log(`Total blocks generated: ${totalBlocks}`);
			console.log("\nBlock types:");
			for (const [type, count] of blockTypes.entries()) {
				console.log(`  ${type}: ${count}`);
			}
			console.log("=====================================\n");

			// All conversions should succeed
			expect(failedConversions).toBe(0);
			expect(successfulConversions).toBe(totalPosts);
		});
	});
});
