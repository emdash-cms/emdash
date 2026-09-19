import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlugin } from "../src/build/api.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("plugin build metadata round trip", () => {
	it("carries hook, route, MCP, settings, and field-widget metadata into npm artifacts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "emdash-plugin-metadata-"));
		temporaryDirectories.push(dir);
		await mkdir(join(dir, "src"));
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "@example/calendar", version: "1.0.0", type: "module" }),
		);
		await writeFile(
			join(dir, "emdash-plugin.jsonc"),
			JSON.stringify({
				slug: "calendar",
				publisher: "did:plc:example",
				license: "MIT",
				author: { name: "Example" },
				security: { email: "security@example.com" },
				capabilities: ["content:read"],
				admin: {
					editorPanels: [
						{ id: "health", title: "Health", route: "entry-health", collections: ["events"] },
					],
					editorActions: [
						{
							id: "repair",
							label: "Repair",
							route: "entry-repair",
							placement: "overflow",
						},
					],
					settingsSchema: {
						enabled: { type: "boolean", label: "Enabled", default: true },
					},
					fieldWidgets: [
						{
							name: "event-picker",
							label: "Event",
							fieldTypes: ["string"],
							elements: [{ type: "input", action_id: "event" }],
						},
					],
				},
			}),
		);
		await writeFile(
			join(dir, "src/plugin.ts"),
			`export default {
				hooks: { "content:afterSave": async () => undefined },
					routes: {
						feed: { public: true, cacheControl: "public, max-age=60", handler: async () => [] },
						manage: { permission: "content:edit_any", handler: async () => ({ ok: true }) },
						"entry-health": { permission: "content:edit_own", handler: async () => ({ blocks: [] }) },
						"entry-repair": { permission: "content:edit_own", handler: async () => ({ refresh: true }) }
				},
				mcp: { tools: { manageCalendar: {
					description: "Manage the calendar.", route: "manage",
					input: { type: "object" }, destructive: true
				} } }
			};`,
		);

		const result = await buildPlugin({ dir });
		const descriptorModule = await import(
			`${pathToFileURL(result.files.descriptor!).href}?test=${Date.now()}`
		);
		const descriptor = descriptorModule.default as Record<string, unknown>;
		const persistedManifest = JSON.parse(
			await readFile(result.files.manifestJson, "utf8"),
		) as Record<string, any>;

		expect(persistedManifest.routes).toContainEqual({
			name: "feed",
			public: true,
			cacheControl: "public, max-age=60",
		});
		expect(persistedManifest.mcp.tools[0]).toMatchObject({
			name: "manageCalendar",
			permission: "content:edit_any",
		});
		expect(persistedManifest.admin.fieldWidgets[0].name).toBe("event-picker");
		expect(persistedManifest.admin.editorPanels[0]).toMatchObject({
			id: "health",
			route: "entry-health",
		});
		expect(persistedManifest.admin.editorActions[0]).toMatchObject({
			id: "repair",
			route: "entry-repair",
		});
		expect(descriptor).toMatchObject({
			hooks: ["content:afterSave"],
			routes: persistedManifest.routes,
			mcp: persistedManifest.mcp,
			settingsSchema: persistedManifest.admin.settingsSchema,
			fieldWidgets: persistedManifest.admin.fieldWidgets,
			editorPanels: persistedManifest.admin.editorPanels,
			editorActions: persistedManifest.admin.editorActions,
		});
	});
});
