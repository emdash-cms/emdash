/**
 * Credential storage for CLI auth tokens.
 *
 * Stores OAuth tokens in ~/.config/emdash/auth.json.
 * Remote URLs are keyed by origin, local dev by project path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	url?: string; // For local dev: the localhost URL
	/** Custom headers to send with every request (e.g. CF Access service token) */
	customHeaders?: Record<string, string>;
	user?: {
		email: string;
		role: string;
	};
}

/** Credential for marketplace auth (GitHub OAuth JWT, no refresh token) */
export interface MarketplaceCredential {
	token: string;
	expiresAt: string;
	author?: {
		id: string;
		name: string;
	};
}

type CredentialStore = Record<string, StoredCredential | MarketplaceCredential>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
	// XDG_CONFIG_HOME or ~/.config
	const xdg = process.env["XDG_CONFIG_HOME"];
	if (xdg) return join(xdg, "emdash");
	return join(homedir(), ".config", "emdash");
}

function getCredentialPath(): string {
	return join(getConfigDir(), "auth.json");
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the credential key for a given URL.
 *
 * Remote URLs are keyed by origin (e.g. "https://my-site.pages.dev").
 * Local dev instances are keyed by project path (e.g. "path:/Users/matt/sites/blog").
 */
export function resolveCredentialKey(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		const isLocal =
			url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

		if (isLocal) {
			// For local dev, key by project path
			const projectPath = findProjectRoot(process.cwd());
			if (projectPath) {
				return `path:${projectPath}`;
			}
			// Fallback to URL if no project root found
			return url.origin;
		}

		return url.origin;
	} catch {
		return baseUrl;
	}
}

/**
 * Walk up from cwd to find the project root (directory containing astro.config.*).
 */
function findProjectRoot(from: string): string | null {
	let dir = resolve(from);
	const root = resolve("/");

	while (dir !== root) {
		for (const name of [
			"astro.config.ts",
			"astro.config.mts",
			"astro.config.js",
			"astro.config.mjs",
		]) {
			if (existsSync(join(dir, name))) {
				return dir;
			}
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Read/write
// ---------------------------------------------------------------------------

function readStore(): CredentialStore {
	const path = getCredentialPath();
	try {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content) as CredentialStore;
		}
	} catch {
		// Corrupt file — start fresh
	}
	return {};
}

function writeStore(store: CredentialStore): void {
	const dir = getConfigDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const path = getCredentialPath();
	writeFileSync(path, JSON.stringify(store, null, "\t"), {
		encoding: "utf-8",
		mode: 0o600, // Owner read/write only
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get stored credentials for a URL.
 */
export function getCredentials(baseUrl: string): StoredCredential | null {
	const key = resolveCredentialKey(baseUrl);
	const store = readStore();
	const cred = store[key];
	if (!cred || !("accessToken" in cred)) return null;
	return cred;
}

/**
 * Save credentials for a URL.
 */
export function saveCredentials(baseUrl: string, cred: StoredCredential): void {
	const key = resolveCredentialKey(baseUrl);
	const store = readStore();
	store[key] = cred;
	writeStore(store);
}

/**
 * Remove credentials for a URL.
 */
export function removeCredentials(baseUrl: string): boolean {
	const key = resolveCredentialKey(baseUrl);
	const store = readStore();
	if (key in store) {
		delete store[key];
		writeStore(store);
		return true;
	}
	return false;
}

/**
 * List all stored credential keys.
 */
export function listCredentialKeys(): string[] {
	const store = readStore();
	return Object.keys(store);
}

// ---------------------------------------------------------------------------
// Marketplace credentials
// ---------------------------------------------------------------------------

function marketplaceKey(registryUrl: string): string {
	try {
		return `marketplace:${new URL(registryUrl).origin}`;
	} catch {
		return `marketplace:${registryUrl}`;
	}
}

/**
 * Get stored marketplace credential for a registry URL.
 */
export function getMarketplaceCredential(registryUrl: string): MarketplaceCredential | null {
	const key = marketplaceKey(registryUrl);
	const store = readStore();
	const cred = store[key];
	if (!cred || !("token" in cred)) return null;
	// Check expiry
	if (new Date(cred.expiresAt) < new Date()) return null;
	return cred;
}

/**
 * Save marketplace credential for a registry URL.
 */
export function saveMarketplaceCredential(registryUrl: string, cred: MarketplaceCredential): void {
	const key = marketplaceKey(registryUrl);
	const store = readStore();
	store[key] = cred;
	writeStore(store);
}

/**
 * Remove marketplace credential for a registry URL.
 */
export function removeMarketplaceCredential(registryUrl: string): boolean {
	const key = marketplaceKey(registryUrl);
	const store = readStore();
	if (key in store) {
		delete store[key];
		writeStore(store);
		return true;
	}
	return false;
}
