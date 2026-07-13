import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { unpackTar } from "modern-tar/fs";

const packageManagerEntrypoint = process.env.npm_execpath;
if (!packageManagerEntrypoint) {
	throw new Error("Cannot run pnpm pack because npm_execpath is unavailable");
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "registry-verification-pack-"));

try {
	const output = execFileSync(
		process.execPath,
		[packageManagerEntrypoint, "pack", "--pack-destination", temporaryDirectory, "--json"],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
	);
	const { filename } = JSON.parse(output);
	if (typeof filename !== "string") throw new Error("pnpm pack did not return a tarball filename");

	const extracted = join(temporaryDirectory, "extracted");
	await pipeline(createReadStream(filename), createGunzip(), unpackTar(extracted));
	const publishedOutput = await readFile(join(extracted, "package", "dist", "index.js"), "utf8");
	const publishedBundleOutput = await readFile(
		join(extracted, "package", "dist", "bundle.js"),
		"utf8",
	);
	const publishedChecksumOutput = await readFile(
		join(extracted, "package", "dist", "checksum.js"),
		"utf8",
	);
	const publishedFetchOutput = await readFile(
		join(extracted, "package", "dist", "fetch-entry.js"),
		"utf8",
	);
	if (
		publishedBundleOutput.includes("createRequire") ||
		publishedBundleOutput.includes("@sigstore") ||
		publishedChecksumOutput.includes("createRequire") ||
		publishedChecksumOutput.includes("@sigstore") ||
		publishedFetchOutput.includes("createRequire") ||
		publishedFetchOutput.includes("@sigstore")
	) {
		throw new Error("Packed Worker-safe entry includes Node or Sigstore verifier code");
	}

	if (
		/from ["']@sigstore\//.test(publishedOutput) ||
		/require\(["']@sigstore\//.test(publishedOutput)
	) {
		throw new Error("Packed output still imports an external Sigstore implementation");
	}
	for (const requiredCode of [
		"prime256v1",
		"secp384r1",
		"secp521r1",
		"ed25519",
		"asymmetricKeyDetails",
	]) {
		if (!publishedOutput.includes(requiredCode)) {
			throw new Error(`Packed output is missing patched algorithm selection: ${requiredCode}`);
		}
	}
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
