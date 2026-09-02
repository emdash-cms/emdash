import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDid, isHandle, type Handle } from "@atcute/lexicons/syntax";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { resolveSources } from "./build/pipeline.js";
import { resolveHandleToDid } from "./manifest/publisher.js";

export const DEFAULT_RELEASE_SERVICE_URL = "https://emdash-release-service.emdash-cms.workers.dev";
export const DEFAULT_RELEASE_ACTION_REF = "main";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/emdash-release.yml";

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type ReleaseSetupErrorCode =
	| "PUBLISHER_REQUIRED"
	| "PUBLISHER_UNRESOLVED"
	| "INVALID_SERVICE_URL"
	| "INVALID_ACTION_REF"
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
	resolvePublisherDid?: (handle: Handle) => Promise<string>;
}

export interface SetupReleaseWorkflowResult {
	path: string;
	publisherDid: string;
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
	const workflowPath = join(sources.pluginDir, RELEASE_WORKFLOW_PATH);

	await mkdir(join(sources.pluginDir, ".github", "workflows"), { recursive: true });
	try {
		await writeFile(workflowPath, renderReleaseWorkflow({ publisherDid, serviceUrl, actionRef }), {
			encoding: "utf8",
			flag: options.force ? "w" : "wx",
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

	return { path: workflowPath, publisherDid };
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
	publisherDid: string;
	serviceUrl: string;
	actionRef: string;
}): string {
	return `name: "Publish EmDash plugin"

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: read
  id-token: write
  attestations: write

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
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

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

      - name: "Build plugin bundle"
        id: bundle
        shell: bash
        run: |
          set -euo pipefail
          pnpm exec emdash-plugin bundle --dir . --out-dir .emdash-release
          shopt -s nullglob
          bundles=(.emdash-release/*.tar.gz)
          if (( \${#bundles[@]} != 1 )); then
            echo "Expected exactly one plugin bundle in .emdash-release, found \${#bundles[@]}" >&2
            exit 1
          fi
          printf 'path=%s\\n' "\${bundles[0]}" >> "\${GITHUB_OUTPUT}"

      - name: "Create build provenance"
        id: attest
        uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3
        with:
          subject-path: \${{ steps.bundle.outputs.path }}

      - name: "Publish plugin"
        uses: emdash-cms/emdash/apps/release-action@${input.actionRef}
        with:
          service-url: ${input.serviceUrl}
          publisher-did: ${input.publisherDid}
          connection-invitation: \${{ secrets.EMDASH_CONNECTION_INVITATION }}
          bundle-file: \${{ steps.bundle.outputs.path }}
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
		force: {
			type: "boolean",
			description: `Replace an existing ${RELEASE_WORKFLOW_PATH}`,
			default: false,
		},
	},
	async run({ args }) {
		try {
			const result = await setupReleaseWorkflow({
				dir: args.dir,
				serviceUrl: args["service-url"],
				actionRef: args["action-ref"],
				force: args.force,
			});
			consola.success(`Created ${pc.cyan(result.path)}`);
			consola.info("Review and commit the workflow when you are ready. Nothing was pushed.");
			consola.info(
				"Publish by pushing a version tag such as v1.2.3, or run the workflow from GitHub Actions.",
			);
		} catch (error) {
			if (error instanceof ReleaseSetupError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}
	},
});
