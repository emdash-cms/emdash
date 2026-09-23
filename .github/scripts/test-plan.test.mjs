import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestPlan, formatGitHubOutput, TEST_LANES } from "./test-plan.mjs";

describe("test plan", () => {
	it("does not run test lanes for documentation-only changes", () => {
		const plan = createTestPlan(["docs/src/content/docs/guide.mdx", ".changeset/small-fix.md"]);

		assert.equal(plan.full, false);
		for (const lane of TEST_LANES) assert.equal(plan[lane], false, lane);
	});

	it("selects focused admin UI coverage", () => {
		const plan = createTestPlan(["packages/admin/src/components/Editor.tsx"]);

		assert.equal(plan.unit, false);
		assert.equal(plan.browser, true);
		assert.equal(plan.browser_admin, true);
		assert.equal(plan.browser_release, false);
		assert.equal(plan.e2e_node, true);
		assert.equal(plan.e2e_table, true);
		assert.equal(plan.visual, true);
		assert.equal(plan.e2e_cloudflare, false);
		assert.equal(plan.d1, false);
	});

	it("selects runtime and database boundaries for core changes", () => {
		const plan = createTestPlan(["packages/core/src/database/migrations/020_example.ts"]);

		for (const lane of [
			"unit",
			"smoke",
			"integration",
			"d1",
			"e2e_node",
			"e2e_cloudflare",
			"query_counts",
		]) {
			assert.equal(plan[lane], true, lane);
		}
		assert.equal(plan.e2e_playground, false);
	});

	it("unions lanes from every changed area", () => {
		const plan = createTestPlan([
			"packages/blocks/src/index.ts",
			"apps/release-service/src/index.ts",
			"e2e/playground/tests/editor.spec.ts",
		]);

		assert.equal(plan.unit, true);
		assert.equal(plan.browser, true);
		assert.equal(plan.preview, true);
		assert.equal(plan.browser_admin, false);
		assert.equal(plan.browser_release, true);
		assert.equal(plan.e2e_playground, true);
		assert.equal(plan.e2e_node, false);
	});

	it("runs shared E2E fixture changes against both runtimes", () => {
		const plan = createTestPlan(["e2e/fixtures/admin.ts"]);

		assert.equal(plan.e2e_node, true);
		assert.equal(plan.e2e_cloudflare, true);
		assert.equal(plan.visual, false);
	});

	it("identifies changed package roots for focused unit tests", () => {
		const plan = createTestPlan([
			"packages/marketplace/src/index.ts",
			"apps/aggregator/src/index.ts",
		]);

		assert.equal(plan.unit_mode, "focused");
		assert.deepEqual(plan.unit_packages, ["@emdash-cms/marketplace", "@emdash-cms/aggregator"]);
	});

	it("runs core shards for packages consumed by core", () => {
		for (const path of [
			"packages/auth/src/index.ts",
			"packages/blocks/src/index.ts",
			"packages/plugin-cli/src/index.ts",
			"packages/plugin-types/src/index.ts",
			"packages/registry-moderation/src/index.ts",
			"packages/registry-verification/src/index.ts",
		]) {
			assert.equal(createTestPlan([path]).unit_mode, "full", path);
		}
	});

	it("uses the complete package test set when core requires full unit coverage", () => {
		const plan = createTestPlan(["packages/core/src/index.ts"]);

		assert.equal(plan.unit_mode, "full");
		assert.ok(plan.unit_packages.includes("@emdash-cms/blocks"));
		assert.ok(plan.unit_packages.includes("@emdash-cms/registry-verification"));
		assert.ok(plan.unit_packages.includes("@emdash-cms/plugin-forms"));
		assert.ok(plan.unit_packages.includes("@emdash-cms/release-service"));
	});

	it("marks a union that selects every lane as full", () => {
		const plan = createTestPlan([
			"packages/core/src/index.ts",
			"e2e/playground/media-ready.spec.ts",
		]);

		assert.equal(plan.full, true);
	});

	it("selects packaging coverage for templates", () => {
		const plan = createTestPlan(["templates/blog/src/content.config.ts"]);

		assert.equal(plan.smoke, true);
		assert.equal(plan.integration, true);
		assert.equal(plan.e2e_node, true);
		assert.equal(plan.e2e_cloudflare, true);
		assert.equal(plan.query_counts, true);
		assert.equal(plan.preview, false);
		assert.equal(plan.unit, false);
	});

	it("fails closed for unknown paths", () => {
		const plan = createTestPlan(["future-system/src/index.ts"]);

		assert.equal(plan.full, true);
		assert.deepEqual(plan.unknown_paths, ["future-system/src/index.ts"]);
		for (const lane of TEST_LANES) assert.equal(plan[lane], true, lane);
	});

	it("fails closed for shared root configuration", () => {
		for (const path of [
			"package.json",
			"pnpm-lock.yaml",
			"playwright.config.ts",
			".github/workflows/ci.yml",
		]) {
			const plan = createTestPlan([path]);
			assert.equal(plan.full, true, path);
		}
	});

	it("fails closed when no paths are supplied", () => {
		assert.equal(createTestPlan([]).full, true);
	});

	it("rejects paths that cannot have come from a repository diff", () => {
		for (const path of ["../outside.ts", "/tmp/outside.ts", "packages\\core\\index.ts"]) {
			const plan = createTestPlan([path]);
			assert.equal(plan.full, true, path);
			assert.deepEqual(plan.unknown_paths, [path]);
		}
	});

	it("emits scalar outputs for GitHub Actions", () => {
		const output = formatGitHubOutput(createTestPlan(["packages/admin/src/index.ts"]));

		assert.ok(output.includes("unit=false\n"));
		assert.ok(output.includes("d1=false\n"));
		assert.ok(output.includes("e2e_playground=false\n"));
		assert.ok(output.includes("browser_admin=true\n"));
		assert.ok(output.includes("browser_release=false\n"));
		assert.ok(output.includes("unit_mode=none\n"));
		assert.ok(output.includes("unit_packages=[]\n"));
		assert.ok(output.includes("unknown_paths=[]\n"));
		assert.ok(output.includes('plan={"unit":false,'));
	});

	it("reads changed paths from stdin in the CLI", () => {
		const script = fileURLToPath(new URL("./test-plan.mjs", import.meta.url));
		const output = execFileSync(process.execPath, [script, "--github-output"], {
			input: "packages/admin/src/index.ts\n",
			encoding: "utf8",
		});

		assert.ok(output.includes("browser=true\n"));
		assert.ok(output.includes("e2e_cloudflare=false\n"));
	});
});
