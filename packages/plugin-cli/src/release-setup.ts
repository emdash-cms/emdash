import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDid, isHandle, type Handle } from "@atcute/lexicons/syntax";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { resolveSources } from "./build/pipeline.js";
import { runProfileSetup } from "./commands/profile.js";
import { resolveHandleToDid } from "./manifest/publisher.js";
import { installedCliVersion } from "./package-version.js";
import { findRepositoryRoot } from "./release-prepare.js";

export const DEFAULT_RELEASE_SERVICE_URL = "https://releases.emdashcms.com";
export const DEFAULT_RELEASE_ACTION_REF = "main";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/emdash-release.yml";

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CHANGESETS_CONFIG_PATH = ".changeset/config.json";

export type ReleaseTrigger = "changesets" | "manual" | "tags";
export type ReleaseTriggerOption = "auto" | ReleaseTrigger;

export interface ChangesetsConfiguration {
	baseBranch: string;
	privatePackagesTag: boolean;
	privatePackagesVersion: boolean;
}

export type ReleaseSetupErrorCode =
	| "PUBLISHER_REQUIRED"
	| "PUBLISHER_UNRESOLVED"
	| "INVALID_SERVICE_URL"
	| "INVALID_ACTION_REF"
	| "INVALID_TRIGGER"
	| "CHANGESETS_CONFIG_INVALID"
	| "CHANGESETS_NOT_FOUND"
	| "WORKFLOW_EXISTS";

export class ReleaseSetupError extends Error {
	override readonly name = "ReleaseSetupError";

	constructor(
		readonly code: ReleaseSetupErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface SetupReleaseWorkflowOptions {
	dir: string;
	force?: boolean;
	serviceUrl?: string;
	actionRef?: string;
	trigger?: ReleaseTriggerOption;
	resolvePublisherDid?: (handle: Handle) => Promise<string>;
	beforeWrite?: (context: { publisherDid: string; pluginDir: string }) => Promise<void>;
}

export interface SetupReleaseWorkflowResult {
	path: string;
	publisherDid: string;
	status: "created" | "replaced" | "reused";
	trigger: ReleaseTrigger;
	warnings: readonly string[];
}

export function resolveReleaseTrigger(value: string, changesetsDetected: boolean): ReleaseTrigger {
	if (value === "auto") return changesetsDetected ? "changesets" : "tags";
	if (value === "changesets" || value === "manual" || value === "tags") return value;
	throw new ReleaseSetupError(
		"INVALID_TRIGGER",
		"--trigger must be auto, changesets, tags, or manual.",
	);
}

export async function detectChangesets(
	repositoryRoot: string,
): Promise<ChangesetsConfiguration | null> {
	let raw: string;
	try {
		raw = await readFile(join(repositoryRoot, CHANGESETS_CONFIG_PATH), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ReleaseSetupError(
			"CHANGESETS_CONFIG_INVALID",
			`${join(repositoryRoot, CHANGESETS_CONFIG_PATH)} is not valid JSON.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ReleaseSetupError(
			"CHANGESETS_CONFIG_INVALID",
			`${join(repositoryRoot, CHANGESETS_CONFIG_PATH)} must contain a Changesets configuration object.`,
		);
	}
	const baseBranch = Reflect.get(parsed, "baseBranch") ?? "main";
	const privatePackages = Reflect.get(parsed, "privatePackages");
	if (
		typeof baseBranch !== "string" ||
		!ACTION_REF_PATTERN.test(baseBranch) ||
		baseBranch.includes("..") ||
		baseBranch.includes("//") ||
		baseBranch.endsWith("/") ||
		(privatePackages !== undefined &&
			(privatePackages === null ||
				typeof privatePackages !== "object" ||
				Array.isArray(privatePackages)))
	) {
		throw new ReleaseSetupError(
			"CHANGESETS_CONFIG_INVALID",
			`${join(repositoryRoot, CHANGESETS_CONFIG_PATH)} has invalid release settings.`,
		);
	}
	return {
		baseBranch,
		privatePackagesTag:
			privatePackages !== undefined && Reflect.get(privatePackages, "tag") === true,
		privatePackagesVersion:
			privatePackages !== undefined && Reflect.get(privatePackages, "version") === true,
	};
}

export async function setupReleaseWorkflow(
	options: SetupReleaseWorkflowOptions,
): Promise<SetupReleaseWorkflowResult> {
	const sources = await resolveSources(options.dir);
	const publisher = sources.manifest.publisher;
	if (!publisher) {
		throw new ReleaseSetupError(
			"PUBLISHER_REQUIRED",
			`Add a publisher DID or handle to ${sources.manifestPath} before setting up releases.`,
		);
	}

	const publisherDid = await resolvePublisherDid(
		publisher,
		options.resolvePublisherDid ?? resolveHandleToDid,
	);
	const serviceUrl = validateServiceUrl(options.serviceUrl ?? DEFAULT_RELEASE_SERVICE_URL);
	const actionRef = validateActionRef(options.actionRef ?? DEFAULT_RELEASE_ACTION_REF);
	const cliVersion = await installedCliVersion();
	const repositoryRoot = await findRepositoryRoot(sources.pluginDir);
	const triggerOption = options.trigger ?? "tags";
	const changesets =
		triggerOption === "auto" || triggerOption === "changesets"
			? await detectChangesets(repositoryRoot)
			: null;
	const trigger = resolveReleaseTrigger(triggerOption, changesets !== null);
	if (trigger === "changesets" && changesets === null) {
		throw new ReleaseSetupError(
			"CHANGESETS_NOT_FOUND",
			`--trigger changesets requires ${join(repositoryRoot, CHANGESETS_CONFIG_PATH)}.`,
		);
	}
	const warnings: string[] = [];
	if (
		trigger === "changesets" &&
		changesets !== null &&
		(!changesets.privatePackagesVersion || !changesets.privatePackagesTag) &&
		(await pluginPackageIsPrivate(sources.pluginDir))
	) {
		warnings.push(
			"Changesets must version and tag private plugin packages. Set privatePackages.version and privatePackages.tag to true in .changeset/config.json before relying on Changesets releases.",
		);
	}
	const workflowPath = join(repositoryRoot, RELEASE_WORKFLOW_PATH);
	const workflow = renderReleaseWorkflow({
		serviceUrl,
		actionRef,
		cliVersion,
		trigger,
	});
	let existing: string | null = null;
	try {
		existing = await readFile(workflowPath, "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	if (existing !== null && existing !== workflow && !options.force) {
		throw new ReleaseSetupError(
			"WORKFLOW_EXISTS",
			`${workflowPath} already exists and differs from the shared EmDash workflow. Re-run with --force to replace it.`,
		);
	}
	await options.beforeWrite?.({ publisherDid, pluginDir: sources.pluginDir });
	if (existing === workflow && !options.force) {
		return { path: workflowPath, publisherDid, status: "reused", trigger, warnings };
	}

	await mkdir(join(repositoryRoot, ".github", "workflows"), { recursive: true });
	try {
		await writeFile(workflowPath, workflow, {
			encoding: "utf8",
			flag: options.force || existing !== null ? "w" : "wx",
		});
	} catch (error) {
		if (
			!options.force &&
			error instanceof Error &&
			"code" in error &&
			(error as { code: unknown }).code === "EEXIST"
		) {
			throw new ReleaseSetupError(
				"WORKFLOW_EXISTS",
				`${workflowPath} already exists. Re-run with --force to replace it.`,
			);
		}
		throw error;
	}

	return {
		path: workflowPath,
		publisherDid,
		status: existing === null ? "created" : "replaced",
		trigger,
		warnings,
	};
}

async function pluginPackageIsPrivate(pluginDir: string): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			Reflect.get(parsed, "private") === true
		);
	} catch {
		return false;
	}
}

async function resolvePublisherDid(
	publisher: string,
	resolveHandle: (handle: Handle) => Promise<string>,
): Promise<string> {
	if (isDid(publisher)) return publisher;
	if (!isHandle(publisher)) {
		throw new ReleaseSetupError(
			"PUBLISHER_UNRESOLVED",
			`Manifest publisher ${JSON.stringify(publisher)} is not a valid DID or handle.`,
		);
	}

	let resolved: string;
	try {
		resolved = await resolveHandle(publisher);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ReleaseSetupError(
			"PUBLISHER_UNRESOLVED",
			`Could not resolve publisher handle ${publisher} to a DID: ${reason}`,
		);
	}
	if (!isDid(resolved)) {
		throw new ReleaseSetupError(
			"PUBLISHER_UNRESOLVED",
			`Publisher handle ${publisher} did not resolve to a valid DID.`,
		);
	}
	return resolved;
}

function validateServiceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ReleaseSetupError(
			"INVALID_SERVICE_URL",
			"--service-url must be a valid HTTPS origin.",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new ReleaseSetupError(
			"INVALID_SERVICE_URL",
			"--service-url must be an HTTPS origin without a path, query, or fragment.",
		);
	}
	return url.origin;
}

function validateActionRef(value: string): string {
	if (
		!ACTION_REF_PATTERN.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/")
	) {
		throw new ReleaseSetupError(
			"INVALID_ACTION_REF",
			"--action-ref must be a Git ref such as main, v1, or releases/v1.",
		);
	}
	return value;
}

function renderReleaseWorkflow(input: {
	serviceUrl: string;
	actionRef: string;
	cliVersion: string;
	trigger: ReleaseTrigger;
}): string {
	if (input.trigger === "changesets") return renderChangesetsReleaseWorkflow(input);
	const trigger =
		input.trigger === "tags"
			? `  push:
    tags:
      - "*@*"
  workflow_dispatch:`
			: "  workflow_dispatch:";
	return `name: "Publish EmDash plugins"

on:
${trigger}
    inputs:
      package:
        description: "Plugin ID to publish"
        required: true
        type: string

permissions:
  contents: read
  id-token: write # Required for the audience-bound GitHub OIDC token.
  attestations: write # Required to sign build provenance.

concurrency:
  group: emdash-release-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    name: "Build and publish plugin"
    runs-on: ubuntu-latest
    steps:
      - name: "Check repository visibility"
        if: \${{ github.event.repository.visibility != 'public' }}
        run: |
          echo "::error title=Public repository required::EmDash releases currently require a public GitHub repository because private and internal repository attestations cannot yet be verified."
          exit 1

      - name: "Check out repository"
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false

      - name: "Set up pnpm"
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
        with:
          version: 11

      - name: "Set up Node.js"
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 24
          cache: pnpm

      - name: "Install dependencies"
        run: pnpm install --frozen-lockfile

      - name: "Prepare plugin release"
        id: prepare
        shell: bash
        env:
          EMDASH_RELEASE_SELECTOR: \${{ inputs.package || github.ref_name }}
        run: |
          set -euo pipefail
          pnpm dlx @emdash-cms/plugin-cli@${input.cliVersion} release prepare "\${EMDASH_RELEASE_SELECTOR}" --dir . --out-dir .emdash-release

      - name: "Create build provenance"
        id: attest
        uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3
        with:
          subject-path: \${{ steps.prepare.outputs.bundle-file }}

      - name: "Publish plugin"
        uses: emdash-cms/emdash/apps/release-action@${input.actionRef} # zizmor: ignore[unpinned-uses] -- configured by --action-ref
        with:
          service-url: ${input.serviceUrl}
          publisher-did: \${{ steps.prepare.outputs.publisher-did }}
          bundle-file: \${{ steps.prepare.outputs.bundle-file }}
          provenance-file: \${{ steps.attest.outputs.bundle-path }}
`;
}

function renderChangesetsReleaseWorkflow(input: {
	serviceUrl: string;
	actionRef: string;
	cliVersion: string;
}): string {
	return `name: "Publish EmDash plugins"

on:
  workflow_call:
    inputs:
      published-packages:
        description: "Changesets Action published-packages JSON output"
        required: true
        type: string
  workflow_dispatch:
    inputs:
      package:
        description: "Plugin ID to publish"
        required: true
        type: string

permissions: {}

concurrency:
  group: emdash-release-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  plan:
    name: "Plan plugin releases"
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      selectors: \${{ steps.changesets.outputs.selectors || steps.manual.outputs.selectors }}
    steps:
      - name: "Check out repository"
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: "Set up pnpm"
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
        with:
          version: 11

      - name: "Set up Node.js"
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 24

      - name: "Plan Changesets plugin releases"
        id: changesets
        if: \${{ github.event_name == 'workflow_call' }}
        shell: bash
        env:
          EMDASH_PUBLISHED_PACKAGES: \${{ inputs.published-packages }}
        run: |
          set -euo pipefail
          pnpm dlx @emdash-cms/plugin-cli@${input.cliVersion} release plan --published-packages "\${EMDASH_PUBLISHED_PACKAGES}" --dir .

      - name: "Plan manual plugin release"
        id: manual
        if: \${{ github.event_name == 'workflow_dispatch' }}
        shell: bash
        env:
          EMDASH_RELEASE_SELECTOR: \${{ inputs.package }}
        run: |
          set -euo pipefail
          pnpm dlx @emdash-cms/plugin-cli@${input.cliVersion} release plan --package "\${EMDASH_RELEASE_SELECTOR}" --dir .

  publish:
    name: "Build and publish \${{ matrix.selector }}"
    needs: plan
    if: \${{ needs.plan.outputs.selectors != '[]' }}
    strategy:
      fail-fast: false
      matrix:
        selector: \${{ fromJSON(needs.plan.outputs.selectors) }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # Required for the audience-bound GitHub OIDC token.
      attestations: write # Required to sign build provenance.
    steps:
      - name: "Check repository visibility"
        if: \${{ github.event.repository.visibility != 'public' }}
        run: |
          echo "::error title=Public repository required::EmDash releases currently require a public GitHub repository because private and internal repository attestations cannot yet be verified."
          exit 1

      - name: "Check out repository"
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false

      - name: "Set up pnpm"
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
        with:
          version: 11

      - name: "Set up Node.js"
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 24
          cache: pnpm

      - name: "Install dependencies"
        run: pnpm install --frozen-lockfile

      - name: "Prepare plugin release"
        id: prepare
        shell: bash
        env:
          EMDASH_RELEASE_SELECTOR: "\${{ matrix.selector }}"
        run: |
          set -euo pipefail
          pnpm dlx @emdash-cms/plugin-cli@${input.cliVersion} release prepare "\${EMDASH_RELEASE_SELECTOR}" --dir . --out-dir .emdash-release

      - name: "Create build provenance"
        id: attest
        uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3
        with:
          subject-path: \${{ steps.prepare.outputs.bundle-file }}

      - name: "Publish plugin"
        uses: emdash-cms/emdash/apps/release-action@${input.actionRef} # zizmor: ignore[unpinned-uses] -- configured by --action-ref
        with:
          service-url: ${input.serviceUrl}
          publisher-did: \${{ steps.prepare.outputs.publisher-did }}
          bundle-file: \${{ steps.prepare.outputs.bundle-file }}
          provenance-file: \${{ steps.attest.outputs.bundle-path }}
`;
}

export const releaseSetupCommand = defineCommand({
	meta: {
		name: "setup",
		description: "Create a GitHub Actions workflow for publishing this plugin",
	},
	args: {
		dir: {
			type: "string",
			description: "Plugin directory (default: current directory)",
			default: process.cwd(),
		},
		"service-url": {
			type: "string",
			description: "Release service origin",
			default: DEFAULT_RELEASE_SERVICE_URL,
		},
		"action-ref": {
			type: "string",
			description: "EmDash repository ref containing the release Action",
			default: DEFAULT_RELEASE_ACTION_REF,
		},
		trigger: {
			type: "string",
			description: "Release trigger: auto, changesets, tags, or manual",
			default: "auto",
		},
		force: {
			type: "boolean",
			description: `Replace an existing ${RELEASE_WORKFLOW_PATH}`,
			default: false,
		},
		repository: {
			type: "string",
			description: "Canonical HTTPS GitHub repository URL (defaults to manifest or Git origin)",
		},
		provenance: {
			type: "string",
			description: "Provenance policy: required or optional",
		},
		confirmation: {
			type: "string",
			description: "Approval policy: escalation-only or always",
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "Accept the default package-profile policies without prompting",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const repositoryRoot = await findRepositoryRoot(args.dir);
			const changesets =
				args.trigger === "auto" || args.trigger === "changesets"
					? await detectChangesets(repositoryRoot)
					: null;
			let trigger = resolveReleaseTrigger(args.trigger, changesets !== null);
			if (args.trigger === "auto" && changesets && !args.yes && process.stdin.isTTY === true) {
				const selected = await clack.select({
					message: "How should EmDash plugins be released?",
					options: [
						{
							value: "changesets",
							label: "Follow Changesets releases",
							hint: "publish matching EmDash plugins at the same versions",
						},
						{ value: "tags", label: "Follow package tags", hint: "<slug>@<version>" },
						{ value: "manual", label: "Manual only", hint: "run from GitHub Actions" },
					],
					initialValue: "changesets",
				});
				if (clack.isCancel(selected)) {
					clack.cancel("Cancelled.");
					process.exit(0);
				}
				trigger = resolveReleaseTrigger(selected, true);
			}
			const result = await setupReleaseWorkflow({
				dir: args.dir,
				serviceUrl: args["service-url"],
				actionRef: args["action-ref"],
				force: args.force,
				trigger,
				beforeWrite: async () =>
					runProfileSetup({
						dir: args.dir,
						repository: args.repository,
						provenance: args.provenance,
						confirmation: args.confirmation,
						yes: args.yes,
						nextSteps: false,
					}),
			});
			for (const warning of result.warnings) consola.warn(warning);
			consola.success(
				result.status === "reused"
					? `Using shared workflow ${pc.cyan(result.path)}`
					: `${result.status === "created" ? "Created" : "Replaced"} ${pc.cyan(result.path)}`,
			);
			consola.info("Review and commit the workflow when you are ready. Nothing was pushed.");
			consola.info(
				result.trigger === "changesets"
					? "Pass your Changesets Action published-packages output to this reusable workflow. See the delegated release guide for the caller job."
					: result.trigger === "tags"
						? "Publish by pushing a package tag such as gallery@1.2.3, or run the workflow from GitHub Actions."
						: "Start a release from the workflow's Run workflow control.",
			);
			consola.info("The first run links this repository workflow in the release dashboard.");
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Release setup failed.");
			process.exit(1);
		}
	},
});
