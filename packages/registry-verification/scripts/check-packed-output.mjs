import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
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
	if (publishedOutput.includes("createRequire(import.meta.url)")) {
		throw new Error("Packed verifier output cannot be safely rebundled");
	}

	// On Windows, fileURLToPath() rejects driveless file:/// URLs. The synthetic
	// base used for the CJS interop shim must include a drive letter so it is
	// accepted as a valid absolute file URL on every platform.
	const requireUrlMatch = publishedOutput.match(/__require = .*?createRequire\("([^"]+)"\)/);
	if (!requireUrlMatch) {
		throw new Error("Packed verifier output is missing the CJS interop shim");
	}
	const syntheticRequireUrl = requireUrlMatch[1];
	if (!/^file:\/\/\/[A-Za-z]:\//.test(syntheticRequireUrl)) {
		throw new Error(
			`Packed verifier createRequire URL is not Windows-valid: ${syntheticRequireUrl}`,
		);
	}
	const resolvedPath = fileURLToPath(syntheticRequireUrl);
	if (!path.isAbsolute(resolvedPath)) {
		throw new Error(
			`Packed verifier createRequire URL did not resolve to an absolute path: ${resolvedPath}`,
		);
	}

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
