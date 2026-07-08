#!/usr/bin/env -S npx tsx
/**
 * Generate a signed preview URL for local testing.
 *
 * Usage:
 *   npx tsx sign-url.ts [source] [preview]
 *
 * Defaults:
 *   source:  http://localhost:4321
 *   preview: http://localhost:4322
 *   secret:  reads PREVIEW_SECRET from .env, falls back to "dev-secret"
 */

import { readFileSync } from "node:fs";

const source = process.argv[2] || "http://localhost:4321";
const preview = process.argv[3] || "http://localhost:4322";

let secret = "dev-secret";
try {
	const envFile = readFileSync(new URL(".env", import.meta.url), "utf-8");
	const match = envFile.match(/^PREVIEW_SECRET\s*=\s*"?([^"\n]+)"?/m);
	if (match) secret = match[1]!;
} catch {
	// no .env, use default
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const encoder = new TextEncoder();

const key = await crypto.subtle.importKey(
	"raw",
	encoder.encode(secret),
	{ name: "HMAC", hash: "SHA-256" },
	false,
	["sign"],
);

const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${source}:${exp}`));
const sig = Array.from(new Uint8Array(sigBuffer), (b) => b.toString(16).padStart(2, "0")).join("");

const url = new URL(preview);
url.searchParams.set("source", source);
url.searchParams.set("exp", String(exp));
url.searchParams.set("sig", sig);

console.log(url.toString());
