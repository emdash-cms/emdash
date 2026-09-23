#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

export const TEST_LANES = [
	"unit",
	"smoke",
	"integration",
	"d1",
	"browser",
	"e2e_node",
	"e2e_cloudflare",
	"e2e_table",
	"e2e_playground",
	"query_counts",
	"visual",
	"preview",
];

const BROWSER_SUITES = ["browser_admin", "browser_release"];
const REPOSITORY_METADATA_PATTERN =
	/^\.github\/(?:dependabot\.yml|bonk-models\.json|codeql-config\.yml|zizmor\.yml)$/;
const UNIT_PACKAGE_PATH_PATTERN =
	/^packages\/(?:blocks|gutenberg-to-portable-text|plugin-(?:cli|types)|registry-(?:client|lexicons|moderation|verification))\//;
const TABLE_E2E_PATH_PATTERN = /^e2e\/tests\/.*(?:table|data-grid).*\.(?:spec|test)\.[cm]?[jt]sx?$/;
const LINE_BREAK_PATTERN = /\r?\n/;

const UNIT_PACKAGE_BY_PATH = new Map([
	["packages/auth/", "@emdash-cms/auth"],
	["packages/blocks/", "@emdash-cms/blocks"],
	["packages/gutenberg-to-portable-text/", "@emdash-cms/gutenberg-to-portable-text"],
	["packages/marketplace/", "@emdash-cms/marketplace"],
	["packages/plugin-cli/", "@emdash-cms/plugin-cli"],
	["packages/plugin-types/", "@emdash-cms/plugin-types"],
	["packages/plugins/forms/", "@emdash-cms/plugin-forms"],
	["packages/registry-client/", "@emdash-cms/registry-client"],
	["packages/registry-lexicons/", "@emdash-cms/registry-lexicons"],
	["packages/registry-moderation/", "@emdash-cms/registry-moderation"],
	["packages/registry-verification/", "@emdash-cms/registry-verification"],
	["apps/aggregator/", "@emdash-cms/aggregator"],
	["apps/labeler/", "@emdash-cms/labeler"],
	["apps/release-action/", "@emdash-cms/release-action"],
	["apps/release-service/", "@emdash-cms/release-service"],
	["apps/release-verifier/", "@emdash-cms/release-verifier"],
]);

const ALL_UNIT_PACKAGES = [...UNIT_PACKAGE_BY_PATH.values()];

// These packages feed the core Vitest suite. Selecting only their own package
// tests would miss regressions in their core consumers.
const CORE_UNIT_DEPENDENCIES = [
	"packages/auth/",
	"packages/blocks/",
	"packages/gutenberg-to-portable-text/",
	"packages/plugin-cli/",
	"packages/plugin-types/",
	"packages/registry-client/",
	"packages/registry-lexicons/",
	"packages/registry-moderation/",
	"packages/registry-verification/",
];

// These rules deliberately describe broad product boundaries instead of every
// test file. A new path cannot silently miss coverage: anything not matched
// below gets the full plan.
const RULES = [
	{
		name: "repository metadata",
		matches: (path) =>
			path === ".gitignore" ||
			path === ".prettierignore" ||
			path.startsWith(".vscode/") ||
			path.startsWith(".opencode/") ||
			REPOSITORY_METADATA_PATTERN.test(path),
		lanes: [],
	},
	{
		name: "documentation or repository metadata",
		matches: (path) =>
			path.endsWith(".md") ||
			path.startsWith("docs/") ||
			path.startsWith("skills/") ||
			path.startsWith(".changeset/") ||
			path.startsWith(".github/ISSUE_TEMPLATE/"),
		lanes: [],
	},
	{
		name: "admin UI",
		matches: (path) => path.startsWith("packages/admin/") || path.startsWith("i18n/"),
		lanes: ["browser", "browser_admin", "e2e_node", "e2e_table", "visual", "preview"],
	},
	{
		name: "core runtime or database",
		matches: (path) =>
			path.startsWith("packages/core/") ||
			path.startsWith("packages/cloudflare/") ||
			path.startsWith("packages/workerd/"),
		lanes: [
			"unit",
			"smoke",
			"integration",
			"d1",
			"browser",
			"browser_admin",
			"browser_release",
			"e2e_node",
			"e2e_cloudflare",
			"e2e_table",
			"query_counts",
			"visual",
			"preview",
		],
		unitMode: "full",
	},
	{
		name: "authentication",
		matches: (path) => path.startsWith("packages/auth/"),
		lanes: ["unit", "integration", "e2e_node", "e2e_cloudflare", "preview"],
	},
	{
		name: "private package with unit coverage",
		matches: (path) => path.startsWith("packages/marketplace/"),
		lanes: ["unit"],
	},
	{
		name: "package with unit coverage",
		matches: (path) => UNIT_PACKAGE_PATH_PATTERN.test(path),
		lanes: ["unit", "preview"],
	},
	{
		name: "service with unit coverage",
		matches: (path) => path.startsWith("apps/aggregator/") || path.startsWith("apps/labeler/"),
		lanes: ["unit"],
	},
	{
		name: "forms plugin",
		matches: (path) => path.startsWith("packages/plugins/forms/"),
		lanes: ["unit", "preview"],
	},
	{
		name: "plugin fixtures",
		matches: (path) => path.startsWith("packages/plugins/"),
		lanes: ["unit", "integration"],
		unitMode: "full",
	},
	{
		name: "package creation",
		matches: (path) => path.startsWith("packages/create-emdash/"),
		lanes: ["smoke", "integration", "e2e_node", "e2e_cloudflare", "query_counts", "preview"],
	},
	{
		name: "project templates",
		matches: (path) => path.startsWith("templates/") || path.startsWith("assets/templates/"),
		lanes: ["smoke", "integration", "e2e_node", "e2e_cloudflare", "query_counts"],
	},
	{
		name: "release service",
		matches: (path) => path.startsWith("apps/release-service/"),
		lanes: ["unit", "browser", "browser_release"],
	},
	{
		name: "release application",
		matches: (path) =>
			path.startsWith("apps/release-action/") || path.startsWith("apps/release-verifier/"),
		lanes: ["unit"],
	},
	{
		name: "Playground",
		matches: (path) => path.startsWith("demos/playground/") || path.startsWith("e2e/playground/"),
		lanes: ["e2e_playground"],
	},
	{
		name: "Cloudflare E2E fixture",
		matches: (path) => path.startsWith("e2e/fixture-cloudflare/"),
		lanes: ["d1", "e2e_cloudflare", "query_counts"],
	},
	{
		name: "table E2E coverage",
		matches: (path) => path === "playwright.table.config.ts" || TABLE_E2E_PATH_PATTERN.test(path),
		lanes: ["e2e_table"],
	},
	{
		name: "visual regression coverage",
		matches: (path) => path.includes("visual-regression"),
		lanes: ["e2e_node", "visual"],
	},
	{
		name: "general E2E coverage",
		matches: (path) => path.startsWith("e2e/"),
		lanes: ["e2e_node", "e2e_cloudflare"],
	},
	{
		name: "query-count tooling and snapshots",
		matches: (path) =>
			path.startsWith("scripts/query-counts") || path.startsWith("scripts/query-dumps/"),
		lanes: ["query_counts"],
	},
	{
		name: "non-Playground demos",
		matches: (path) => path.startsWith("demos/"),
		lanes: ["smoke", "integration", "e2e_node", "e2e_cloudflare"],
	},
];

const FULL_PLAN_PATHS = [
	/^package\.json$/,
	/^pnpm-lock\.yaml$/,
	/^pnpm-workspace\.yaml$/,
	/^tsconfig(?:\..+)?\.json$/,
	/^vitest(?:\..+)?\.config\.[cm]?[jt]s$/,
	/^playwright\.config\.[cm]?[jt]s$/,
	/^\.github\/scripts\/test-plan(?:\.test)?\.mjs$/,
	/^\.github\/workflows\//,
	/^patches\//,
];

function cleanPaths(paths) {
	return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function isUnsafePath(path) {
	return (
		path.includes("\0") ||
		path.includes("\r") ||
		path.includes("\n") ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").includes("..")
	);
}

function createFullPlan(paths, reason, unknownPaths = []) {
	return {
		...Object.fromEntries(TEST_LANES.map((lane) => [lane, true])),
		...Object.fromEntries(BROWSER_SUITES.map((suite) => [suite, true])),
		unit_mode: "full",
		unit_packages: ALL_UNIT_PACKAGES,
		full: true,
		reason,
		paths,
		unknown_paths: unknownPaths,
	};
}

export function createTestPlan(inputPaths) {
	const paths = cleanPaths(inputPaths);
	if (paths.length === 0) {
		return createFullPlan(paths, "No changed paths were supplied; running the full plan.");
	}

	const unsafePaths = paths.filter(isUnsafePath);
	if (unsafePaths.length > 0) {
		return createFullPlan(
			paths,
			"Unsafe changed paths were supplied; running the full plan.",
			unsafePaths,
		);
	}

	const rootSensitivePaths = paths.filter((path) =>
		FULL_PLAN_PATHS.some((pattern) => pattern.test(path)),
	);
	if (rootSensitivePaths.length > 0) {
		return createFullPlan(
			paths,
			`Shared configuration changed (${rootSensitivePaths.join(", ")}); running the full plan.`,
		);
	}

	const selected = new Set();
	const categories = new Set();
	const unitPackages = new Set();
	let unitMode = "none";
	const unknownPaths = [];
	for (const path of paths) {
		const rule = RULES.find((candidate) => candidate.matches(path));
		if (!rule) {
			unknownPaths.push(path);
			continue;
		}

		categories.add(rule.name);
		for (const lane of rule.lanes) selected.add(lane);
		if (rule.unitMode === "full") unitMode = "full";
		if (CORE_UNIT_DEPENDENCIES.some((prefix) => path.startsWith(prefix))) unitMode = "full";
		for (const [prefix, packageName] of UNIT_PACKAGE_BY_PATH) {
			if (path.startsWith(prefix)) unitPackages.add(packageName);
		}
	}

	if (unknownPaths.length > 0) {
		return createFullPlan(
			paths,
			`Unclassified paths changed (${unknownPaths.join(", ")}); running the full plan.`,
			unknownPaths,
		);
	}

	const laneValues = Object.fromEntries(TEST_LANES.map((lane) => [lane, selected.has(lane)]));
	const browserValues = Object.fromEntries(
		BROWSER_SUITES.map((suite) => [suite, selected.has(suite)]),
	);
	if (laneValues.unit && unitMode !== "full") unitMode = "focused";
	return {
		...laneValues,
		...browserValues,
		unit_mode: unitMode,
		unit_packages: unitMode === "full" ? ALL_UNIT_PACKAGES : [...unitPackages],
		full: TEST_LANES.every((lane) => selected.has(lane)),
		reason: `Matched ${[...categories].join(", ")}.`,
		paths,
		unknown_paths: [],
	};
}

export function formatGitHubOutput(plan) {
	const lines = [];
	for (const lane of [...TEST_LANES, ...BROWSER_SUITES, "full"]) {
		lines.push(`${lane}=${String(plan[lane])}`);
	}
	lines.push(`reason=${plan.reason}`);
	lines.push(`unit_mode=${plan.unit_mode}`);
	lines.push(`unit_packages=${JSON.stringify(plan.unit_packages)}`);
	lines.push(`unknown_paths=${JSON.stringify(plan.unknown_paths)}`);
	lines.push(`plan=${JSON.stringify(plan)}`);
	return `${lines.join("\n")}\n`;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		process.stdout.write(
			"Usage: test-plan.mjs [--github-output] [path ...]\n\nReads newline-delimited paths from stdin when no paths are passed.\n",
		);
		return;
	}

	const githubOutput = args.includes("--github-output");
	const paths = args.filter((arg) => arg !== "--github-output");
	let input = paths;
	if (input.length === 0) {
		let stdin = "";
		for await (const chunk of process.stdin) stdin += chunk;
		input = stdin.split(LINE_BREAK_PATTERN);
	}
	const plan = createTestPlan(input);
	process.stdout.write(
		githubOutput ? formatGitHubOutput(plan) : `${JSON.stringify(plan, null, 2)}\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
