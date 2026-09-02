import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_RELEASE_ACTION_REF,
	DEFAULT_RELEASE_SERVICE_URL,
	setupReleaseWorkflow,
} from "../src/release-setup.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/minimal-plugin", import.meta.url));
const PUBLISHER_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";

describe("setupReleaseWorkflow", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-release-setup-"));
		await cp(FIXTURE, dir, { recursive: true });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a permanent tag and manual release workflow with provenance", async () => {
		const resolvePublisherDid = vi.fn(async () => PUBLISHER_DID);

		const result = await setupReleaseWorkflow({ dir, resolvePublisherDid });
		const workflow = await readFile(result.path, "utf8");

		expect(resolvePublisherDid).toHaveBeenCalledWith("fixture.example.com");
		expect(result.publisherDid).toBe(PUBLISHER_DID);
		expect(workflow).toContain('name: "Publish EmDash plugin"');
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain('tags:\n      - "v*"');
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("attestations: write");
		expect(workflow).toContain("if: ${{ github.event.repository.visibility != 'public' }}");
		expect(workflow).toContain(
			"EmDash releases currently require a public GitHub repository because private and internal repository attestations cannot yet be verified.",
		);
		expect(workflow).toContain(
			"uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
		);
		expect(workflow).toContain(
			"uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4",
		);
		expect(workflow).toContain(
			"uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
		);
		expect(workflow).toContain("id: bundle\n        shell: bash\n        run: |");
		expect(workflow).toContain("pnpm exec emdash-plugin bundle --dir . --out-dir .emdash-release");
		expect(workflow).toContain("shopt -s nullglob");
		expect(workflow).toContain("bundles=(.emdash-release/*.tar.gz)");
		expect(workflow).toContain("if (( ${#bundles[@]} != 1 )); then");
		expect(workflow).toContain(`printf 'path=%s\\n' "\${bundles[0]}" >> "\${GITHUB_OUTPUT}"`);
		expect(workflow).toContain(
			"uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3",
		);
		expect(workflow).toContain("subject-path: ${{ steps.bundle.outputs.path }}");
		expect(workflow).toContain(
			`uses: emdash-cms/emdash/apps/release-action@${DEFAULT_RELEASE_ACTION_REF}`,
		);
		expect(workflow).toContain(`service-url: ${DEFAULT_RELEASE_SERVICE_URL}`);
		expect(workflow).toContain(`publisher-did: ${PUBLISHER_DID}`);
		expect(workflow).toContain(
			"connection-invitation: ${{ secrets.EMDASH_CONNECTION_INVITATION }}",
		);
		expect(workflow).toContain("bundle-file: ${{ steps.bundle.outputs.path }}");
		expect(workflow).toContain("provenance-file: ${{ steps.attest.outputs.bundle-path }}");
		expect(workflow).not.toMatch(/git push|gh pr|gh repo/i);
	});

	it("pins a manifest DID without doing a handle lookup", async () => {
		await writeFile(
			join(dir, "emdash-plugin.jsonc"),
			`{
	"slug": "fixture-minimal",
	"publisher": "${PUBLISHER_DID}",
	"license": "MIT",
	"author": { "name": "Test Author" },
	"security": { "email": "security@example.com" },
	"capabilities": ["content:read"],
	"allowedHosts": ["api.example.com"]
}\n`,
			"utf8",
		);
		const resolvePublisherDid = vi.fn(async () => {
			throw new Error("DID must not be resolved as a handle");
		});

		const result = await setupReleaseWorkflow({ dir, resolvePublisherDid });

		expect(result.publisherDid).toBe(PUBLISHER_DID);
		expect(resolvePublisherDid).not.toHaveBeenCalled();
	});

	it("reports a handle that cannot be resolved without writing a workflow", async () => {
		await expect(
			setupReleaseWorkflow({
				dir,
				resolvePublisherDid: async () => {
					throw new Error("DNS lookup failed");
				},
			}),
		).rejects.toMatchObject({
			name: "ReleaseSetupError",
			code: "PUBLISHER_UNRESOLVED",
			message: expect.stringContaining("fixture.example.com"),
		});
		await expect(readFile(join(dir, ".github/workflows/emdash-release.yml"))).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		);
	});

	it("supports an alternate service origin and Action ref", async () => {
		const result = await setupReleaseWorkflow({
			dir,
			serviceUrl: "https://release.example.com",
			actionRef: "releases/v1",
			resolvePublisherDid: async () => PUBLISHER_DID,
		});
		const workflow = await readFile(result.path, "utf8");

		expect(workflow).toContain("service-url: https://release.example.com");
		expect(workflow).toContain("uses: emdash-cms/emdash/apps/release-action@releases/v1");
	});

	it("refuses to overwrite an existing workflow", async () => {
		const first = await setupReleaseWorkflow({
			dir,
			resolvePublisherDid: async () => PUBLISHER_DID,
		});
		await writeFile(first.path, "keep me\n", "utf8");

		await expect(
			setupReleaseWorkflow({ dir, resolvePublisherDid: async () => PUBLISHER_DID }),
		).rejects.toMatchObject({
			name: "ReleaseSetupError",
			code: "WORKFLOW_EXISTS",
		});
		expect(await readFile(first.path, "utf8")).toBe("keep me\n");
	});

	it("overwrites the workflow only with force", async () => {
		const first = await setupReleaseWorkflow({
			dir,
			resolvePublisherDid: async () => PUBLISHER_DID,
		});
		await writeFile(first.path, "old workflow\n", "utf8");

		await setupReleaseWorkflow({
			dir,
			force: true,
			resolvePublisherDid: async () => PUBLISHER_DID,
		});

		expect(await readFile(first.path, "utf8")).toContain('name: "Publish EmDash plugin"');
	});

	it("rejects a manifest without a publisher", async () => {
		const manifestPath = join(dir, "emdash-plugin.jsonc");
		const manifest = await readFile(manifestPath, "utf8");
		await writeFile(manifestPath, manifest.replace(/\s*"publisher":.*\n/, "\n"), "utf8");

		await expect(setupReleaseWorkflow({ dir })).rejects.toMatchObject({
			name: "BuildPipelineError",
			code: "MANIFEST_INVALID",
		});
	});

	it("rejects unsafe Action refs before writing a workflow", async () => {
		await expect(
			setupReleaseWorkflow({
				dir,
				actionRef: "main\npermissions: write-all",
				resolvePublisherDid: async () => PUBLISHER_DID,
			}),
		).rejects.toMatchObject({ code: "INVALID_ACTION_REF" });
	});
});
