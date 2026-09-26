/**
 * emdash plugin
 *
 * Plugin management commands grouped under a single namespace.
 *
 * Subcommands:
 * - init: Scaffold a new plugin
 * - bundle: Bundle a plugin for marketplace distribution
 * - validate: Run bundle validation without producing a tarball
 * - publish: Publish a plugin to the marketplace
 * - logout: Log out of the marketplace
 *
 */

import { defineCommand } from "citty";

import { bundleCommand } from "./bundle.js";
import { pluginInitCommand } from "./plugin-init.js";
import { pluginValidateCommand } from "./plugin-validate.js";
import { publishCommand, marketplaceLogoutCommand } from "./publish.js";

export const pluginCommand = defineCommand({
	meta: { name: "plugin", description: "Manage plugins" },
	subCommands: {
		init: pluginInitCommand,
		bundle: bundleCommand,
		validate: pluginValidateCommand,
		publish: publishCommand,
		logout: marketplaceLogoutCommand,
	},
});
