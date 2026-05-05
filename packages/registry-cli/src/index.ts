#!/usr/bin/env node
/**
 * @emdash-cms/registry-cli
 *
 * CLI for the experimental EmDash plugin registry. Entry point: `emdash-registry`.
 *
 * Subcommands:
 *   - login    — interactive atproto OAuth login
 *   - logout   — revoke the active session
 *   - whoami   — show stored sessions
 *   - search   — free-text search the aggregator
 *   - info     — show details about a package
 *   - publish  — publish a release (stub; lands in a follow-up PR)
 *
 * EXPERIMENTAL: this CLI targets `com.emdashcms.experimental.*` and the
 * experimental aggregator. Pin to an exact version while RFC 0001 is in flight.
 */

import { defineCommand, runMain } from "citty";

import { infoCommand } from "./commands/info.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { publishCommand } from "./commands/publish.js";
import { searchCommand } from "./commands/search.js";
import { whoamiCommand } from "./commands/whoami.js";

const main = defineCommand({
	meta: {
		name: "emdash-registry",
		description: "CLI for the experimental EmDash plugin registry",
	},
	subCommands: {
		login: loginCommand,
		logout: logoutCommand,
		whoami: whoamiCommand,
		search: searchCommand,
		info: infoCommand,
		publish: publishCommand,
	},
});

void runMain(main);
