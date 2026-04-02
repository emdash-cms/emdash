/**
 * emdash menu
 *
 * Manage menus via the EmDash REST API.
 */

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

const listCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all menus",
	},
	args: {
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const menus = await client.menus();
			output(menus, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const getCommand = defineCommand({
	meta: {
		name: "get",
		description: "Get a menu with its items",
	},
	args: {
		name: {
			type: "positional",
			description: "Menu name",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const menu = await client.menu(args.name);
			output(menu, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

export const menuCommand = defineCommand({
	meta: {
		name: "menu",
		description: "Manage menus",
	},
	subCommands: {
		list: listCommand,
		get: getCommand,
	},
});
