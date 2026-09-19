import { dirname } from "node:path";

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import * as clack from "@clack/prompts";
import { FileCredentialStore, PublishingClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { resolveSources } from "../build/pipeline.js";
import { probeEnvironment } from "../init/environment.js";
import { resolveHandleToDid } from "../manifest/publisher.js";
import { manifestToProfileInput, resolveSections } from "../manifest/translate.js";
import { resumeSession } from "../oauth.js";
import { formatPackageIdentifier } from "../package-identifier.js";
import {
	canonicalGitHubRepository,
	PackageProfileSetupError,
	setupPackageProfile,
} from "../profile/setup.js";

export interface RunProfileSetupOptions {
	dir: string;
	repository?: string;
	confirmation?: string;
	yes?: boolean;
	nextSteps?: boolean;
}

function cancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
	if (clack.isCancel(value))
		throw new PackageProfileSetupError("INVALID_INPUT", "Setup cancelled.");
}

interface RepositoryPromptOptions {
	message: string;
	defaultValue?: string;
	placeholder: string;
	validate(value: string | undefined): string | undefined;
}

export interface ResolveProfileRepositoryOptions {
	configured: string | undefined;
	interactive: boolean;
	pluginDir: string;
	prompt?: (options: RepositoryPromptOptions) => Promise<unknown>;
}

export async function resolveProfileRepository(
	options: ResolveProfileRepositoryOptions,
): Promise<string> {
	if (options.configured) return options.configured;
	const environment = await probeEnvironment(options.pluginDir);
	const detected = environment.repo
		? (canonicalGitHubRepository(environment.repo) ?? undefined)
		: undefined;
	if (!options.interactive) {
		if (detected) return detected;
		throw new PackageProfileSetupError(
			"INVALID_REPOSITORY",
			"Add `repo` to emdash-plugin.jsonc or pass --repository with an HTTPS GitHub repository URL.",
		);
	}
	const prompt = options.prompt ?? ((input) => clack.text(input));
	const answer = await prompt({
		message: detected
			? "GitHub repository URL (press enter to use the detected origin)"
			: "GitHub repository URL",
		...(detected === undefined ? {} : { defaultValue: detected }),
		placeholder: detected ?? "https://github.com/example/gallery",
		validate: (value) =>
			canonicalGitHubRepository(value ?? "") ? undefined : "Enter an HTTPS GitHub repository URL.",
	});
	cancelled(answer);
	return String(answer);
}

export function printProfileSetupResult(
	result: { status: "created" | "ready" | "updated"; profileUri: string },
	identifier: string,
	confirmation: "always" | "escalation-only",
	showNextSteps: boolean,
): void {
	if (result.status === "ready") {
		consola.success(`Package profile is ready for ${pc.bold(identifier)}`);
	} else {
		consola.success(`Published package profile for ${pc.bold(identifier)}`);
		consola.info(
			confirmation === "always"
				? "Your Atmosphere account must approve every release."
				: "Your Atmosphere account must approve releases when plugin permissions increase.",
		);
	}
	consola.info(`Profile URI: ${pc.dim(result.profileUri)}`);
	if (!showNextSteps) return;
	consola.info("Next, publish a release:");
	consola.info(`  Manually: ${pc.cyan("emdash-plugin publish")}`);
	consola.info(`  With GitHub Actions: ${pc.cyan("emdash-plugin release setup")}`);
}

async function confirmationValue(
	configured: string | undefined,
	interactive: boolean,
): Promise<"always" | "escalation-only"> {
	if (configured === "always" || configured === "escalation-only") return configured;
	if (configured !== undefined) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			"--confirmation must be `always` or `escalation-only`.",
		);
	}
	if (!interactive) return "escalation-only";
	const answer = await clack.select({
		message: "When should a release require your approval?",
		initialValue: "escalation-only",
		options: [
			{
				value: "escalation-only",
				label: "When plugin permissions increase",
				hint: "recommended",
			},
			{ value: "always", label: "For every release" },
		],
	});
	cancelled(answer);
	if (answer !== "always" && answer !== "escalation-only") {
		throw new PackageProfileSetupError("INVALID_INPUT", "Approval policy selection is invalid.");
	}
	return answer;
}

async function runProfileSetupInternal(options: RunProfileSetupOptions): Promise<void> {
	const interactive = options.yes !== true && process.stdin.isTTY === true && !process.env["CI"];
	if (interactive) clack.intro(pc.bold("Set up the package profile"));
	const sources = await resolveSources(options.dir);
	const manifestPublisher = sources.manifest.publisher;
	const publisherDid = isDid(manifestPublisher)
		? manifestPublisher
		: isHandle(manifestPublisher)
			? await resolveHandleToDid(manifestPublisher)
			: null;
	if (!publisherDid) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			"The plugin manifest publisher must be an Atmosphere account DID or handle.",
		);
	}
	const credentials = new FileCredentialStore();
	const storedSession = await credentials.current();
	if (!storedSession) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			`Log in first with: emdash-plugin login ${sources.manifest.publisher}`,
		);
	}
	if (storedSession.did !== publisherDid) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			`The active CLI account does not own ${sources.manifest.slug}. Run \`emdash-plugin switch ${publisherDid}\` first.`,
		);
	}
	const identifier = formatPackageIdentifier(
		storedSession.handle ?? storedSession.did,
		sources.manifest.slug,
	);
	const repository = await resolveProfileRepository({
		configured: options.repository ?? sources.manifest.repo,
		interactive,
		pluginDir: sources.pluginDir,
	});
	const confirmation = await confirmationValue(options.confirmation, interactive);
	const loaded = await import("../manifest/load.js").then(({ loadManifest }) =>
		loadManifest(sources.manifestPath),
	);
	sources.manifest.sections = await resolveSections(loaded.manifest.sections, dirname(loaded.path));
	const oauthSession = await resumeSession(publisherDid);
	const publisher = PublishingClient.fromHandler({
		handler: oauthSession,
		did: storedSession.did,
		pds: storedSession.pds,
	});
	const input = {
		publisher,
		slug: sources.manifest.slug,
		profile: manifestToProfileInput(sources.manifest),
		repository,
		confirmation,
	};
	const proposed = await setupPackageProfile(input);
	if (proposed.status === "ready") {
		printProfileSetupResult(proposed, identifier, confirmation, options.nextSteps !== false);
		return;
	}
	if (!interactive && options.yes !== true) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			`The ${identifier} package profile needs setup. Run this command in a terminal, or pass --yes to accept the default approval policy.`,
		);
	}
	if (interactive) {
		const action = proposed.status === "created" ? "Create" : "Update";
		const answer = await clack.confirm({
			message: `${action} the ${identifier} package profile and allow ${pc.cyan(canonicalGitHubRepository(repository) ?? repository)} to publish releases?`,
			initialValue: true,
		});
		cancelled(answer);
		if (answer !== true) {
			throw new PackageProfileSetupError(
				"INVALID_INPUT",
				"Package profile setup was not confirmed.",
			);
		}
	}
	const result = await setupPackageProfile({ ...input, apply: true });
	printProfileSetupResult(result, identifier, confirmation, options.nextSteps !== false);
}

export async function runProfileSetup(options: RunProfileSetupOptions): Promise<void> {
	try {
		await runProfileSetupInternal(options);
	} catch (error) {
		if (error instanceof PackageProfileSetupError) throw error;
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			error instanceof Error ? error.message : "Package profile setup failed.",
		);
	}
}

export const profileSetupCommand = defineCommand({
	meta: { name: "setup", description: "Create or prepare a package profile for releases" },
	args: {
		dir: {
			type: "string",
			description: "Plugin directory (default: current directory)",
			default: process.cwd(),
		},
		repository: {
			type: "string",
			description: "Canonical HTTPS GitHub repository URL (defaults to manifest repo)",
		},
		confirmation: {
			type: "string",
			description: "Approval policy: escalation-only or always",
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Create or update without interactive confirmation",
			default: false,
		},
	},
	async run({ args }) {
		try {
			await runProfileSetup(args);
		} catch (error) {
			if (error instanceof PackageProfileSetupError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}
	},
});

export const profileCommand = defineCommand({
	meta: { name: "profile", description: "Manage the plugin package profile" },
	subCommands: { setup: profileSetupCommand },
});
