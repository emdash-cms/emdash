/**
 * Marketplace plugin handlers
 *
 * Business logic for installing, updating, uninstalling, and checking
 * updates for marketplace plugins. Routes are thin wrappers around these.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validatePluginIdentifier } from "../../database/validate.js";
import { pluginManifestSchema } from "../../plugins/manifest-schema.js";
import { normalizeManifestRoute } from "../../plugins/manifest-schema.js";
import {
	createMarketplaceClient,
	MarketplaceError,
	MarketplaceUnavailableError,
	type MarketplaceClient,
	type MarketplacePluginDetail,
	type MarketplaceSearchOpts,
	type MarketplaceThemeSearchOpts,
	type MarketplaceVersionSummary,
	type PluginBundle,
} from "../../plugins/marketplace.js";
import type { SandboxRunner } from "../../plugins/sandbox/types.js";
import { PluginStateRepository } from "../../plugins/state.js";
import type { PluginManifest } from "../../plugins/types.js";
import { EmDashStorageError } from "../../storage/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface MarketplaceInstallResult {
	pluginId: string;
	version: string;
	capabilities: string[];
}

export interface MarketplaceUpdateResult {
	pluginId: string;
	oldVersion: string;
	newVersion: string;
	capabilityChanges: {
		added: string[];
		removed: string[];
	};
	routeVisibilityChanges?: {
		newlyPublic: string[];
	};
}

export interface MarketplaceUpdateCheck {
	pluginId: string;
	installed: string;
	latest: string;
	hasUpdate: boolean;
	hasCapabilityChanges: boolean;
	capabilityChanges?: {
		added: string[];
		removed: string[];
	};
	hasRouteVisibilityChanges: boolean;
	routeVisibilityChanges?: {
		newlyPublic: string[];
	};
}

export interface MarketplaceUninstallResult {
	pluginId: string;
	dataDeleted: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Semver-like pattern: digits, dots, hyphens, plus signs (e.g. 1.0.0, 1.0.0-beta.1) */
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/i;

function validateVersion(version: string): void {
	if (version.includes("..")) throw new Error("Invalid version format");
	if (!VERSION_PATTERN.test(version)) {
		throw new Error("Invalid version format");
	}
}

function getClient(
	marketplaceUrl: string | undefined,
	siteOrigin?: string,
): MarketplaceClient | null {
	if (!marketplaceUrl) return null;
	return createMarketplaceClient(marketplaceUrl, siteOrigin);
}

function diffCapabilities(
	oldCaps: string[],
	newCaps: string[],
): { added: string[]; removed: string[] } {
	const oldSet = new Set(oldCaps);
	const newSet = new Set(newCaps);
	return {
		added: newCaps.filter((c) => !oldSet.has(c)),
		removed: oldCaps.filter((c) => !newSet.has(c)),
	};
}

/**
 * Diff route visibility between two manifests.
 * Returns routes that changed from private to public (newly exposed).
 */
function diffRouteVisibility(
	oldManifest: PluginManifest | undefined,
	newManifest: PluginManifest,
): { newlyPublic: string[] } {
	const oldPublicRoutes = new Set<string>();
	if (oldManifest) {
		for (const entry of oldManifest.routes) {
			const normalized = normalizeManifestRoute(entry);
			if (normalized.public === true) {
				oldPublicRoutes.add(normalized.name);
			}
		}
	}

	const newlyPublic: string[] = [];
	for (const entry of newManifest.routes) {
		const normalized = normalizeManifestRoute(entry);
		if (normalized.public === true && !oldPublicRoutes.has(normalized.name)) {
			newlyPublic.push(normalized.name);
		}
	}

	return { newlyPublic };
}

async function resolveVersionMetadata(
	client: MarketplaceClient,
	pluginId: string,
	pluginDetail: MarketplacePluginDetail,
	version: string,
): Promise<MarketplaceVersionSummary | null> {
	if (pluginDetail.latestVersion?.version === version) {
		return {
			version: pluginDetail.latestVersion.version,
			minEmDashVersion: pluginDetail.latestVersion.minEmDashVersion,
			bundleSize: pluginDetail.latestVersion.bundleSize,
			checksum: pluginDetail.latestVersion.checksum,
			changelog: pluginDetail.latestVersion.changelog,
			capabilities: pluginDetail.latestVersion.capabilities,
			status: pluginDetail.latestVersion.status,
			auditVerdict: pluginDetail.latestVersion.audit?.verdict ?? null,
			imageAuditVerdict: pluginDetail.latestVersion.imageAudit?.verdict ?? null,
			publishedAt: pluginDetail.latestVersion.publishedAt,
		};
	}

	const versions = await client.getVersions(pluginId);
	return versions.find((v) => v.version === version) ?? null;
}

function validateBundleIdentity(
	bundle: PluginBundle,
	pluginId: string,
	version: string,
): ApiResult<never> | null {
	if (bundle.manifest.id !== pluginId) {
		return {
			success: false,
			error: {
				code: "MANIFEST_MISMATCH",
				message: `Bundle manifest ID (${bundle.manifest.id}) does not match requested plugin (${pluginId})`,
			},
		};
	}

	if (bundle.manifest.version !== version) {
		return {
			success: false,
			error: {
				code: "MANIFEST_VERSION_MISMATCH",
				message: `Bundle manifest version (${bundle.manifest.version}) does not match requested version (${version})`,
			},
		};
	}

	return null;
}

/** Store a plugin bundle's files in site-local R2 storage */
async function storeBundleInR2(
	storage: Storage,
	pluginId: string,
	version: string,
	bundle: PluginBundle,
): Promise<void> {
	validatePluginIdentifier(pluginId, "plugin ID");
	validateVersion(version);
	const prefix = `marketplace/${pluginId}/${version}`;

	// Store manifest
	await storage.upload({
		key: `${prefix}/manifest.json`,
		body: new TextEncoder().encode(JSON.stringify(bundle.manifest)),
		contentType: "application/json",
	});

	// Store backend code
	await storage.upload({
		key: `${prefix}/backend.js`,
		body: new TextEncoder().encode(bundle.backendCode),
		contentType: "application/javascript",
	});

	// Store admin code if present
	if (bundle.adminCode) {
		await storage.upload({
			key: `${prefix}/admin.js`,
			body: new TextEncoder().encode(bundle.adminCode),
			contentType: "application/javascript",
		});
	}
}

/** Read a ReadableStream to string */
async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

/** Load a plugin bundle from site-local R2 storage */
export async function loadBundleFromR2(
	storage: Storage,
	pluginId: string,
	version: string,
): Promise<{ manifest: PluginManifest; backendCode: string; adminCode?: string } | null> {
	validatePluginIdentifier(pluginId, "plugin ID");
	validateVersion(version);
	const prefix = `marketplace/${pluginId}/${version}`;

	try {
		const manifestResult = await storage.download(`${prefix}/manifest.json`);
		const backendResult = await storage.download(`${prefix}/backend.js`);

		const manifestText = await streamToText(manifestResult.body);
		const backendCode = await streamToText(backendResult.body);
		const parsed: unknown = JSON.parse(manifestText);
		const result = pluginManifestSchema.safeParse(parsed);
		if (!result.success) return null;
		// Elements are validated as unknown[] by Zod; cast to PluginManifest
		// for the Element[] type (Block Kit validation happens at render time).
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod types elements as unknown[]; Element type validated at render time
		const manifest = result.data as unknown as PluginManifest;

		// Try to load admin code (optional)
		let adminCode: string | undefined;
		try {
			const adminResult = await storage.download(`${prefix}/admin.js`);
			adminCode = await streamToText(adminResult.body);
		} catch {
			// admin.js is optional
		}

		return { manifest, backendCode, adminCode };
	} catch {
		return null;
	}
}

/** Delete a plugin bundle from site-local R2 storage */
async function deleteBundleFromR2(
	storage: Storage,
	pluginId: string,
	version: string,
): Promise<void> {
	validatePluginIdentifier(pluginId, "plugin ID");
	validateVersion(version);
	const prefix = `marketplace/${pluginId}/${version}`;
	const files = ["manifest.json", "backend.js", "admin.js"];

	for (const file of files) {
		try {
			await storage.delete(`${prefix}/${file}`);
		} catch {
			// Ignore missing files
		}
	}
}

// ── Install ────────────────────────────────────────────────────────

export async function handleMarketplaceInstall(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	marketplaceUrl: string | undefined,
	pluginId: string,
	opts?: { version?: string; configuredPluginIds?: Set<string>; siteOrigin?: string },
): Promise<ApiResult<MarketplaceInstallResult>> {
	const client = getClient(marketplaceUrl, opts?.siteOrigin);
	if (!client) {
		return {
			success: false,
			error: {
				code: "MARKETPLACE_NOT_CONFIGURED",
				message: "Marketplace is not configured",
			},
		};
	}

	if (!storage) {
		return {
			success: false,
			error: {
				code: "STORAGE_NOT_CONFIGURED",
				message: "Storage is required for marketplace plugin installation",
			},
		};
	}

	if (!sandboxRunner || !sandboxRunner.isAvailable()) {
		return {
			success: false,
			error: {
				code: "SANDBOX_NOT_AVAILABLE",
				message: "Sandbox runner is required for marketplace plugins",
			},
		};
	}

	try {
		// Check if already installed
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (existing && existing.source === "marketplace") {
			return {
				success: false,
				error: {
					code: "ALREADY_INSTALLED",
					message: `Plugin ${pluginId} is already installed`,
				},
			};
		}

		// Block installation if a configured (trusted) plugin with the same ID exists.
		// Without this check, the sandboxed plugin could shadow the trusted plugin's
		// route handlers while auth decisions are made against the trusted plugin's metadata.
		if (opts?.configuredPluginIds?.has(pluginId)) {
			return {
				success: false,
				error: {
					code: "PLUGIN_ID_CONFLICT",
					message: `Cannot install marketplace plugin "${pluginId}" — a configured plugin with the same ID already exists`,
				},
			};
		}

		// Fetch plugin detail from marketplace
		const pluginDetail = await client.getPlugin(pluginId);
		const version = opts?.version ?? pluginDetail.latestVersion?.version;
		if (!version) {
			return {
				success: false,
				error: {
					code: "NO_VERSION",
					message: `No published versions found for plugin ${pluginId}`,
				},
			};
		}

		const versionMetadata = await resolveVersionMetadata(client, pluginId, pluginDetail, version);
		if (!versionMetadata) {
			return {
				success: false,
				error: {
					code: "NO_VERSION",
					message: `Version ${version} was not found for plugin ${pluginId}`,
				},
			};
		}

		// Block installation of plugins that haven't passed audit.
		// Both "fail" (explicitly malicious) and "warn" (audit error or
		// inconclusive) are non-installable — only "pass" or null (no audit
		// ran) are allowed through.
		if (versionMetadata.auditVerdict === "fail" || versionMetadata.auditVerdict === "warn") {
			return {
				success: false,
				error: {
					code: "AUDIT_FAILED",
					message:
						versionMetadata.auditVerdict === "fail"
							? "Plugin failed security audit and cannot be installed"
							: "Plugin audit was inconclusive and cannot be installed until reviewed",
				},
			};
		}

		// Download and extract bundle
		const bundle = await client.downloadBundle(pluginId, version);

		// Verify checksum matches marketplace-published checksum
		if (versionMetadata.checksum && bundle.checksum !== versionMetadata.checksum) {
			return {
				success: false,
				error: {
					code: "CHECKSUM_MISMATCH",
					message: "Bundle checksum does not match marketplace record. Download may be corrupted.",
				},
			};
		}

		const bundleIdentityError = validateBundleIdentity(bundle, pluginId, version);
		if (bundleIdentityError) return bundleIdentityError;

		// Store bundle in site-local R2
		await storeBundleInR2(storage, pluginId, version, bundle);

		// Write plugin state
		await stateRepo.upsert(pluginId, version, "active", {
			source: "marketplace",
			marketplaceVersion: version,
			displayName: pluginDetail.name,
			description: pluginDetail.description ?? undefined,
		});

		// Fire-and-forget install stat
		client.reportInstall(pluginId, version).catch(() => {
			// Intentional: never fails the install
		});
		return {
			success: true,
			data: {
				pluginId,
				version,
				capabilities: bundle.manifest.capabilities,
			},
		};
	} catch (err) {
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: {
					code: "MARKETPLACE_UNAVAILABLE",
					message: "Plugin marketplace is currently unavailable",
				},
			};
		}
		if (err instanceof MarketplaceError) {
			return {
				success: false,
				error: {
					code: err.code ?? "MARKETPLACE_ERROR",
					message: err.message,
				},
			};
		}
		if (err instanceof EmDashStorageError) {
			return {
				success: false,
				error: {
					code: err.code ?? "STORAGE_ERROR",
					message: "Storage error while installing plugin",
				},
			};
		}
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code?: unknown }).code;
			if (typeof code === "string" && code.trim()) {
				return {
					success: false,
					error: {
						code,
						message: "Failed to install plugin from marketplace",
					},
				};
			}
		}
		console.error("Failed to install marketplace plugin:", err);
		return {
			success: false,
			error: {
				code: "INSTALL_FAILED",
				message: "Failed to install plugin from marketplace",
			},
		};
	}
}

// ── Update ─────────────────────────────────────────────────────────

export async function handleMarketplaceUpdate(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	marketplaceUrl: string | undefined,
	pluginId: string,
	opts?: {
		version?: string;
		confirmCapabilityChanges?: boolean;
		confirmRouteVisibilityChanges?: boolean;
	},
): Promise<ApiResult<MarketplaceUpdateResult>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}
	if (!storage) {
		return {
			success: false,
			error: { code: "STORAGE_NOT_CONFIGURED", message: "Storage is required" },
		};
	}
	if (!sandboxRunner || !sandboxRunner.isAvailable()) {
		return {
			success: false,
			error: { code: "SANDBOX_NOT_AVAILABLE", message: "Sandbox runner is required" },
		};
	}

	try {
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (!existing || existing.source !== "marketplace") {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `No marketplace plugin found: ${pluginId}`,
				},
			};
		}

		const oldVersion = existing.marketplaceVersion ?? existing.version;

		// Get target version
		const pluginDetail = await client.getPlugin(pluginId);
		const newVersion = opts?.version ?? pluginDetail.latestVersion?.version;
		if (!newVersion) {
			return {
				success: false,
				error: { code: "NO_VERSION", message: "No newer version available" },
			};
		}

		if (newVersion === oldVersion) {
			return {
				success: false,
				error: { code: "ALREADY_UP_TO_DATE", message: "Plugin is already up to date" },
			};
		}

		const versionMetadata = await resolveVersionMetadata(
			client,
			pluginId,
			pluginDetail,
			newVersion,
		);
		if (!versionMetadata) {
			return {
				success: false,
				error: {
					code: "NO_VERSION",
					message: `Version ${newVersion} was not found for plugin ${pluginId}`,
				},
			};
		}

		// Download new bundle
		const bundle = await client.downloadBundle(pluginId, newVersion);

		// Verify checksum matches marketplace-published checksum for this version
		if (versionMetadata.checksum && bundle.checksum !== versionMetadata.checksum) {
			return {
				success: false,
				error: {
					code: "CHECKSUM_MISMATCH",
					message: "Bundle checksum does not match marketplace record. Download may be corrupted.",
				},
			};
		}

		const bundleIdentityError = validateBundleIdentity(bundle, pluginId, newVersion);
		if (bundleIdentityError) return bundleIdentityError;

		// Diff capabilities and route visibility against old version
		const oldBundle = await loadBundleFromR2(storage, pluginId, oldVersion);
		const oldCaps = oldBundle?.manifest.capabilities ?? [];
		const capabilityChanges = diffCapabilities(oldCaps, bundle.manifest.capabilities);
		const hasEscalation = capabilityChanges.added.length > 0;

		// If capabilities escalated, require explicit confirmation
		if (hasEscalation && !opts?.confirmCapabilityChanges) {
			return {
				success: false,
				error: {
					code: "CAPABILITY_ESCALATION",
					message: "Plugin update requires new capabilities",
					details: { capabilityChanges },
				},
			};
		}

		// Diff route visibility — routes going from private to public are a
		// security-sensitive change that exposes unauthenticated endpoints.
		const routeVisibilityChanges = diffRouteVisibility(oldBundle?.manifest, bundle.manifest);
		const hasNewPublicRoutes = routeVisibilityChanges.newlyPublic.length > 0;

		if (hasNewPublicRoutes && !opts?.confirmRouteVisibilityChanges) {
			return {
				success: false,
				error: {
					code: "ROUTE_VISIBILITY_ESCALATION",
					message: "Plugin update exposes new public (unauthenticated) routes",
					details: { routeVisibilityChanges, capabilityChanges },
				},
			};
		}

		// Store new bundle
		await storeBundleInR2(storage, pluginId, newVersion, bundle);

		// Update state
		await stateRepo.upsert(pluginId, newVersion, "active", {
			source: "marketplace",
			marketplaceVersion: newVersion,
			displayName: pluginDetail.name,
			description: pluginDetail.description ?? undefined,
		});

		// Clean up old bundle from R2 (best-effort)
		deleteBundleFromR2(storage, pluginId, oldVersion).catch(() => {});

		return {
			success: true,
			data: {
				pluginId,
				oldVersion,
				newVersion,
				capabilityChanges,
				routeVisibilityChanges: hasNewPublicRoutes ? routeVisibilityChanges : undefined,
			},
		};
	} catch (err) {
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		if (err instanceof MarketplaceError) {
			return {
				success: false,
				error: { code: err.code ?? "MARKETPLACE_ERROR", message: err.message },
			};
		}
		console.error("Failed to update marketplace plugin:", err);
		return {
			success: false,
			error: { code: "UPDATE_FAILED", message: "Failed to update plugin" },
		};
	}
}

// ── Uninstall ──────────────────────────────────────────────────────

export async function handleMarketplaceUninstall(
	db: Kysely<Database>,
	storage: Storage | null,
	pluginId: string,
	opts?: { deleteData?: boolean },
): Promise<ApiResult<MarketplaceUninstallResult>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (!existing || existing.source !== "marketplace") {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `No marketplace plugin found: ${pluginId}`,
				},
			};
		}

		const version = existing.marketplaceVersion ?? existing.version;

		// Delete bundle from site R2
		if (storage) {
			await deleteBundleFromR2(storage, pluginId, version);
		}

		// Optionally delete plugin storage data
		let dataDeleted = false;
		if (opts?.deleteData) {
			try {
				await db.deleteFrom("_plugin_storage").where("plugin_id", "=", pluginId).execute();
				dataDeleted = true;
			} catch {
				// Plugin storage table may not have data for this plugin
			}
		}

		// Delete state row
		await stateRepo.delete(pluginId);

		return {
			success: true,
			data: { pluginId, dataDeleted },
		};
	} catch (err) {
		console.error("Failed to uninstall marketplace plugin:", err);
		return {
			success: false,
			error: {
				code: "UNINSTALL_FAILED",
				message: "Failed to uninstall plugin",
			},
		};
	}
}

// ── Update check ───────────────────────────────────────────────────

export async function handleMarketplaceUpdateCheck(
	db: Kysely<Database>,
	marketplaceUrl: string | undefined,
): Promise<ApiResult<{ items: MarketplaceUpdateCheck[] }>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}

	try {
		const stateRepo = new PluginStateRepository(db);
		const marketplacePlugins = await stateRepo.getMarketplacePlugins();

		const items: MarketplaceUpdateCheck[] = [];

		for (const plugin of marketplacePlugins) {
			try {
				const detail = await client.getPlugin(plugin.pluginId);
				const latest = detail.latestVersion?.version;
				const installed = plugin.marketplaceVersion ?? plugin.version;

				if (!latest) continue;

				const hasUpdate = latest !== installed;
				let capabilityChanges: { added: string[]; removed: string[] } | undefined;
				let hasCapabilityChanges = false;

				if (hasUpdate && detail.latestVersion) {
					const oldCaps = detail.capabilities ?? [];
					const newCaps = detail.latestVersion.capabilities ?? [];
					capabilityChanges = diffCapabilities(oldCaps, newCaps);
					hasCapabilityChanges =
						capabilityChanges.added.length > 0 || capabilityChanges.removed.length > 0;
				}

				items.push({
					pluginId: plugin.pluginId,
					installed,
					latest: latest ?? installed,
					hasUpdate,
					hasCapabilityChanges,
					capabilityChanges: hasCapabilityChanges ? capabilityChanges : undefined,
					// Route visibility changes require downloading both bundles to compare
					// manifests, which is too expensive for a preview check. The actual
					// enforcement happens at update time in handleMarketplaceUpdate.
					hasRouteVisibilityChanges: false,
				});
			} catch (err) {
				// Skip plugins that can't be checked (marketplace down, plugin delisted)
				console.warn(`Failed to check updates for ${plugin.pluginId}:`, err);
			}
		}

		return { success: true, data: { items } };
	} catch (err) {
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		console.error("Failed to check marketplace updates:", err);
		return {
			success: false,
			error: { code: "UPDATE_CHECK_FAILED", message: "Failed to check for updates" },
		};
	}
}

// ── Proxy ──────────────────────────────────────────────────────────

export async function handleMarketplaceSearch(
	marketplaceUrl: string | undefined,
	query?: string,
	opts?: MarketplaceSearchOpts,
): Promise<ApiResult<unknown>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}

	try {
		const result = await client.search(query, opts);
		return { success: true, data: result };
	} catch (err) {
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		console.error("Failed to search marketplace:", err);
		return {
			success: false,
			error: { code: "SEARCH_FAILED", message: "Failed to search marketplace" },
		};
	}
}

export async function handleMarketplaceGetPlugin(
	marketplaceUrl: string | undefined,
	pluginId: string,
): Promise<ApiResult<unknown>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}

	try {
		const result = await client.getPlugin(pluginId);
		return { success: true, data: result };
	} catch (err) {
		if (err instanceof MarketplaceError && err.status === 404) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Plugin not found: ${pluginId}` },
			};
		}
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		console.error("Failed to get marketplace plugin:", err);
		return {
			success: false,
			error: { code: "GET_PLUGIN_FAILED", message: "Failed to get plugin details" },
		};
	}
}

// ── Theme proxy handlers ──────────────────────────────────────────

export async function handleThemeSearch(
	marketplaceUrl: string | undefined,
	query?: string,
	opts?: MarketplaceThemeSearchOpts,
): Promise<ApiResult<unknown>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}

	try {
		const result = await client.searchThemes(query, opts);
		return { success: true, data: result };
	} catch (err) {
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		console.error("Failed to search themes:", err);
		return {
			success: false,
			error: { code: "THEME_SEARCH_FAILED", message: "Failed to search themes" },
		};
	}
}

export async function handleThemeGetDetail(
	marketplaceUrl: string | undefined,
	themeId: string,
): Promise<ApiResult<unknown>> {
	const client = getClient(marketplaceUrl);
	if (!client) {
		return {
			success: false,
			error: { code: "MARKETPLACE_NOT_CONFIGURED", message: "Marketplace is not configured" },
		};
	}

	try {
		const result = await client.getTheme(themeId);
		return { success: true, data: result };
	} catch (err) {
		if (err instanceof MarketplaceError && err.status === 404) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Theme not found: ${themeId}` },
			};
		}
		if (err instanceof MarketplaceUnavailableError) {
			return {
				success: false,
				error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable" },
			};
		}
		console.error("Failed to get marketplace theme:", err);
		return {
			success: false,
			error: { code: "GET_THEME_FAILED", message: "Failed to get theme details" },
		};
	}
}
