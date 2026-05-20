/**
 * `emdash-plugin update-profile [--manifest <path>] [--yes] [--json]`
 *
 * Edit an already-published profile record without cutting a new release.
 *
 * Reads `emdash-plugin.jsonc`, fetches the existing profile from the
 * publisher's PDS, diffs the manifest's lexicon-controlled fields against
 * what's on the PDS, and (with `--yes`) writes the updated record back via
 * `com.atproto.repo.putRecord`. Without `--yes`, prints the diff and exits 0.
 *
 * The slug is the record key; the command refuses to change it (renames
 * would orphan every release tied to the old slug). `lastUpdated` is
 * auto-bumped to now on any successful write and is never user-editable.
 *
 * Fields the manifest controls and this command can update:
 *   - `license`
 *   - `authors` / `author`
 *   - `security` / `securityContacts`
 *   - `name`
 *   - `description`
 *   - `keywords`
 *
 * Fields preserved verbatim from the existing record: `$type`, `id`, `slug`,
 * `type`, plus any unknown forward-compatible fields (e.g. `sections` from
 * a future lexicon revision).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FileCredentialStore, PublishingClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { loadManifest, MANIFEST_FILENAME, ManifestError } from "../manifest/load.js";
import { checkPublisher, PublisherCheckError } from "../manifest/publisher.js";
import { manifestToProfileInput, normaliseManifest } from "../manifest/translate.js";
import { resumeSession } from "../oauth.js";
import {
	updateProfile,
	UpdateProfileError,
	type ProfileFieldDiff,
	type ProfileUpdateInput,
	type UpdateProfileResult,
} from "../update-profile/api.js";

export const updateProfileCommand = defineCommand({
	meta: {
		name: "update-profile",
		description:
			"Update an already-published plugin profile without cutting a new release (license, authors, security contacts, name/description/keywords).",
	},
	args: {
		manifest: {
			type: "string",
			description: `Path to emdash-plugin.jsonc, or the directory containing it. Defaults to ./${MANIFEST_FILENAME}.`,
		},
		yes: {
			type: "boolean",
			description:
				"Apply the diff. Without this flag, the command runs as a dry-run: prints what would change and exits 0 without writing.",
			default: false,
		},
		json: {
			type: "boolean",
			description:
				"Emit a single-line JSON object on stdout instead of human output. Success: {profile, diffs, written, cid?}. Failure: {error: {code, message}}. Human-readable progress goes to stderr.",
		},
	},
	async run({ args }) {
		const restoreReporters = args.json ? redirectConsolaToStderr() : null;
		let exitCode = 0;
		try {
			await runUpdateProfile(args);
		} catch (error) {
			exitCode = error instanceof CliError ? error.exitCode : 1;
			handleUpdateProfileError(error, args.json);
		} finally {
			restoreReporters?.();
		}
		if (exitCode !== 0) process.exit(exitCode);
	},
});

interface UpdateProfileArgs {
	manifest?: string;
	yes?: boolean;
	json?: boolean;
}

async function runUpdateProfile(args: UpdateProfileArgs): Promise<void> {
	const manifestPath = args.manifest ?? `./${MANIFEST_FILENAME}`;
	const manifestLoad = await loadManifestForUpdate(manifestPath);

	const credentials = new FileCredentialStore();
	const session = await credentials.current();
	if (!session) {
		throw new CliError(
			"Not logged in. Run: emdash-plugin login <handle-or-did>",
			1,
			"NOT_LOGGED_IN",
		);
	}
	consola.info(`Editing as ${pc.bold(session.handle ?? session.did)} (${pc.dim(session.did)})`);

	try {
		const check = await checkPublisher({
			manifestPublisher: manifestLoad.manifest.publisher,
			sessionDid: session.did,
		});
		if (check.kind === "mismatch") {
			throw new CliError(
				`Manifest pins publisher to ${pc.bold(check.pinnedDisplay)} (${check.pinnedDid}), but the active session is ${session.did}. ` +
					`Either switch sessions (\`emdash-plugin switch ${check.pinnedDid}\`), or edit the manifest if you are transferring the plugin to a new publisher.`,
				1,
				"MANIFEST_PUBLISHER_MISMATCH",
			);
		}
	} catch (error) {
		if (error instanceof PublisherCheckError) {
			throw new CliError(error.message, 1, error.code);
		}
		throw error;
	}

	const oauthSession = await resumeSession(session.did);
	const publisher = PublishingClient.fromHandler({
		handler: oauthSession,
		did: session.did,
		pds: session.pds,
	});

	const input: ProfileUpdateInput = profileUpdateInputFromManifest(manifestLoad.manifest);

	const result = await updateProfile({
		publisher,
		did: session.did,
		slug: manifestLoad.manifest.slug,
		input,
		apply: args.yes ?? false,
	});

	if (args.json) {
		process.stdout.write(`${JSON.stringify(formatJsonResult(result, args.yes ?? false))}\n`);
		return;
	}

	renderResult(result, args.yes ?? false);
}

/**
 * Result of resolving the manifest for `runUpdateProfile`. Surfaces the
 * normalised manifest with `manifest.version` resolved against the sibling
 * `package.json` (mirrors the publish path so the two commands agree on
 * which manifest they're talking about — even though version isn't part of
 * the profile record).
 */
interface ManifestLoadOutcome {
	path: string;
	manifest: ReturnType<typeof normaliseManifest>;
}

async function loadManifestForUpdate(path: string): Promise<ManifestLoadOutcome> {
	try {
		const { manifest, path: resolvedPath } = await loadManifest(path);
		const packageVersion = await readSiblingPackageVersion(dirname(resolvedPath));
		let normalised: ReturnType<typeof normaliseManifest>;
		try {
			normalised = normaliseManifest(manifest, packageVersion);
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				const code = (error as { code: unknown }).code;
				if (code === "VERSION_MISSING" || code === "VERSION_MISMATCH") {
					throw new CliError(error.message, 1, String(code));
				}
			}
			throw error;
		}
		consola.info(`Loaded manifest: ${pc.dim(resolvedPath)}`);
		return { path: resolvedPath, manifest: normalised };
	} catch (error) {
		if (error instanceof ManifestError) {
			throw new CliError(error.message, 1, error.code);
		}
		throw error;
	}
}

/**
 * Read `package.json#version` from the directory containing the manifest.
 * Mirrors the publish path. Missing or unparseable package.json is non-
 * fatal for update-profile (version isn't part of the profile record),
 * but malformed JSON still surfaces so a typo doesn't pass silently.
 */
async function readSiblingPackageVersion(manifestDir: string): Promise<string | undefined> {
	const packageJsonPath = join(manifestDir, "package.json");
	let source: string;
	try {
		source = await readFile(packageJsonPath, "utf-8");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: unknown }).code === "ENOENT"
		) {
			return undefined;
		}
		throw new CliError(
			`Failed to read package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
			1,
			"PACKAGE_JSON_UNREADABLE",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new CliError(
			`package.json at ${packageJsonPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			1,
			"PACKAGE_JSON_INVALID",
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CliError(
			`package.json at ${packageJsonPath} must be a JSON object.`,
			1,
			"PACKAGE_JSON_INVALID",
		);
	}
	const version = (parsed as { version?: unknown }).version;
	return typeof version === "string" ? version : undefined;
}

/**
 * Project the manifest's profile-shaped fields into the
 * `ProfileUpdateInput` contract. We reuse `manifestToProfileInput` from
 * the publish path so the two commands agree on what comes out of the
 * manifest, then drop the first-publish-only fields that update-profile
 * doesn't touch.
 */
function profileUpdateInputFromManifest(
	manifest: ReturnType<typeof normaliseManifest>,
): ProfileUpdateInput {
	const profile = manifestToProfileInput(manifest);
	const input: ProfileUpdateInput = {
		// license is required in the manifest schema, so it's always
		// present in `manifestToProfileInput`'s output. The non-null
		// assertion would be wrong if the manifest schema ever relaxes
		// that; assigning via fallback keeps the cast honest.
		license: profile.license ?? "",
		authors: profile.authors ?? [],
		security: profile.security ?? [],
	};
	if (profile.name !== undefined) input.name = profile.name;
	if (profile.description !== undefined) input.description = profile.description;
	if (profile.keywords !== undefined) input.keywords = profile.keywords;
	return input;
}

function renderResult(result: UpdateProfileResult, applied: boolean): void {
	if (result.diffs.length === 0) {
		consola.success(`Profile at ${pc.dim(result.profileUri)} is already up to date.`);
		return;
	}

	console.log();
	console.log(pc.bold(applied ? "Applied profile changes:" : "Profile changes (dry-run):"));
	for (const diff of result.diffs) {
		renderDiffLine(diff);
	}
	console.log();

	if (applied && result.written) {
		consola.success(`Updated profile: ${pc.dim(result.profileUri)}`);
		if (result.cid) {
			consola.info(`New CID: ${pc.dim(result.cid)}`);
		}
	} else {
		consola.info(
			`Dry-run complete. Re-run with ${pc.bold("--yes")} to write these changes to your PDS.`,
		);
	}
}

function renderDiffLine(diff: ProfileFieldDiff): void {
	const beforeStr = formatFieldValue(diff.before);
	const afterStr = formatFieldValue(diff.after);
	const removed = diff.after === undefined;
	const added = diff.before === undefined;
	const marker = added ? pc.green("+") : removed ? pc.red("-") : pc.yellow("~");
	console.log(`  ${marker} ${pc.bold(diff.field)}`);
	if (!added) console.log(`      ${pc.red(`- ${beforeStr}`)}`);
	if (!removed) console.log(`      ${pc.green(`+ ${afterStr}`)}`);
}

function formatFieldValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function formatJsonResult(result: UpdateProfileResult, applied: boolean): Record<string, unknown> {
	const body: Record<string, unknown> = {
		profile: result.profileUri,
		written: result.written,
		applied,
		diffs: result.diffs.map((d) => ({
			field: d.field,
			before: d.before ?? null,
			after: d.after ?? null,
		})),
	};
	if (result.cid) body.cid = result.cid;
	return body;
}

function handleUpdateProfileError(error: unknown, jsonMode: boolean | undefined): void {
	let code = "INTERNAL_ERROR";
	let message = "Internal error";
	let detail: Record<string, unknown> | undefined;
	if (error instanceof UpdateProfileError) {
		code = error.code;
		message = error.message;
		detail = error.detail;
		consola.error(error.message);
	} else if (error instanceof CliError) {
		code = error.code;
		message = error.message;
		consola.error(error.message);
	} else if (error instanceof Error) {
		message = error.message;
		consola.error(error);
	} else {
		message = String(error);
		consola.error(error);
	}
	if (jsonMode) {
		const body: Record<string, unknown> = { code, message };
		if (detail !== undefined) body.detail = detail;
		process.stdout.write(`${JSON.stringify({ error: body })}\n`);
	}
}

class CliError extends Error {
	override readonly name = "CliError";
	constructor(
		message: string,
		readonly exitCode: number,
		readonly code: string,
	) {
		super(message);
	}
}

/**
 * Reroute consola to stderr so stdout stays clean for `--json` consumers.
 * Returns a restore function. Mirrors the publish command's helper so the
 * two share a contract for json-mode pipe consumers.
 */
function redirectConsolaToStderr(): () => void {
	const previous = consola.options.reporters?.slice() ?? [];
	consola.setReporters([
		{
			log(logObj) {
				const level = logObj.type ?? "info";
				const tag = logObj.tag ? `[${logObj.tag}] ` : "";
				const args = logObj.args ?? [];
				const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
				process.stderr.write(`${level}: ${tag}${message}\n`);
			},
		},
	]);
	return () => {
		consola.setReporters(previous);
	};
}
