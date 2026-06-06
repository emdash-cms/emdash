#!/usr/bin/env node

/**
 * EmDash CLI
 *
 * Built with citty + clack (same stack as Nuxt CLI)
 *
 * Commands:
 * - init: Bootstrap database from template config, or interactive setup
 * - types: Generate TypeScript types from schema
 * - dev: Run dev server with local D1
 * - seed: Apply a seed file to the database
 * - export-seed: Export database schema and content as a seed file
 * - secrets: Generate and inspect EmDash secrets (encryption keys, etc.)
 * - auth: [DEPRECATED] Generate auth secret (use `secrets` instead)
 * - login/logout/whoami: Session management
 * - content: Create, read, update, delete content
 * - schema: Manage collections and fields
 * - media: Upload and manage media
 * - search: Full-text search
 * - taxonomy: Manage taxonomies and terms
 * - menu: Manage navigation menus
 * - plugin: Plugin management (init, bundle, validate, publish, login, logout)
 */

import { defineCommand, runMain } from "citty";

import { authCommand } from "./commands/auth.js";
import { contentCommand } from "./commands/content.js";
import { devCommand } from "./commands/dev.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportSeedCommand } from "./commands/export-seed.js";
import { initCommand } from "./commands/init.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { mediaCommand } from "./commands/media.js";
import { menuCommand } from "./commands/menu.js";
import { pluginCommand } from "./commands/plugin.js";
import { schemaCommand } from "./commands/schema.js";
import { searchCommand } from "./commands/search-cmd.js";
import { secretsCommand } from "./commands/secrets.js";
import { seedCommand } from "./commands/seed.js";
import { taxonomyCommand } from "./commands/taxonomy.js";
import { typesCommand } from "./commands/types.js";

const main = defineCommand({
	meta: {
		name: "emdash",
		version: "0.0.0",
		description: "CLI for EmDash CMS",
	},
	subCommands: {
		init: initCommand,
		types: typesCommand,
		dev: devCommand,
		doctor: doctorCommand,
		seed: seedCommand,
		"export-seed": exportSeedCommand,
		secrets: secretsCommand,
		// Deprecated alias kept for backwards compat; will be removed in a future minor.
		auth: authCommand,
		login: loginCommand,
		logout: logoutCommand,
		whoami: whoamiCommand,
		content: contentCommand,
		schema: schemaCommand,
		media: mediaCommand,
		search: searchCommand,
		taxonomy: taxonomyCommand,
		menu: menuCommand,
		plugin: pluginCommand,
	},
});

void runMain(main);
