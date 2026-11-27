import { createHash } from "node:crypto";

import type { AstroIntegration } from "astro";
import { mergeConfig } from "astro/config";
import { describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import { renderToolbarBootstrap } from "../../../../src/visual-editing/toolbar-bootstrap.js";
import { renderToolbar } from "../../../../src/visual-editing/toolbar.js";
import { GERMAN_TOOLBAR_LABELS } from "../../../utils/toolbar-labels.js";

const root = new URL("file:///tmp/emdash-toolbar-csp/");

function hook(integration: AstroIntegration) {
	const setup = integration.hooks["astro:config:setup"];
	if (typeof setup !== "function") throw new Error("Missing astro:config:setup hook");
	return setup;
}

async function finalSecurity(
	security: Record<string, unknown>,
	options: Parameters<typeof emdash>[0] = {},
) {
	const updateConfig = vi.fn();
	const initialConfig = {
		root,
		srcDir: new URL("src/", root),
		security,
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
	};
	await hook(emdash(options))({
		command: "build",
		config: initialConfig,
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);

	const updates = updateConfig.mock.calls.map(([update]) => update).filter(Boolean);
	return mergeConfig(
		initialConfig,
		updates.reduce((merged, update) => mergeConfig(merged, update), {}),
	);
}

function cspHash(source: string) {
	return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

function inline(source: string, tag: "script" | "style") {
	const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	if (!match?.[1]) throw new Error(`Missing inline ${tag}`);
	return match[1];
}

describe("toolbar CSP integration", () => {
	it("adds hashes for the actual server toolbar assets", async () => {
		const config = await finalSecurity({ csp: true });
		const csp = config.security.csp as {
			scriptDirective: { hashes: string[] };
			styleDirective: { hashes: string[] };
		};
		const outputs = [
			renderToolbar({
				editMode: true,
				isPreview: false,
				actionToken: "token-one",
				labels: GERMAN_TOOLBAR_LABELS,
			}),
			renderToolbar({
				editMode: false,
				isPreview: true,
				actionToken: "token-two",
				labels: { ...GERMAN_TOOLBAR_LABELS, publish: "Veröffentlichen (FR)" },
			}),
		];

		for (const output of outputs) {
			expect(csp.scriptDirective.hashes).toContain(cspHash(inline(output, "script")));
			expect(csp.styleDirective.hashes).toContain(cspHash(inline(output, "style")));
		}
		expect(csp.scriptDirective.hashes).toHaveLength(1);
		expect(csp.styleDirective.hashes).toHaveLength(1);
	});

	it("preserves host CSP settings and adds the client bootstrap hash", async () => {
		const initialCsp = {
			algorithm: "SHA-512",
			directives: ["default-src 'self'", "object-src 'none'"],
			scriptDirective: {
				hashes: ["sha512-host-hash", { hash: "sha256-attribute-hash", kind: "attribute" }],
				resources: [{ resource: "https://scripts.example.test", kind: "element" }],
				strictDynamic: true,
			},
			styleDirective: {
				hashes: [{ hash: "sha512-style-hash", kind: "element" }],
				resources: ["https://styles.example.test", { resource: "'none'", kind: "attribute" }],
			},
		};
		const config = await finalSecurity({ csp: initialCsp }, { toolbar: "client" });
		const csp = config.security.csp;
		const toolbar = renderToolbar({
			editMode: true,
			isPreview: false,
			actionToken: "token",
			labels: GERMAN_TOOLBAR_LABELS,
		});
		const bootstrap = renderToolbarBootstrap();

		expect(csp).toEqual({
			...initialCsp,
			scriptDirective: {
				...initialCsp.scriptDirective,
				hashes: [
					...initialCsp.scriptDirective.hashes,
					cspHash(inline(toolbar, "script")),
					cspHash(inline(bootstrap, "script")),
				],
			},
			styleDirective: {
				...initialCsp.styleDirective,
				hashes: [...initialCsp.styleDirective.hashes, cspHash(inline(toolbar, "style"))],
			},
		});
	});

	it.each([
		["absent", {}],
		["disabled", { csp: false }],
	])("does not enable CSP when it is %s", async (_name, security) => {
		const config = await finalSecurity(security);
		expect(config.security.csp).toBe(security.csp);
	});

	it("does not add toolbar hashes when the toolbar is disabled", async () => {
		const config = await finalSecurity({ csp: true }, { toolbar: false });
		expect(config.security.csp).toBe(true);
		expect(config.security.csp).not.toHaveProperty("scriptDirective");
	});
});
