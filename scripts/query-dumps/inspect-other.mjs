#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function classify(sql, params) {
	const s = sql.replace(/\s+/g, " ").trim();
	if (/PRAGMA/i.test(s)) return "pragma";
	if (/from "kysely_migration"/i.test(s)) return "migrations_check";
	if (/from "_emdash_collections"/i.test(s)) return "schema_collections";
	if (/from "_emdash_fields"/i.test(s)) return "schema_fields";
	if (/from "_emdash_sessions"/i.test(s)) return "auth_session";
	if (/from "_emdash_users"/i.test(s)) return "auth_user_lookup";
	if (/from "_emdash_passkeys"/i.test(s)) return "auth_passkey";
	if (/from "options"/i.test(s) && /name = \?/i.test(s)) {
		const p0 = params?.[0];
		if (typeof p0 === "string") return `option:${p0}`;
		return "option:single";
	}
	if (/from "options"/i.test(s) && /LIKE/i.test(s)) {
		const p0 = params?.[0];
		if (typeof p0 === "string") return `options_prefix:${p0}`;
		return "options_prefix";
	}
	if (/from "_emdash_menus"/i.test(s)) return "menu_lookup";
	if (/from "_emdash_menu_items"/i.test(s)) return "menu_items";
	if (/from "_emdash_widget_areas"/i.test(s)) {
		const p0 = params?.[0];
		return `widget_area:${p0 ?? ""}`;
	}
	if (/from "_emdash_widgets"/i.test(s)) return "widget";
	if (/from "_emdash_content_bylines"/i.test(s)) return "byline_hydration";
	if (/from "_emdash_bylines"/i.test(s)) return "byline_lookup";
	if (/from "_emdash_taxonomy_defs"/i.test(s)) return "taxonomy_defs";
	if (/from "content_taxonomies"/i.test(s) && /count\(/i.test(s)) return "taxonomy_counts";
	if (/from "content_taxonomies"/i.test(s)) return "taxonomy_for_entries";
	if (/from "taxonomies"/i.test(s)) return "taxonomy_terms";
	if (/SELECT id, author_id FROM "ec_/i.test(s)) return "author_id_lookup";
	const ecMatch = s.match(/from "ec_([a-z_]+)"/i) || s.match(/FROM "ec_([a-z_]+)"/);
	if (ecMatch) {
		const coll = ecMatch[1];
		if (/slug = \?/i.test(s) && /id = \?/i.test(s)) return `entry_by_slug:${coll}`;
		if (/where "id" = \?/i.test(s)) return `entry_by_id:${coll}`;
		if (/LIMIT \?/i.test(s)) return `collection_list:${coll}`;
		if (/ORDER BY/i.test(s)) return `collection_list:${coll}`;
		return `collection_other:${coll}`;
	}
	if (/from "_emdash_media"/i.test(s)) return "media_lookup";
	if (/from "_emdash_plugin/i.test(s)) return "plugin_lookup";
	if (/from "_emdash_redirects"/i.test(s)) return "redirects";
	if (/from "_emdash_comments"/i.test(s)) return "comments";
	return "other";
}

const targetArg = process.argv[2] || "sqlite";
const wanted = process.argv[3] || "other";
const dir = resolve(__dirname, targetArg);
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_all.json");
const seen = new Set();
for (const f of files) {
	const events = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
	for (const e of events) {
		const cls = classify(e.sql, e.params);
		if (cls !== wanted) continue;
		const norm = e.sql.replace(/\s+/g, " ").trim();
		if (!seen.has(norm)) {
			seen.add(norm);
			process.stdout.write(`--- ${f}\n${norm}\nparams: ${JSON.stringify(e.params)}\n\n`);
		}
	}
}
