import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareReleaseMedia } from "../src/media.js";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=",
	"base64",
);
const GIF = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");

const options = (workspace: string, pluginDirectory = ".", version = "1.2.3") => ({
	workspace,
	pluginDirectory,
	packageSlug: "gallery",
	version,
});

async function manifest(pluginDirectory: string, body: string) {
	await writeFile(
		join(pluginDirectory, "emdash-plugin.jsonc"),
		`{
		"slug": "gallery",
		${body}
	}`,
	);
}

async function image(pluginDirectory: string, path = "assets/image.png", bytes: Uint8Array = PNG) {
	const file = join(pluginDirectory, path);
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, bytes);
}

describe("prepareReleaseMedia", () => {
	let root: string;
	let workspace: string;
	let pluginDirectory: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "emdash-release-media-"));
		workspace = join(root, "workspace");
		pluginDirectory = join(workspace, "packages", "gallery");
		await mkdir(pluginDirectory, { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("prepares PNG media in declaration order and computes real checksums", async () => {
		await image(pluginDirectory, "assets/icon.png");
		await image(pluginDirectory, "assets/banner.png");
		await image(pluginDirectory, "assets/one.png");
		await image(pluginDirectory, "assets/two.png");
		await manifest(
			pluginDirectory,
			`"version": "1.2.3",
			"release": { "artifacts": {
				"icon": { "file": "./assets/icon.png" },
				"banner": { "file": "assets/banner.png" },
				"screenshots": [
					{ "file": "assets/one.png", "lang": "en" },
					{ "file": "assets/two.png", "lang": "fr" }
				]
			}}`,
		);

		const prepared = await prepareReleaseMedia(options(workspace, "packages/gallery"));
		const checksum = await computeMultihash(PNG);
		expect(checksum.success).toBe(true);
		if (!checksum.success) throw new Error(checksum.error.message);
		expect(prepared.icon).toMatchObject({
			contentType: "image/png",
			width: 1,
			height: 1,
			checksum: checksum.value,
		});
		expect(prepared.banner).toMatchObject({ contentType: "image/png", width: 1, height: 1 });
		expect(prepared.screenshots).toMatchObject([
			{ contentType: "image/png", lang: "en" },
			{ contentType: "image/png", lang: "fr" },
		]);
	});

	it.each([
		["without a manifest", async () => {}],
		["without artifacts", async () => manifest(pluginDirectory, `"version": "1.2.3"`)],
	])("returns an empty result %s", async (_name, setup) => {
		await setup();
		expect(await prepareReleaseMedia(options(workspace, "packages/gallery"))).toEqual({});
	});

	it("accepts a nested plugin and an omitted manifest version", async () => {
		await image(pluginDirectory);
		await manifest(
			pluginDirectory,
			`"release": { "artifacts": { "icon": { "file": "assets/image.png" } } }`,
		);
		expect((await prepareReleaseMedia(options(workspace, "packages/gallery"))).icon).toBeDefined();
	});

	it.each([
		["mismatched slug", `"slug": "other", "release": { "artifacts": {} }`, "Manifest slug"],
		[
			"mismatched version",
			`"version": "9.9.9", "release": { "artifacts": {} }`,
			"Manifest version",
		],
		["invalid JSONC", `"release": {`, "invalid JSONC"],
		[
			"invalid artifact reference",
			`"release": { "artifacts": { "icon": "assets/image.png" } }`,
			"must be an object",
		],
		[
			"unsupported artifact key",
			`"release": { "artifacts": { "video": { "file": "x" } } }`,
			"unsupported key",
		],
		[
			"too many screenshots",
			`"release": { "artifacts": { "screenshots": ${JSON.stringify(Array.from({ length: 9 }, () => ({ file: "x" })))} } }`,
			"1 to 8",
		],
	] as const)("rejects %s", async (_name, body, message) => {
		await manifest(pluginDirectory, body);
		await expect(prepareReleaseMedia(options(workspace, "packages/gallery"))).rejects.toThrow(
			message,
		);
	});

	it.each([
		["missing", "assets/missing.png", PNG, "could not be read"],
		["empty", "assets/image.png", Buffer.alloc(0), "missing, not a file"],
		[
			"too large",
			"assets/image.png",
			Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]),
			"missing, not a file",
		],
		["GIF", "assets/image.png", GIF, "supported image"],
		["too wide", "assets/image.png", dimensionPng(8193, 1), "supported image"],
	] as const)("rejects %s images", async (_name, path, bytes, message) => {
		if (_name !== "missing") await image(pluginDirectory, path, bytes);
		await manifest(
			pluginDirectory,
			`"release": { "artifacts": { "icon": { "file": "${path}" } } }`,
		);
		await expect(prepareReleaseMedia(options(workspace, "packages/gallery"))).rejects.toThrow(
			message,
		);
	});

	it.each([
		["absolute", "outside.png"],
		["parent", "../outside.png"],
	])("rejects %s image paths", async (_name, relativePath) => {
		const path = _name === "absolute" ? join(root, relativePath) : relativePath;
		await manifest(
			pluginDirectory,
			`"release": { "artifacts": { "icon": { "file": ${JSON.stringify(path)} } } }`,
		);
		await expect(prepareReleaseMedia(options(workspace, "packages/gallery"))).rejects.toThrow(
			"path is invalid",
		);
	});

	it("rejects image, manifest, and plugin-directory symlink escapes", async () => {
		const outside = join(root, "outside");
		await mkdir(outside, { recursive: true });
		await image(pluginDirectory, "assets/image.png");
		await rm(join(pluginDirectory, "assets/image.png"));
		await writeFile(join(outside, "image.png"), PNG);
		await symlink(join(outside, "image.png"), join(pluginDirectory, "assets/image.png"));
		await manifest(
			pluginDirectory,
			`"release": { "artifacts": { "icon": { "file": "assets/image.png" } } }`,
		);
		await expect(prepareReleaseMedia(options(workspace, "packages/gallery"))).rejects.toThrow(
			"outside",
		);

		await rm(join(pluginDirectory, "emdash-plugin.jsonc"));
		await writeFile(join(outside, "emdash-plugin.jsonc"), `{"slug":"gallery"}`);
		await symlink(
			join(outside, "emdash-plugin.jsonc"),
			join(pluginDirectory, "emdash-plugin.jsonc"),
		);
		await expect(prepareReleaseMedia(options(workspace, "packages/gallery"))).rejects.toThrow(
			"Manifest",
		);

		const linkedPlugin = join(workspace, "linked-gallery");
		await symlink(outside, linkedPlugin);
		await expect(prepareReleaseMedia(options(workspace, "linked-gallery"))).rejects.toThrow(
			"outside the workspace",
		);
	});
});

function dimensionPng(width: number, height: number): Buffer {
	const bytes = Buffer.from(PNG);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}
