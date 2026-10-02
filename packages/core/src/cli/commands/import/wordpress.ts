/**
 * WordPress WXR import implementation
 *
 * Two-phase import process:
 * 1. Prepare: Analyze WXR, generate config and suggested live.config.ts
 * 2. Execute: Import content using the generated/edited config
 */

import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import pc from "picocolors";

import { slugify } from "#utils/slugify.js";

import { validateExternalUrl, ssrfSafeFetch } from "../../../import/ssrf.js";
import { parseWxr, type WxrData, type WxrPost, type WxrAttachment } from "../../wxr/parser.js";

// Regex patterns for WordPress import
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const DOT_PATTERN = /\./g;
const NON_ALPHANUMERIC_UNDERSCORE_PATTERN = /[^a-zA-Z0-9_]/g;
const TRAILING_SLASH_PATTERN = /\/$/;
const PHP_STRING_PATTERN = /s:\d+:"(.*)";/;
const PHP_ARRAY_PATTERN = /s:(\d+):"([^"]+)";(?:s:(\d+):"([^"]+)"|i:(\d+)|b:([01]))/g;
const SHELL_SAFE_ARG_PATTERN = /^[\w@%+=:,./-]+$/;

/** Type guard for Record<string, unknown> */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// Types
// ============================================================================

export interface MigrationConfig {
	/** WordPress site info */
	site: {
		title: string;
		url: string;
	};
	/** Map WordPress post types to EmDash collections */
	collections: Record<string, CollectionMapping>;
	/** Map WordPress meta keys to EmDash field names */
	fields: Record<string, FieldMapping>;
	/** Post types to skip */
	skipPostTypes: string[];
	/** Meta keys to skip (internal WP fields) */
	skipMetaKeys: string[];
}

export interface CollectionMapping {
	/** EmDash collection name */
	collection: string;
	/** Whether to import this type */
	enabled: boolean;
	/** Number of items found */
	count: number;
}

export interface FieldMapping {
	/** EmDash field name (supports dot notation for nested) */
	field: string;
	/** Field type hint */
	type: "string" | "number" | "boolean" | "date" | "reference" | "json";
	/** Whether to import this field */
	enabled: boolean;
	/** Number of posts with this field */
	count: number;
	/** Sample values for reference */
	samples: string[];
}

export interface PrepareOptions {
	outputDir: string;
	configPath: string;
	verbose: boolean;
	dryRun: boolean;
	json: boolean;
}

export interface ExecuteOptions {
	outputDir: string;
	mediaDir?: string;
	configPath: string;
	skipMedia: boolean;
	verbose: boolean;
	dryRun: boolean;
	json: boolean;
	resume: boolean;
}

/** Progress tracking for resumable imports */
export interface ImportProgress {
	/** ISO timestamp when import started */
	startedAt: string;
	/** ISO timestamp of last update */
	updatedAt: string;
	/** Source WXR file path */
	sourceFile: string;
	/** Config file used */
	configFile: string;
	/** Posts successfully imported (by WP ID) */
	importedPosts: number[];
	/** Attachments successfully downloaded (by WP ID) */
	downloadedMedia: number[];
	/** Items that failed with error messages */
	errors: Array<{ id: number; type: string; error: string }>;
	/** Summary stats */
	stats: {
		totalPosts: number;
		totalMedia: number;
		importedPosts: number;
		downloadedMedia: number;
		skippedPosts: number;
		errorCount: number;
	};
}

/** Structured result for agent-friendly output */
export interface ImportResult {
	success: boolean;
	phase: "prepare" | "execute";
	dryRun: boolean;
	/** Summary of what was/would be done */
	summary: {
		postsAnalyzed?: number;
		postsImported?: number;
		postsSkipped?: number;
		mediaDownloaded?: number;
		mediaSkipped?: number;
		errors: number;
	};
	/** Files created/would be created */
	files: Array<{
		path: string;
		action: "created" | "skipped" | "would_create";
	}>;
	/** Errors encountered */
	errors: Array<{ id?: number; message: string }>;
	/** Next steps for the user/agent */
	nextSteps: string[];
}

// ============================================================================
// Phase 1: Prepare
// ============================================================================

export async function prepareWordPressImport(
	filePath: string,
	options: PrepareOptions,
): Promise<ImportResult> {
	const result: ImportResult = {
		success: true,
		phase: "prepare",
		dryRun: options.dryRun,
		summary: { errors: 0 },
		files: [],
		errors: [],
		nextSteps: [],
	};

	const log = (msg: string) => !options.json && console.log(msg);

	if (options.dryRun) {
		log(pc.yellow("[DRY RUN] ") + pc.cyan("Analyzing WordPress export...\n"));
	} else {
		log(pc.cyan("Analyzing WordPress export...\n"));
	}
	log(pc.dim(`File: ${filePath}`));

	// Parse WXR
	const stream = createReadStream(filePath, { encoding: "utf-8" });
	const wxr = await parseWxr(stream);

	// Analyze content
	const analysis = analyzeWxrContent(wxr, options.verbose);

	// Generate migration config
	const config = generateMigrationConfig(wxr, analysis);

	result.summary.postsAnalyzed = wxr.posts.length;

	// Write config file (or report what would be written)
	if (options.dryRun) {
		log(pc.yellow(`\n[DRY RUN] Would write: ${options.configPath}`));
		result.files.push({ path: options.configPath, action: "would_create" });
	} else {
		await mkdir(dirname(options.configPath), { recursive: true });
		await writeFile(options.configPath, JSON.stringify(config, null, 2));
		log(pc.green(`\nWrote migration config: ${options.configPath}`));
		result.files.push({ path: options.configPath, action: "created" });
	}

	// Generate suggested live.config.ts
	const liveConfigPath = join(options.outputDir, "suggested-live.config.ts");
	const liveConfigContent = generateLiveConfig(config, analysis);

	if (options.dryRun) {
		log(pc.yellow(`[DRY RUN] Would write: ${liveConfigPath}`));
		result.files.push({ path: liveConfigPath, action: "would_create" });
	} else {
		await mkdir(dirname(liveConfigPath), { recursive: true });
		await writeFile(liveConfigPath, liveConfigContent);
		log(pc.green(`Wrote suggested config: ${liveConfigPath}`));
		result.files.push({ path: liveConfigPath, action: "created" });
	}

	// Summary
	log(pc.cyan("\n=== Analysis Summary ===\n"));

	log(pc.bold("Post Types:"));
	for (const [type, mapping] of Object.entries(config.collections)) {
		const status = mapping.enabled ? pc.green("enabled") : pc.yellow("disabled");
		log(`  ${type} → ${mapping.collection} (${mapping.count} items) [${status}]`);
	}

	log(pc.bold("\nCustom Fields:"));
	const enabledFields = Object.entries(config.fields).filter(([_, m]) => m.enabled);
	const disabledFields = Object.entries(config.fields).filter(([_, m]) => !m.enabled);

	for (const [key, mapping] of enabledFields.slice(0, 10)) {
		log(`  ${key} → ${mapping.field} (${mapping.type}, ${mapping.count} posts)`);
	}
	if (enabledFields.length > 10) {
		log(pc.dim(`  ... and ${enabledFields.length - 10} more`));
	}
	if (disabledFields.length > 0) {
		log(pc.dim(`  (${disabledFields.length} internal fields hidden)`));
	}

	// Next steps
	result.nextSteps = [
		`Review and edit: ${options.configPath}`,
		`Review suggested config: ${liveConfigPath}`,
		"Copy relevant parts to your src/live.config.ts",
		`Run: ${importCommandLine(filePath, options, "--execute")}`,
	];

	log(pc.cyan("\n=== Next Steps ===\n"));
	for (const step of result.nextSteps) {
		log(`  ${step}`);
	}
	log("");

	// JSON output for agents
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	}

	return result;
}

interface ContentAnalysis {
	postTypes: Map<string, number>;
	metaKeys: Map<string, MetaKeyInfo>;
	categories: number;
	tags: number;
	attachments: number;
	authors: string[];
}

interface MetaKeyInfo {
	count: number;
	samples: string[];
	isInternal: boolean;
	inferredType: "string" | "number" | "boolean" | "date" | "reference" | "json";
}

function analyzeWxrContent(wxr: WxrData, _verbose: boolean): ContentAnalysis {
	const postTypes = new Map<string, number>();
	const metaKeys = new Map<string, MetaKeyInfo>();

	// Analyze posts
	for (const post of wxr.posts) {
		// Count post types
		const type = post.postType || "post";
		postTypes.set(type, (postTypes.get(type) || 0) + 1);

		// Analyze meta keys
		for (const [key, value] of post.meta) {
			const existing = metaKeys.get(key);
			if (existing) {
				existing.count++;
				if (existing.samples.length < 3 && value && !existing.samples.includes(value)) {
					existing.samples.push(value.slice(0, 100));
				}
			} else {
				metaKeys.set(key, {
					count: 1,
					samples: value ? [value.slice(0, 100)] : [],
					isInternal: isInternalMetaKey(key),
					inferredType: inferMetaType(key, value),
				});
			}
		}
	}

	// Analyze attachments
	for (const attachment of wxr.attachments) {
		for (const [key, value] of attachment.meta) {
			const existing = metaKeys.get(key);
			if (existing) {
				existing.count++;
			} else {
				metaKeys.set(key, {
					count: 1,
					samples: value ? [value.slice(0, 100)] : [],
					isInternal: isInternalMetaKey(key),
					inferredType: inferMetaType(key, value),
				});
			}
		}
	}

	return {
		postTypes,
		metaKeys,
		categories: wxr.categories.length,
		tags: wxr.tags.length,
		attachments: wxr.attachments.length,
		authors: wxr.authors.map((a) => a.displayName || a.login || "Unknown"),
	};
}

function isInternalMetaKey(key: string): boolean {
	// WordPress internal keys
	if (key.startsWith("_edit_")) return true;
	if (key.startsWith("_wp_")) return true;
	if (key === "_edit_last" || key === "_edit_lock") return true;
	if (key === "_pingme" || key === "_encloseme") return true;

	// But keep these useful ones
	if (key === "_thumbnail_id") return false;
	if (key.startsWith("_yoast_")) return false;
	if (key.startsWith("_rank_math_")) return false;
	if (key.startsWith("_aioseop_")) return false;

	// Other underscore prefixes are usually internal
	if (key.startsWith("_") && !key.startsWith("_yoast") && !key.startsWith("_thumbnail")) {
		return true;
	}

	return false;
}

function inferMetaType(key: string, value: string | undefined): MetaKeyInfo["inferredType"] {
	// Known patterns
	if (key.endsWith("_id") || key === "_thumbnail_id") return "reference";
	if (key.endsWith("_date") || key.endsWith("_time")) return "date";
	if (key.endsWith("_count") || key.endsWith("_number") || key === "price") return "number";

	// Check value
	if (!value) return "string";

	// Serialized PHP
	if (value.startsWith("a:") || value.startsWith("O:") || value.startsWith("s:")) {
		return "json";
	}

	// JSON
	if (
		(value.startsWith("{") && value.endsWith("}")) ||
		(value.startsWith("[") && value.endsWith("]"))
	) {
		return "json";
	}

	// Number
	if (NUMBER_PATTERN.test(value)) return "number";

	// Boolean
	if (value === "0" || value === "1" || value === "true" || value === "false") {
		return "boolean";
	}

	return "string";
}

function generateMigrationConfig(wxr: WxrData, analysis: ContentAnalysis): MigrationConfig {
	const collections: Record<string, CollectionMapping> = {};
	const fields: Record<string, FieldMapping> = {};

	// Map post types to collections
	for (const [type, count] of analysis.postTypes) {
		// Skip internal types (see INTERNAL_POST_TYPES in utils.ts)
		const skip = [
			"revision",
			"nav_menu_item",
			"custom_css",
			"customize_changeset",
			"oembed_cache",
			"wp_global_styles",
			"wp_navigation",
			"wp_template",
			"wp_template_part",
			"attachment", // Handled separately as media
			"wp_block", // Handled separately as sections (reusable blocks)
		].includes(type);

		collections[type] = {
			collection: mapPostTypeToCollection(type),
			enabled: !skip,
			count,
		};
	}

	// Map meta keys to fields
	for (const [key, info] of analysis.metaKeys) {
		fields[key] = {
			field: mapMetaKeyToField(key),
			type: info.inferredType,
			enabled: !info.isInternal,
			count: info.count,
			samples: info.samples,
		};
	}

	return {
		site: {
			title: wxr.site.title || "WordPress Site",
			url: wxr.site.link || "",
		},
		collections,
		fields,
		skipPostTypes: [
			"revision",
			"nav_menu_item",
			"custom_css",
			"customize_changeset",
			"oembed_cache",
			"wp_global_styles",
			"wp_navigation",
			"wp_template",
			"wp_template_part",
			"attachment",
			"wp_block",
		],
		skipMetaKeys: ["_edit_last", "_edit_lock", "_pingme", "_encloseme"],
	};
}

function mapPostTypeToCollection(postType: string): string {
	const mapping: Record<string, string> = {
		post: "posts",
		page: "pages",
		attachment: "media",
		product: "products",
		portfolio: "portfolio",
		testimonial: "testimonials",
		team: "team",
		event: "events",
		faq: "faqs",
	};
	return mapping[postType] || postType;
}

function mapMetaKeyToField(key: string): string {
	// SEO plugins
	if (key === "_yoast_wpseo_title") return "seo.title";
	if (key === "_yoast_wpseo_metadesc") return "seo.description";
	if (key === "_yoast_wpseo_focuskw") return "seo.keywords";
	if (key === "_rank_math_title") return "seo.title";
	if (key === "_rank_math_description") return "seo.description";
	if (key === "_aioseop_title") return "seo.title";
	if (key === "_aioseop_description") return "seo.description";

	// Featured image
	if (key === "_thumbnail_id") return "featuredImage";

	// Remove leading underscore for others
	if (key.startsWith("_")) {
		return key.slice(1);
	}

	return key;
}

function generateLiveConfig(config: MigrationConfig, _analysis: ContentAnalysis): string {
	const lines: string[] = [
		"/**",
		" * Suggested EmDash collections",
		` * Generated from: ${config.site.title}`,
		" *",
		" * Create these collections in the EmDash admin UI:",
		" * 1. Go to /_emdash/admin/content-types",
		" * 2. Click 'New Content Type'",
		" * 3. Create the collections listed below with their fields",
		" */",
		"",
	];

	// Generate collection suggestions for each enabled post type
	for (const [type, mapping] of Object.entries(config.collections)) {
		if (!mapping.enabled) continue;

		lines.push(`// ${type} → "${mapping.collection}" (${mapping.count} items)`);
		lines.push(`// Label: "${capitalize(mapping.collection)}"`);
		lines.push(`// Label Singular: "${capitalize(singularize(mapping.collection))}"`);
		lines.push("// Suggested fields:");
		lines.push("//   - title (string)");
		lines.push("//   - content (portableText)");
		lines.push("//   - excerpt (string, optional)");

		// Add fields for this collection
		const collectionFields = Object.entries(config.fields)
			.filter(([_, m]) => m.enabled)
			.slice(0, 10); // Limit to avoid huge output

		for (const [key, fieldMapping] of collectionFields) {
			lines.push(
				`//   - ${sanitizeFieldName(fieldMapping.field)} (${fieldMapping.type}) // from: ${key}`,
			);
		}

		lines.push("");
	}

	return lines.join("\n");
}

function sanitizeFieldName(name: string): string {
	// Handle nested fields like seo.title → seo: { title }
	// For now, just flatten with underscore
	return name.replace(DOT_PATTERN, "_").replace(NON_ALPHANUMERIC_UNDERSCORE_PATTERN, "");
}

function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

function singularize(str: string): string {
	if (str.endsWith("ies")) return str.slice(0, -3) + "y";
	if (str.endsWith("s")) return str.slice(0, -1);
	return str;
}

// ============================================================================
// Phase 2: Execute
// ============================================================================

export async function executeWordPressImport(
	filePath: string,
	options: ExecuteOptions,
): Promise<ImportResult> {
	const result: ImportResult = {
		success: true,
		phase: "execute",
		dryRun: options.dryRun,
		summary: {
			postsImported: 0,
			postsSkipped: 0,
			mediaDownloaded: 0,
			mediaSkipped: 0,
			errors: 0,
		},
		files: [],
		errors: [],
		nextSteps: [],
	};

	const log = (msg: string) => !options.json && console.log(msg);
	const progressPath = join(options.outputDir, ".wp-migration-progress.json");

	if (options.dryRun) {
		log(pc.yellow("[DRY RUN] ") + pc.cyan("Importing WordPress content...\n"));
	} else {
		log(pc.cyan("Importing WordPress content...\n"));
	}

	// Load config
	let config: MigrationConfig;
	try {
		const configContent = await readFile(options.configPath, "utf-8");
		config = JSON.parse(configContent);
	} catch (error) {
		const msg = `Failed to load migration config: ${options.configPath}`;
		log(pc.red(msg));
		log(pc.dim("Run with --prepare first to generate the config."));
		result.success = false;
		result.errors.push({ message: msg });
		if (options.json) console.log(JSON.stringify(result, null, 2));
		throw error;
	}

	log(pc.dim(`Using config: ${options.configPath}`));
	log(pc.dim(`File: ${filePath}`));
	if (options.resume) {
		log(pc.dim(`Resume mode: will skip already-imported items`));
	}
	log("");

	// Load or initialize progress tracking
	let progress: ImportProgress;
	if (options.resume) {
		try {
			const progressContent = await readFile(progressPath, "utf-8");
			progress = JSON.parse(progressContent);
			log(
				pc.dim(
					`Resuming from previous run (${progress.stats.importedPosts} posts already imported)`,
				),
			);
		} catch {
			progress = createFreshProgress(filePath, options.configPath);
		}
	} else {
		progress = createFreshProgress(filePath, options.configPath);
	}

	const alreadyImported = new Set(progress.importedPosts);
	const alreadyDownloaded = new Set(progress.downloadedMedia);

	// Parse WXR
	const stream = createReadStream(filePath, { encoding: "utf-8" });
	const wxr = await parseWxr(stream);

	// Update totals in progress
	progress.stats.totalPosts = wxr.posts.length;
	progress.stats.totalMedia = wxr.attachments.length;

	// Build media map
	const mediaMap = new Map<number, string>();
	for (const attachment of wxr.attachments) {
		if (attachment.id) {
			mediaMap.set(attachment.id, `media-${attachment.id}`);
		}
	}

	// Stats
	const stats = {
		imported: 0,
		skipped: 0,
		resumed: 0,
		errors: 0,
		byCollection: new Map<string, number>(),
	};
	const redirectPath = join(options.outputDir, "_redirects.json");
	const redirects = new Map<string, string>();
	if (options.resume) {
		try {
			const existing: unknown = JSON.parse(await readFile(redirectPath, "utf-8"));
			if (isRecord(existing)) {
				for (const [from, to] of Object.entries(existing)) {
					if (typeof to === "string") redirects.set(from, to);
				}
			}
		} catch {
			// No redirect map from an earlier run
		}
	}

	if (!options.dryRun) {
		await mkdir(options.outputDir, { recursive: true });
	}

	// Process posts
	for (const post of wxr.posts) {
		const postType = post.postType || "post";
		const mapping = config.collections[postType];

		// Skip if not mapped or disabled
		if (!mapping || !mapping.enabled) {
			stats.skipped++;
			continue;
		}

		// Skip if already imported (resume mode)
		if (post.id && alreadyImported.has(post.id)) {
			stats.resumed++;
			if (options.verbose) {
				log(pc.dim(`  [skip] ${mapping.collection}/${post.title} (already imported)`));
			}
			continue;
		}

		const importedBefore = stats.imported;
		try {
			const converted = convertPostWithConfig(post, mapping.collection, config, mediaMap);

			const outputPath = join(options.outputDir, converted.collection, `${converted.slug}.json`);

			if (options.dryRun) {
				if (options.verbose) {
					log(pc.yellow(`  [would create] ${outputPath}`));
				}
				result.files.push({ path: outputPath, action: "would_create" });
			} else {
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(outputPath, JSON.stringify(converted.data, null, 2));
				result.files.push({ path: outputPath, action: "created" });

				// Update progress
				if (post.id) {
					progress.importedPosts.push(post.id);
					progress.stats.importedPosts++;
				}

				if (options.verbose) {
					log(pc.green(`  ${mapping.collection}/${converted.slug}`));
				}
			}

			stats.imported++;
			stats.byCollection.set(
				mapping.collection,
				(stats.byCollection.get(mapping.collection) || 0) + 1,
			);

			// Track redirect
			if (post.link && converted.slug) {
				redirects.set(post.link, `/${converted.collection}/${converted.slug}`);
			}
		} catch (error) {
			stats.errors++;
			const errorMsg = error instanceof Error ? error.message : String(error);
			result.errors.push({
				id: post.id,
				message: `${post.title}: ${errorMsg}`,
			});

			if (post.id) {
				progress.errors.push({ id: post.id, type: "post", error: errorMsg });
			}

			if (options.verbose) {
				log(pc.red(`  Failed: ${post.title} - ${errorMsg}`));
			}
		}

		// Save progress periodically (every 50 items)
		if (!options.dryRun && stats.imported > importedBefore && stats.imported % 50 === 0) {
			progress.updatedAt = new Date().toISOString();
			await writeFile(progressPath, JSON.stringify(progress, null, 2));
			if (redirects.size > 0) {
				await writeFile(redirectPath, JSON.stringify(Object.fromEntries(redirects), null, 2));
			}
		}
	}

	// Download media
	let mediaDownloaded = 0;
	let mediaSkipped = 0;
	if (!options.skipMedia && options.mediaDir && wxr.attachments.length > 0) {
		log(pc.dim("\nDownloading media..."));
		for (const attachment of wxr.attachments) {
			// Skip if already downloaded (resume mode)
			if (attachment.id && alreadyDownloaded.has(attachment.id)) {
				mediaSkipped++;
				continue;
			}

			try {
				if (options.dryRun) {
					if (options.verbose) {
						log(pc.yellow(`  [would download] ${attachment.url}`));
					}
				} else {
					await downloadMedia(attachment, options.mediaDir);

					if (attachment.id) {
						progress.downloadedMedia.push(attachment.id);
						progress.stats.downloadedMedia++;
					}

					if (options.verbose) {
						log(pc.green(`  ${attachment.url}`));
					}
				}
				mediaDownloaded++;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				result.errors.push({
					id: attachment.id,
					message: `Media ${attachment.url}: ${errorMsg}`,
				});

				if (attachment.id) {
					progress.errors.push({
						id: attachment.id,
						type: "media",
						error: errorMsg,
					});
				}

				if (options.verbose) {
					log(pc.red(`  Failed: ${attachment.url}`));
				}
			}
		}
		log(pc.dim(`Downloaded ${mediaDownloaded} media files`));
	}

	// Write redirects
	if (redirects.size > 0) {
		if (options.dryRun) {
			result.files.push({ path: redirectPath, action: "would_create" });
		} else {
			await writeFile(redirectPath, JSON.stringify(Object.fromEntries(redirects), null, 2));
			result.files.push({ path: redirectPath, action: "created" });
		}
	}

	// Save final progress
	if (!options.dryRun) {
		progress.updatedAt = new Date().toISOString();
		progress.stats.skippedPosts = stats.skipped;
		progress.stats.errorCount = stats.errors;
		await writeFile(progressPath, JSON.stringify(progress, null, 2));
	}

	// Update result summary
	result.summary.postsImported = stats.imported;
	result.summary.postsSkipped = stats.skipped + stats.resumed;
	result.summary.mediaDownloaded = mediaDownloaded;
	result.summary.mediaSkipped = mediaSkipped;
	result.summary.errors = stats.errors + result.errors.length;

	// Summary
	const prefix = options.dryRun ? "[DRY RUN] " : "";
	log(pc.cyan(`\n=== ${prefix}Import ${options.dryRun ? "Preview" : "Complete"} ===\n`));
	log(`${options.dryRun ? "Would import" : "Imported"}: ${pc.green(stats.imported.toString())}`);
	if (stats.resumed > 0) {
		log(`Resumed (skipped): ${pc.blue(stats.resumed.toString())}`);
	}
	log(`Skipped (disabled): ${pc.yellow(stats.skipped.toString())}`);
	if (stats.errors > 0) {
		log(`Errors: ${pc.red(stats.errors.toString())}`);
	}

	log(pc.bold("\nBy collection:"));
	for (const [collection, count] of stats.byCollection) {
		log(`  ${collection}: ${count}`);
	}

	if (redirects.size > 0 && !options.dryRun) {
		log(pc.dim(`\nRedirect map written to: ${redirectPath}`));
	}

	// Next steps
	if (options.dryRun) {
		result.nextSteps = [
			`Run without --dry-run to perform the import`,
			importCommandLine(filePath, options, "--execute"),
		];
	} else if (stats.errors > 0) {
		result.nextSteps = [
			`Fix errors and run with --resume to continue`,
			importCommandLine(filePath, options, "--execute --resume"),
		];
	} else {
		result.nextSteps = [
			`Review the converted files in: ${options.outputDir}`,
			`Progress saved to: ${progressPath}`,
		];
	}

	if (!options.dryRun) {
		log(pc.dim(`\nProgress saved to: ${progressPath}`));
		log(pc.dim(`Run with --resume to continue from where you left off.`));
	}

	// JSON output for agents
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	}

	return result;
}

function importCommandLine(
	filePath: string,
	options: { outputDir: string; configPath: string },
	flags: string,
): string {
	let command = `emdash import wordpress ${shellQuote(filePath)} -o ${shellQuote(options.outputDir)}`;
	if (options.configPath !== join(options.outputDir, "migration-config.json")) {
		command += ` --config ${shellQuote(options.configPath)}`;
	}
	return `${command} ${flags}`;
}

function shellQuote(arg: string): string {
	return SHELL_SAFE_ARG_PATTERN.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function createFreshProgress(sourceFile: string, configFile: string): ImportProgress {
	return {
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		sourceFile: resolve(sourceFile),
		configFile: resolve(configFile),
		importedPosts: [],
		downloadedMedia: [],
		errors: [],
		stats: {
			totalPosts: 0,
			totalMedia: 0,
			importedPosts: 0,
			downloadedMedia: 0,
			skippedPosts: 0,
			errorCount: 0,
		},
	};
}

interface ConvertedContent {
	slug: string;
	collection: string;
	data: Record<string, unknown>;
}

function convertPostWithConfig(
	post: WxrPost,
	collection: string,
	config: MigrationConfig,
	mediaMap: Map<number, string>,
): ConvertedContent {
	// Convert content to Portable Text
	const content = gutenbergToPortableText(post.content || "", { mediaMap });

	// Extract slug
	const slug = extractSlug(post.link) || slugify(post.title || "untitled");

	// Build data object
	const data: Record<string, unknown> = {
		title: post.title,
		content,
		status: mapStatus(post.status),
		publishedAt: post.pubDate ? new Date(post.pubDate).toISOString() : null,
		createdAt: post.postDate ? new Date(post.postDate).toISOString() : null,
		author: post.creator,
		excerpt: post.excerpt,
		categories: post.categories,
		tags: post.tags,
	};

	// Map custom fields
	for (const [wpKey, value] of post.meta) {
		const fieldConfig = config.fields[wpKey];
		if (!fieldConfig || !fieldConfig.enabled) continue;

		const fieldName = fieldConfig.field;
		let fieldValue: unknown = value;

		// Type conversion
		switch (fieldConfig.type) {
			case "number":
				fieldValue = parseFloat(value) || 0;
				break;
			case "boolean":
				fieldValue = value === "1" || value === "true";
				break;
			case "date":
				fieldValue = new Date(value).toISOString();
				break;
			case "reference":
				// Map WordPress ID to new reference
				const wpId = parseInt(value, 10);
				fieldValue = mediaMap.get(wpId) || value;
				break;
			case "json":
				try {
					// Try PHP unserialize first
					if (value.startsWith("a:") || value.startsWith("O:")) {
						fieldValue = unserializePhp(value);
					} else {
						fieldValue = JSON.parse(value);
					}
				} catch {
					fieldValue = value;
				}
				break;
		}

		// Handle nested fields (e.g., seo.title)
		if (fieldName.includes(".")) {
			const parts = fieldName.split(".");
			let obj: Record<string, unknown> = data;
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				const nested = obj[part];
				if (isRecord(nested)) {
					obj = nested;
				} else {
					const newObj: Record<string, unknown> = {};
					obj[part] = newObj;
					obj = newObj;
				}
			}
			obj[parts.at(-1)!] = fieldValue;
		} else {
			data[fieldName] = fieldValue;
		}
	}

	// Original WP metadata for reference
	data._wp = {
		id: post.id,
		link: post.link,
		guid: post.guid,
		postType: post.postType,
	};

	return { slug, collection, data };
}

async function downloadMedia(attachment: WxrAttachment, mediaDir: string): Promise<void> {
	if (!attachment.url) return;

	// Validate URL is not targeting internal/private addresses
	const parsed = validateExternalUrl(attachment.url);
	const filename = parsed.pathname.split("/").pop() || `media-${attachment.id}`;
	const filePath = join(mediaDir, filename);

	await mkdir(dirname(filePath), { recursive: true });

	const response = await ssrfSafeFetch(attachment.url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	const buffer = await response.arrayBuffer();
	await writeFile(filePath, Buffer.from(buffer));
}

function extractSlug(link: string | undefined): string | undefined {
	if (!link) return undefined;
	try {
		const url = new URL(link);
		const path = url.pathname.replace(TRAILING_SLASH_PATTERN, "");
		const segments = path.split("/").filter(Boolean);
		return segments.pop();
	} catch {
		return undefined;
	}
}

function mapStatus(wpStatus: string | undefined): string {
	switch (wpStatus) {
		case "publish":
			return "published";
		case "draft":
			return "draft";
		case "pending":
			return "pending";
		case "private":
			return "private";
		case "trash":
			return "archived";
		default:
			return "draft";
	}
}

/**
 * Basic PHP unserialize for simple arrays/strings
 * Not a full implementation, but handles common cases
 */
function unserializePhp(str: string): unknown {
	// This is a simplified parser - for production, use a proper library
	try {
		if (str.startsWith("a:")) {
			// Array - extract key/value pairs
			const result: Record<string, unknown> = {};
			// Match pattern: s:4:"key";s:5:"value";
			const matches = str.matchAll(PHP_ARRAY_PATTERN);
			for (const match of matches) {
				const key = match[2];
				const strVal = match[4];
				const intVal = match[5];
				const boolVal = match[6];
				if (key) {
					if (strVal !== undefined) result[key] = strVal;
					else if (intVal !== undefined) result[key] = parseInt(intVal, 10);
					else if (boolVal !== undefined) result[key] = boolVal === "1";
				}
			}
			return result;
		}
		if (str.startsWith("s:")) {
			// Simple string
			const match = str.match(PHP_STRING_PATTERN);
			return match?.[1] || str;
		}
		return str;
	} catch {
		return str;
	}
}
