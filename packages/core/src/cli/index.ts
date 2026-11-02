#!/usr/bin/env node

import { defineCommand, runMain } from "citty";

import { contentCommand } from "./commands/content.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportSeedCommand } from "./commands/export-seed.js";
import { initCommand } from "./commands/init.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { mediaCommand } from "./commands/media.js";
import { menuCommand } from "./commands/menu.js";
import { migrateCommand } from "./commands/migrate.js";
import { schemaCommand } from "./commands/schema.js";
import { searchCommand } from "./commands/search-cmd.js";
import { secretsCommand } from "./commands/secrets.js";
import { seedCommand } from "./commands/seed.js";
import { siteCommand } from "./commands/site.js";
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
		doctor: doctorCommand,
		seed: seedCommand,
		migrate: migrateCommand,
		"export-seed": exportSeedCommand,
		secrets: secretsCommand,
		login: loginCommand,
		logout: logoutCommand,
		whoami: whoamiCommand,
		content: contentCommand,
		schema: schemaCommand,
		media: mediaCommand,
		search: searchCommand,
		taxonomy: taxonomyCommand,
		menu: menuCommand,
		site: siteCommand,
	},
});

void runMain(main);
