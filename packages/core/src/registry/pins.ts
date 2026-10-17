/**
 * Declarative registry-plugin pins and a headless installer.
 *
 * A project declares the registry plugins it needs in a
 * `registry-plugins.json` file at the project root:
 *
 * ```json
 * {
 *   "plugins": [
 *     { "did": "did:plc:…", "slug": "gallery", "version": "1.2.3" }
 *   ]
 * }
 * ```
 *
 * {@link loadRegistryPins} reads and validates that file;
 * {@link installRegistryPins} installs each pin through the same
 * `handleRegistryInstall` pipeline the admin UI uses, pinned to an exact
 * version (never "latest"). Pins install sequentially and a failed pin does
 * not abort the rest, so a template/CI run always reports the full outcome.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Kysely } from "kysely";
import { z } from "zod";

import { handleRegistryInstall, type RegistryInstallInput } from "../api/handlers/registry.js";
import type { Database } from "../database/types.js";
import type { SandboxRunner } from "../plugins/sandbox/types.js";
import type { Storage } from "../storage/types.js";
import type { RegistryConfigInput } from "./types.js";

/** File name read by {@link loadRegistryPins}, relative to the project cwd. */
export const REGISTRY_PINS_FILE = "registry-plugins.json";

/** Type guard for Node.js ErrnoException */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** A single exact registry-plugin pin. */
export interface RegistryPin {
	/** Publisher DID. */
	did: string;
	/** Package slug. */
	slug: string;
	/** Exact version to install. Pins are never floating ("latest"). */
	version: string;
}

/** Outcome of attempting one pin through {@link installRegistryPins}. */
export interface RegistryPinResult {
	pin: RegistryPin;
	ok: boolean;
	/** Error code from the install pipeline (e.g. `SANDBOX_NOT_AVAILABLE`). */
	code?: string;
	message?: string;
	/** Hashed, opaque plugin id when the install succeeded. */
	pluginId?: string;
}

/**
 * Consent payload a headless caller supplies per {@link installRegistryPins}
 * call, threaded verbatim into `handleRegistryInstall`'s input. Mirrors the
 * admin consent dialog: the caller must fetch the signed package/release
 * record CIDs from the aggregator (as the admin UI does at browse time) and
 * lift the acknowledged capabilities, MCP tools, and public routes from the
 * release's bundle manifest. Absent, the install pipeline's consent gates
 * fail the pin exactly as they fail an un-consented admin request.
 */
export type RegistryPinInstallOpts = Omit<RegistryInstallInput, "did" | "slug" | "version">;

const registryPinSchema = z.object({
	did: z.string().min(1),
	slug: z.string().min(1),
	version: z.string().min(1),
});

/**
 * Validates a `{ plugins: RegistryPin[] }` document. Extra top-level keys
 * are tolerated (and stripped from the parsed output); `version` is
 * required on every pin.
 */
export const declareRegistryPinsSchema = z.object({
	plugins: z.array(registryPinSchema),
});

/**
 * Read and validate `<cwd>/registry-plugins.json`.
 *
 * An absent file is not an error: returns `{ pins: [], source: null }` so
 * projects without registry plugins need no special-casing. A malformed
 * file (bad JSON or bad shape) throws with a message naming the file.
 */
export async function loadRegistryPins(
	cwd: string,
): Promise<{ pins: RegistryPin[]; source: string | null }> {
	const filePath = path.join(cwd, REGISTRY_PINS_FILE);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { pins: [], source: null };
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	const result = declareRegistryPinsSchema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path.join(".") || "(root)";
		throw new Error(`Invalid ${filePath}: ${where}: ${issue?.message ?? "validation failed"}`);
	}
	return { pins: result.data.plugins, source: filePath };
}

/**
 * Install each pin sequentially through `handleRegistryInstall`, passing the
 * pin's exact `version` so the aggregator's "latest" selection never applies.
 *
 * Headless callers (plain Node, no admin UI) must obtain install consent
 * themselves — fetch the signed package/release record CIDs from the
 * aggregator and lift the acknowledged capabilities, MCP tools, and public
 * routes from the bundle manifest — and pass them via `deps.installOpts`.
 * Without them, every pin that triggers a consent gate fails with
 * `RECORD_CONSENT_REQUIRED` / `DECLARED_ACCESS_REQUIRED` (etc.), which is the
 * correct policy: consent the caller never collected must not be implied.
 *
 * Per-pin failures — both structured `ApiResult` failures and unexpected
 * handler exceptions — are captured in the returned results and never abort
 * the remaining pins or throw. `onProgress` (when given) is invoked with
 * each result as it is produced.
 */
export async function installRegistryPins(deps: {
	db: Kysely<Database>;
	storage: Storage;
	sandboxRunner: SandboxRunner;
	registryConfig?: RegistryConfigInput;
	pins: RegistryPin[];
	/** Caller-obtained consent; threaded verbatim into each install. */
	installOpts?: RegistryPinInstallOpts;
	onProgress?: (r: RegistryPinResult) => void;
}): Promise<RegistryPinResult[]> {
	const results: RegistryPinResult[] = [];
	for (const pin of deps.pins) {
		let result: RegistryPinResult;
		try {
			const install = await handleRegistryInstall(
				deps.db,
				deps.storage,
				deps.sandboxRunner,
				deps.registryConfig,
				{ did: pin.did, slug: pin.slug, version: pin.version, ...deps.installOpts },
			);
			result = install.success
				? { pin, ok: true, pluginId: install.data.pluginId }
				: { pin, ok: false, code: install.error.code, message: install.error.message };
		} catch (error) {
			result = {
				pin,
				ok: false,
				code: "INSTALL_THREW",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		deps.onProgress?.(result);
		results.push(result);
	}
	return results;
}
