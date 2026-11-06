/**
 * Credential storage for CLI auth tokens.
 *
 * Stores OAuth tokens in ~/.config/emdash/auth.json.
 * Remote URLs are keyed by origin, local dev by project path.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { lockSync } from "proper-lockfile";

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

type CredentialStore = Record<string, StoredCredential>;

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
	const path = getCredentialPath();
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(store, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
			flag: "wx",
			flush: true,
		});
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function withStoreLock<T>(update: () => T): T {
	mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
	const path = getCredentialPath();
	const deadline = performance.now() + 15_000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	let release: () => void;
	while (true) {
		try {
			// The store may not exist yet, so lock its path without resolving the file.
			release = lockSync(path, { realpath: false, stale: 10_000 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			if (performance.now() >= deadline) {
				throw new Error(`Timed out waiting to update CLI credentials at ${path}. Try again.`, {
					cause: error,
				});
			}
			// proper-lockfile's synchronous API does not support retries.
			Atomics.wait(sleeper, 0, 0, 25);
		}
	}
	try {
		return update();
	} finally {
		release();
	}
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
	withStoreLock(() => {
		const store = readStore();
		store[key] = cred;
		writeStore(store);
	});
}

/**
 * Remove credentials for a URL.
 */
export function removeCredentials(baseUrl: string): boolean {
	const key = resolveCredentialKey(baseUrl);
	return withStoreLock(() => {
		const store = readStore();
		if (key in store) {
			delete store[key];
			writeStore(store);
			return true;
		}
		return false;
	});
}

/**
 * List all stored credential keys.
 */
export function listCredentialKeys(): string[] {
	const store = readStore();
	return Object.keys(store);
}
