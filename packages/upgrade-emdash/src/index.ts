import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { HELP, parseArgs } from "./args.js";
import { renderUpgradeGuide } from "./guide.js";
import { createUpgradePlan, withTargetMigrations } from "./plan.js";
import { loadProject, run, writeDependenciesAndInstall } from "./project.js";
import type { UpgradePlan } from "./types.js";

async function updaterVersion(): Promise<string> {
	const packageJson: unknown = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	const version =
		typeof packageJson === "object" && packageJson !== null
			? Reflect.get(packageJson, "version")
			: null;
	return typeof version === "string" ? version : "unknown";
}

function printPlan(plan: UpgradePlan): void {
	const lines = [
		`${pc.dim("Project")}         ${plan.projectRoot}`,
		`${pc.dim("npm tag")}         ${plan.tag}`,
		`${pc.dim("Packages")}        ${plan.dependencies.length}`,
		`${pc.dim("Release entries")} ${plan.changelog.length}`,
		`${pc.dim("Migrations")}      calculated after install`,
		`${pc.dim("Work order")}      ${plan.guidePath}`,
	];
	p.note(lines.join("\n"), "Upgrade plan");
	for (const change of plan.dependencies) {
		p.log.info(`${change.name}: ${change.fromVersion} → ${change.toVersion}`);
	}
}

async function applyPlan(plan: UpgradePlan): Promise<UpgradePlan> {
	const project = await loadProject(plan.projectRoot);
	if (plan.dependencies.length > 0) {
		p.log.step("Updating dependencies");
		await writeDependenciesAndInstall(project, plan.dependencies);
	}
	const installedProject = await loadProject(plan.projectRoot);
	for (const change of plan.dependencies) {
		const installed = installedProject.dependencies.find(
			(dependency) => dependency.name === change.name && dependency.section === change.section,
		)?.installedVersion;
		if (installed !== change.toVersion) {
			throw new Error(
				`${change.name} resolved to ${installed ?? "nothing"}, but npm ${plan.tag} resolved to ${change.toVersion}.`,
			);
		}
	}
	const completedPlan = withTargetMigrations(plan, installedProject);
	await mkdir(dirname(completedPlan.guidePath), { recursive: true });
	await writeFile(completedPlan.guidePath, renderUpgradeGuide(completedPlan));
	p.log.step("Refreshing EmDash agent skills");
	await run("npx", ["--yes", "skills", "add", "emdash-cms/skills", "-y"], plan.projectRoot);
	return completedPlan;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.version) {
		process.stdout.write(`upgrade-emdash ${await updaterVersion()}\n`);
		return;
	}

	const project = await loadProject(options.cwd);
	const plan = await createUpgradePlan(project, options.tag);
	if (options.json) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return;
	}

	p.intro(pc.bgCyan(pc.black(" upgrade-emdash ")));
	printPlan(plan);
	if (options.dryRun) {
		p.outro("Dry run complete. No files were changed.");
		return;
	}

	let confirmed = options.yes;
	if (!confirmed && process.stdin.isTTY && process.stdout.isTTY) {
		const answer = await p.confirm({
			message: "Update dependencies, install them, and refresh EmDash agent skills?",
			initialValue: true,
		});
		if (p.isCancel(answer)) {
			p.cancel("Upgrade cancelled.");
			return;
		}
		confirmed = answer === true;
	}
	if (!confirmed) {
		p.cancel("Re-run with --yes to apply this plan in a non-interactive shell.");
		process.exitCode = 1;
		return;
	}

	const completedPlan = await applyPlan(plan);
	const migrationCount = completedPlan.migrations.added?.length ?? 0;
	p.outro(
		`Upgrade prepared with ${migrationCount} added core migration${migrationCount === 1 ? "" : "s"}. Give an agent this work order: ${pc.cyan(completedPlan.guidePath)}`,
	);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	p.log.error(message);
	process.exitCode = 1;
});
