import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
	hasUserDefinedPublicRoute,
	injectCoreRoutes,
} from "../../../src/astro/integration/routes.js";
import { GET as getMediaFile } from "../../../src/astro/routes/api/media/file/[...key].js";

function mockMediaContext(key: string | undefined) {
	const download = vi.fn().mockResolvedValue({
		body: new Uint8Array([1, 2, 3]),
		contentType: "image/png",
		size: 3,
	});

	return {
		context: {
			params: { key },
			locals: {
				emdash: {
					storage: { download },
				},
			},
		} as Parameters<typeof getMediaFile>[0],
		download,
	};
}

describe("core media route injection", () => {
	async function withTempSrcDir(files: Record<string, string>, fn: (srcDir: URL) => void) {
		const root = await mkdtemp(join(tmpdir(), "emdash-routes-"));
		try {
			const srcDir = join(root, "src");
			for (const [filePath, contents] of Object.entries(files)) {
				const fullPath = join(srcDir, filePath);
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, contents);
			}
			fn(pathToFileURL(srcDir));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	function collectRoutePatterns(srcDir?: URL): string[] {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route), { srcDir });
		return routes.map((route) => route.pattern);
	}

	it("uses a catch-all media file route so storage keys can contain slashes", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => {
			routes.push({
				...route,
				entrypoint: route.entrypoint.replaceAll("\\", "/"),
			});
		});

		expect(routes).toContainEqual(
			expect.objectContaining({
				pattern: "/_emdash/api/media/file/[...key]",
				// Route entrypoints resolve to the compiled artifact; `[`/`]` are
				// rewritten to `_` (routeArtifactName) so rolldown's reserved
				// output placeholders can't mangle dynamic-route filenames.
				entrypoint: expect.stringContaining("api/media/file/_...key_"),
			}),
		);
	});

	it("injects default root SEO routes when the site does not define them", () => {
		const routes = collectRoutePatterns();

		expect(routes).toContain("/robots.txt");
		expect(routes).toContain("/sitemap.xml");
		expect(routes).toContain("/sitemap-[collection].xml");
	});

	it("skips root SEO routes that are defined by the site", async () => {
		await withTempSrcDir(
			{
				"pages/robots.txt.ts": "export const GET = () => new Response('');",
				"pages/sitemap.xml.ts": "export const GET = () => new Response('');",
			},
			(srcDir) => {
				const routes = collectRoutePatterns(srcDir);

				expect(routes).not.toContain("/robots.txt");
				expect(routes).not.toContain("/sitemap.xml");
				expect(routes).toContain("/sitemap-[collection].xml");
			},
		);
	});

	it("detects index route files for root public route overrides", async () => {
		await withTempSrcDir(
			{
				"pages/robots.txt/index.ts": "export const GET = () => new Response('');",
			},
			(srcDir) => {
				const routes = collectRoutePatterns(srcDir);

				expect(hasUserDefinedPublicRoute(srcDir, "robots.txt")).toBe(true);
				expect(hasUserDefinedPublicRoute(srcDir, "sitemap.xml")).toBe(false);
				expect(routes).not.toContain("/robots.txt");
				expect(routes).toContain("/sitemap.xml");
			},
		);
	});
});

describe("media file catch-all route", () => {
	it("passes slash-containing keys through to storage.download", async () => {
		const { context, download } = mockMediaContext("nested/path/file.png");

		const response = await getMediaFile(context);
		expect(response.status).toBe(200);
		expect(download).toHaveBeenCalledWith("nested/path/file.png");
	});

	it("returns not found when the catch-all key is missing", async () => {
		const { context, download } = mockMediaContext(undefined);

		const response = await getMediaFile(context);
		expect(response.status).toBe(404);
		expect(download).not.toHaveBeenCalled();
	});
});
