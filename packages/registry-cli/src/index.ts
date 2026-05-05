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
 *   - switch   — change the active publisher session
 *   - search   — free-text search the aggregator
 *   - info     — show details about a package
 *   - bundle   — bundle a plugin source directory into a tarball
 *   - publish  — publish a release that points at a hosted tarball
 *
 * EXPERIMENTAL: this CLI targets `com.emdashcms.experimental.*` and the
 * experimental aggregator. Pin to an exact version while RFC 0001 is in flight.
 */

import { defineCommand, runMain } from "citty";

import { bundleCommand } from "./bundle/command.js";
import { infoCommand } from "./commands/info.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { publishCommand } from "./commands/publish.js";
import { searchCommand } from "./commands/search.js";
import { switchCommand } from "./commands/switch.js";
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
		switch: switchCommand,
		search: searchCommand,
		info: infoCommand,
		bundle: bundleCommand,
		publish: publishCommand,
	},
});

void runMain(main);
