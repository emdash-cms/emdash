#!/usr/bin/env node
// Resolves the model alias from a /bonk, /review, or @ask-bonk comment body
// and emits the model id and OPENCODE_CONFIG_CONTENT for the ask-bonk action.
//
// Inputs (env):
//   BODY              — the raw comment / review body
//   GITHUB_OUTPUT     — path to the workflow step output file
//
// Outputs (to $GITHUB_OUTPUT):
//   alias             — resolved alias (default if none requested)
//   model             — full model id passed to ask-bonk's `model:` input
//   opencode_config   — JSON string for OPENCODE_CONFIG_CONTENT env var
//
// The first word after a trigger ("/bonk", "/review", or "@ask-bonk") selects
// an alias from .github/bonk-models.json. An absent or unknown word falls
// back to the registry's `default`. Only the selected model is registered in
// the opencode provider config; the rest of the registry stays unused at
// runtime to keep the env var small.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(here, "..", "bonk-models.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

const body = process.env.BODY ?? "";

// Match a trigger preceded by start-of-string or whitespace, then capture the
// next bare word. The leading-boundary guard avoids matching "/bonk" as a
// substring of unrelated text (e.g. a URL fragment).
const triggerRe = /(?:^|\s)(?:\/bonk|\/review|@ask-bonk)\s+([a-zA-Z][a-zA-Z0-9_-]*)/;
const match = body.match(triggerRe);
const requested = match ? match[1].toLowerCase() : null;

const fallback = registry.default;
const alias = requested && registry.models[requested] ? requested : fallback;
const entry = registry.models[alias];
if (!entry) {
	console.error(`bonk-models.json default "${fallback}" missing from models map`);
	process.exit(1);
}

const model = `cloudflare-ai-gateway/${entry.id}`;

// OPENCODE_CONFIG_CONTENT bundles two unrelated overrides:
//
// 1. Register the selected model with the pinned opencode version (1.4.6,
//    published 2026-04-15). Without this, opencode raises
//    ProviderModelNotFoundError on any model whose release_date is after
//    its bundled models.dev snapshot.
//
// 2. Resolve the two opencode permission defaults that ask interactively
//    (`external_directory` and `doom_loop`) so a CI run with no TTY can
//    never deadlock waiting for approval. external_directory is
//    deny-by-default with /tmp/** and ~/** allowed (scratch files,
//    home-dir caches); doom_loop is deny so a stuck loop aborts instead
//    of prompting. Repro: PR #769 timed out at 30 min waiting for an
//    `external_directory` prompt on `git show ... > /tmp/foo`.
const opencodeConfig = {
	permission: {
		external_directory: {
			"*": "deny",
			"/tmp/**": "allow",
			"~/**": "allow",
		},
		doom_loop: "deny",
	},
	provider: {
		"cloudflare-ai-gateway": {
			models: {
				[entry.id]: entry.registration,
			},
		},
	},
};

const out = process.env.GITHUB_OUTPUT;
if (!out) {
	console.error("GITHUB_OUTPUT is not set");
	process.exit(1);
}

const eof = "OPENCODE_CONFIG_EOF";
appendFileSync(
	out,
	[
		`alias=${alias}`,
		`requested=${requested ?? ""}`,
		`model=${model}`,
		`opencode_config<<${eof}`,
		JSON.stringify(opencodeConfig),
		eof,
		"",
	].join("\n"),
);

console.log(`Resolved alias "${alias}" -> ${model}`);
