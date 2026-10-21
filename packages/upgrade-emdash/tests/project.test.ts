import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	applyDependencyChanges,
	applyDependencyEdits,
	emdashCommand,
	loadProject,
	targetSpecifier,
	writeDependenciesAndInstall,
} from "../src/project.js";
import type { DependencyChange } from "../src/types.js";

describe("project dependency updates", () => {
	it("preserves caret, tilde, and exact version styles", () => {
		expect(targetSpecifier("^1.0.1", "1.2.0")).toBe("^1.2.0");
		expect(targetSpecifier("~1.0.1", "1.2.0")).toBe("~1.2.0");
		expect(targetSpecifier("1.0.1", "1.2.0")).toBe("1.2.0");
		expect(targetSpecifier("workspace:*", "1.2.0")).toBeNull();
	});

	it("replaces preview builds, git sources, and other registry ranges with a caret release", () => {
		for (const specifier of [
			"https://pkg.pr.new/emdash-cms/emdash/@emdash-cms/cloudflare@3285",
			"git+https://github.com/emdash-cms/emdash.git#main",
			"github:emdash-cms/emdash",
			">=1.0.0",
			"1.x",
			"latest",
		]) {
			expect(targetSpecifier(specifier, "1.2.0")).toBe("^1.2.0");
		}
	});

	it("leaves catalog, workspace, local path, and alias specifiers to the project", () => {
		for (const specifier of [
			"catalog:",
			"catalog:emdash",
			"workspace:^",
			"link:../emdash",
			"file:../emdash",
			"portal:../emdash",
			"npm:@example/emdash@^1.0.0",
		]) {
			expect(targetSpecifier(specifier, "1.2.0")).toBeNull();
		}
	});

	it("updates each package in its declared dependency section", () => {
		const packageJson = {
			dependencies: { emdash: "^1.0.1", astro: "^7.0.0" },
			devDependencies: { "@emdash-cms/plugin-cli": "~0.4.0" },
		};
		const changes: DependencyChange[] = [
			{
				name: "emdash",
				section: "dependencies",
				from: "^1.0.1",
				to: "^1.2.0",
				fromVersion: "1.0.1",
				toVersion: "1.2.0",
			},
			{
				name: "@emdash-cms/plugin-cli",
				section: "devDependencies",
				from: "~0.4.0",
				to: "~0.5.0",
				fromVersion: "0.4.0",
				toVersion: "0.5.0",
			},
		];

		expect(applyDependencyChanges(packageJson, changes)).toMatchObject({
			dependencies: { emdash: "^1.2.0", astro: "^7.0.0" },
			devDependencies: { "@emdash-cms/plugin-cli": "~0.5.0" },
		});
		expect(
			applyDependencyEdits(
				'{\n\t"dependencies": { "emdash": "^1.0.1", "astro": "^7.0.0" },\n\t"devDependencies": { "@emdash-cms/plugin-cli": "~0.4.0" }\n}\n',
				changes,
			),
		).toBe(
			'{\n\t"dependencies": { "emdash": "^1.2.0", "astro": "^7.0.0" },\n\t"devDependencies": { "@emdash-cms/plugin-cli": "~0.5.0" }\n}\n',
		);
	});

	it("uses each package manager's project-local EmDash binary", () => {
		expect(emdashCommand("pnpm", "migrate --status")).toBe("pnpm exec emdash migrate --status");
		expect(emdashCommand("npm", "migrate --status")).toBe("npm exec -- emdash migrate --status");
		expect(emdashCommand("yarn", "migrate --status")).toBe("yarn emdash migrate --status");
		expect(emdashCommand("bun", "migrate --status")).toBe("bunx emdash migrate --status");
	});
});

describe("project loading", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function writeJson(path: string, value: unknown): Promise<void> {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
	}

	async function temporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "upgrade-emdash-"));
		directories.push(directory);
		return directory;
	}

	async function writeEmDashPackage(directory: string, emdashVersion: string): Promise<void> {
		const hasMigrations = emdashVersion !== "0.34.0";
		await writeJson(join(directory, "package.json"), {
			name: "emdash",
			version: emdashVersion,
			type: "module",
			exports: {
				".": "./index.mjs",
				...(hasMigrations ? { "./migrations": "./migrations.mjs" } : {}),
			},
		});
		await writeFile(join(directory, "index.mjs"), "export {};\n");
		if (hasMigrations) {
			await writeFile(
				join(directory, "migrations.mjs"),
				'import { readFileSync } from "node:fs";\nconst { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));\nexport async function getCoreMigrationIdentity() { return { emdashVersion: version, names: ["001_initial"] }; }\n',
			);
		}
	}

	async function project(emdashVersion: string, root?: string): Promise<string> {
		root ??= await temporaryDirectory();
		await writeJson(join(root, "package.json"), {
			dependencies: { emdash: `^${emdashVersion}` },
		});
		await writeEmDashPackage(join(root, "node_modules/emdash"), emdashVersion);
		return root;
	}

	it("reads the newly installed EmDash release in the same process", async () => {
		const site = await temporaryDirectory();
		await writeJson(join(site, "package.json"), { dependencies: { emdash: "^1.0.0" } });
		const store = (version: string) =>
			join(site, `node_modules/.pnpm/emdash@${version}/node_modules/emdash`);
		await writeEmDashPackage(store("1.0.0"), "1.0.0");
		await writeEmDashPackage(store("1.1.0"), "1.1.0");
		await symlink(store("1.0.0"), join(site, "node_modules/emdash"));

		await expect(loadProject(site)).resolves.toMatchObject({ currentVersion: "1.0.0" });

		await rm(join(site, "node_modules/emdash"));
		await symlink(store("1.1.0"), join(site, "node_modules/emdash"));

		await expect(loadProject(site)).resolves.toMatchObject({ currentVersion: "1.1.0" });
	});

	it("installs from the workspace root when the site is a workspace package", async () => {
		const workspace = await temporaryDirectory();
		await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - sites/*\n");
		await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		await writeJson(join(workspace, "package.json"), { private: true });
		const site = await project("1.0.0", join(workspace, "sites/blog"));

		await expect(loadProject(site)).resolves.toMatchObject({
			root: site,
			installRoot: workspace,
			packageManager: "pnpm",
		});
	});

	it("ignores a lockfile in an ancestor directory that is not a workspace root", async () => {
		const parent = await temporaryDirectory();
		await writeFile(join(parent, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		const site = await project("1.0.0", join(parent, "blog"));

		await expect(loadProject(site)).resolves.toMatchObject({
			root: site,
			installRoot: site,
			packageManager: "npm",
		});
	});

	it("installs in the site when an ancestor workspace does not include it", async () => {
		const workspace = await temporaryDirectory();
		await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		const standalone = await project("1.0.0", join(workspace, "sites/blog"));
		await writeFile(join(standalone, "package-lock.json"), "{}\n");

		await expect(loadProject(standalone)).resolves.toMatchObject({
			installRoot: standalone,
			packageManager: "npm",
		});
	});

	it("follows workspace exclusions and the object form of package.json workspaces", async () => {
		const pnpmWorkspace = await temporaryDirectory();
		await writeFile(
			join(pnpmWorkspace, "pnpm-workspace.yaml"),
			"packages:\n  - sites/*\n  - '!sites/blog'\n",
		);
		const excluded = await project("1.0.0", join(pnpmWorkspace, "sites/blog"));

		const npmWorkspace = await temporaryDirectory();
		await writeJson(join(npmWorkspace, "package.json"), {
			private: true,
			workspaces: { packages: ["./sites/**"] },
		});
		await writeFile(join(npmWorkspace, "package-lock.json"), "{}\n");
		const member = await project("1.0.0", join(npmWorkspace, "sites/marketing/blog"));

		await expect(loadProject(excluded)).resolves.toMatchObject({ installRoot: excluded });
		await expect(loadProject(member)).resolves.toMatchObject({ installRoot: npmWorkspace });
	});

	it("explains that Yarn Plug'n'Play installs are not supported", async () => {
		const site = await project("1.0.0");
		await writeFile(join(site, "yarn.lock"), "");
		await writeFile(join(site, ".pnp.cjs"), "");

		await expect(loadProject(site)).rejects.toThrow(
			"This project uses Yarn Plug'n'Play, which installs packages without node_modules.",
		);
	});

	it("explains that emdash releases without a migration identity need a manual update first", async () => {
		const root = await project("0.34.0");

		await expect(loadProject(root)).rejects.toThrow(
			"upgrade-emdash requires emdash 0.35.0 or later, but this project has 0.34.0",
		);
	});

	it.skipIf(process.platform === "win32")(
		"updates catalog entries in pnpm-workspace.yaml and restores them when rejected",
		async () => {
			const workspace = await temporaryDirectory();
			const manifest = "packages:\n  - sites/*\ncatalog:\n  emdash: ^1.0.0 # shared\n";
			await writeFile(join(workspace, "pnpm-workspace.yaml"), manifest);
			await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			await writeJson(join(workspace, "package.json"), { private: true });
			const site = await project("1.0.0", join(workspace, "sites/blog"));
			await writeJson(join(site, "package.json"), { dependencies: { emdash: "catalog:" } });
			const sitePackageJson = await readFile(join(site, "package.json"), "utf8");
			const bin = await temporaryDirectory();
			await writeFile(join(bin, "pnpm"), '#!/bin/sh\necho "$*" >> pnpm.log\n');
			await chmod(join(bin, "pnpm"), 0o755);
			const change: DependencyChange = {
				name: "emdash",
				section: "dependencies",
				catalog: "default",
				from: "^1.0.0",
				to: "^1.1.0",
				fromVersion: "1.0.0",
				toVersion: "1.1.0",
			};
			let installedManifest: string | undefined;
			const path = process.env.PATH;
			process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
			try {
				const loaded = await loadProject(site);
				expect(loaded.workspaceManifest?.path).toBe(join(workspace, "pnpm-workspace.yaml"));

				await expect(
					writeDependenciesAndInstall(loaded, [change], async () => {
						installedManifest = await readFile(join(workspace, "pnpm-workspace.yaml"), "utf8");
						throw new Error("emdash resolved to 1.0.0.");
					}),
				).rejects.toThrow("The previous dependencies were restored.");
			} finally {
				process.env.PATH = path;
			}

			expect(installedManifest).toBe(manifest.replace("^1.0.0", "^1.1.0"));
			expect(await readFile(join(workspace, "pnpm-workspace.yaml"), "utf8")).toBe(manifest);
			expect(await readFile(join(site, "package.json"), "utf8")).toBe(sitePackageJson);
			expect(await readFile(join(workspace, "pnpm.log"), "utf8")).toBe("install\ninstall\n");
		},
	);

	async function withFakePackageManager<T>(
		name: string,
		script: string,
		run: () => Promise<T>,
	): Promise<T> {
		const bin = await temporaryDirectory();
		await writeFile(join(bin, name), `#!/bin/sh\n${script}`);
		await chmod(join(bin, name), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
		try {
			return await run();
		} finally {
			process.env.PATH = path;
		}
	}

	const emdashChange: DependencyChange = {
		name: "emdash",
		section: "dependencies",
		from: "^1.0.0",
		to: "^1.1.0",
		fromVersion: "1.0.0",
		toVersion: "1.1.0",
	};

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"leaves package.json unchanged when the catalog manifest cannot be written",
		async () => {
			const workspace = await temporaryDirectory();
			await writeFile(
				join(workspace, "pnpm-workspace.yaml"),
				"packages:\n  - sites/*\ncatalog:\n  emdash: ^1.0.0\n",
			);
			await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			await chmod(join(workspace, "pnpm-workspace.yaml"), 0o444);
			const site = await project("1.0.0", join(workspace, "sites/blog"));
			await writeJson(join(site, "package.json"), {
				dependencies: { emdash: "catalog:", "@emdash-cms/cloudflare": "^1.0.0" },
			});
			await writeEmDashPackage(join(site, "node_modules/@emdash-cms/cloudflare"), "1.0.0");
			const sitePackageJson = await readFile(join(site, "package.json"), "utf8");

			await withFakePackageManager("pnpm", 'echo "$*" >> pnpm.log\n', async () => {
				await expect(
					writeDependenciesAndInstall(
						await loadProject(site),
						[
							{
								...emdashChange,
								name: "@emdash-cms/cloudflare",
							},
							{ ...emdashChange, catalog: "default" },
						],
						async () => undefined,
					),
				).rejects.toThrow(/EACCES/);
			});

			expect(await readFile(join(site, "package.json"), "utf8")).toBe(sitePackageJson);
			await expect(readFile(join(workspace, "pnpm.log"), "utf8")).rejects.toThrow();
		},
	);

	it.skipIf(process.platform === "win32")(
		"reinstalls the previous dependencies when the install fails partway",
		async () => {
			const site = await project("1.0.0");
			await writeFile(join(site, "package-lock.json"), "original lockfile\n");
			const originalPackageJson = await readFile(join(site, "package.json"), "utf8");

			await withFakePackageManager(
				"npm",
				'echo "$*" >> npm.log\nif [ ! -f failed-once ]; then touch failed-once; echo partial > package-lock.json; exit 1; fi\n',
				async () => {
					await expect(
						writeDependenciesAndInstall(
							await loadProject(site),
							[emdashChange],
							async () => undefined,
						),
					).rejects.toThrow(
						"npm failed with exit code 1. The previous dependencies were restored.",
					);
				},
			);

			expect(await readFile(join(site, "package.json"), "utf8")).toBe(originalPackageJson);
			expect(await readFile(join(site, "package-lock.json"), "utf8")).toBe("original lockfile\n");
			expect(await readFile(join(site, "npm.log"), "utf8")).toBe("install\ninstall\n");
		},
	);

	it.skipIf(process.platform === "win32")(
		"restores the previous dependencies when the installed result is rejected",
		async () => {
			const site = await project("1.0.0");
			const lockfile = (specifier: string) => `lock "emdash": "${specifier}"\n`;
			await writeFile(join(site, "package-lock.json"), lockfile("^1.0.0"));
			const bin = await temporaryDirectory();
			await writeFile(
				join(bin, "npm"),
				`#!/bin/sh\necho "$*" >> npm.log\nprintf 'lock %s\\n' "$(grep -o '"emdash": "[^"]*"' package.json)" > package-lock.json\n`,
			);
			await chmod(join(bin, "npm"), 0o755);
			const originalPackageJson = await readFile(join(site, "package.json"), "utf8");
			const path = process.env.PATH;
			process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
			try {
				await expect(
					writeDependenciesAndInstall(
						await loadProject(site),
						[
							{
								name: "emdash",
								section: "dependencies",
								from: "^1.0.0",
								to: "^1.2.0",
								fromVersion: "1.0.0",
								toVersion: "1.2.0",
							},
						],
						async () => {
							throw new Error("emdash resolved to 1.1.0.");
						},
					),
				).rejects.toThrow("emdash resolved to 1.1.0. The previous dependencies were restored.");
			} finally {
				process.env.PATH = path;
			}

			expect(await readFile(join(site, "package.json"), "utf8")).toBe(originalPackageJson);
			expect(await readFile(join(site, "package-lock.json"), "utf8")).toBe(lockfile("^1.0.0"));
			expect(await readFile(join(site, "npm.log"), "utf8")).toBe("install\ninstall\n");
		},
	);
});
