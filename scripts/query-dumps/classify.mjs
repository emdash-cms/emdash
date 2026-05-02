#!/usr/bin/env node
/**
 * Analyse the per-route query dumps and classify each query.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function classify(sql, params) {
	const s = sql.replace(/\s+/g, " ").trim();
	// Migrations / system
	if (/pragma_table_info/i.test(s)) return "pragma_table_info";
	if (/sqlite_master/i.test(s)) return "sqlite_master";
	if (/PRAGMA/i.test(s)) return "pragma";
	if (/from "kysely_migration"/i.test(s)) return "migrations_check";
	if (/from "_emdash_migrations_lock"/i.test(s)) return "migrations_lock";
	if (/from "_emdash_migrations"/i.test(s)) return "migrations_check";
	if (/from "_emdash_collections"/i.test(s)) return "schema_collections";
	if (/from "_emdash_fields"/i.test(s)) return "schema_fields";
	if (/from "_emdash_setup_state"/i.test(s)) return "setup_check";
	if (/from "_plugin_state"/i.test(s)) return "plugin_state";
	if (/from "_emdash_cron_tasks"/i.test(s) || /_emdash_cron_tasks SET/i.test(s))
		return "cron_recovery";
	if (/_emdash_404_log/i.test(s)) return "404_log_migration";
	if (/alter table/i.test(s)) return "ddl_alter";
	if (/create table/i.test(s)) return "ddl_create";
	if (/create.*index/i.test(s)) return "ddl_index";
	if (/drop index/i.test(s)) return "ddl_drop_index";
	if (/insert into "_emdash_migrations"/i.test(s)) return "migrations_record";
	if (/delete from "options"/i.test(s)) return "options_delete";
	if (/SELECT name FROM sqlite_master/i.test(s)) return "fts_table_check";
	// Auth
	if (/from "_emdash_sessions"/i.test(s)) return "auth_session";
	if (/from "_emdash_users"/i.test(s)) return "auth_user_lookup";
	if (/from "_emdash_passkeys"/i.test(s)) return "auth_passkey";
	// Settings/options
	if (/from "options"/i.test(s) && /LIKE/i.test(s)) {
		const p0 = params?.[0];
		if (typeof p0 === "string") return `options_prefix:${p0}`;
		return "options_prefix";
	}
	if (/from "options"/i.test(s) && /"name" in/i.test(s)) {
		return "options_in";
	}
	if (/from "options"/i.test(s) && /"name" = \?/i.test(s)) {
		const p0 = params?.[0];
		if (typeof p0 === "string") return `option:${p0}`;
		return "option:single";
	}
	if (/from "options"/i.test(s)) return "option:other";
	// Menus / widgets
	if (/from "_emdash_menus"/i.test(s)) return "menu_lookup";
	if (/from "_emdash_menu_items"/i.test(s)) return "menu_items";
	if (/from "_emdash_widget_areas"/i.test(s)) {
		const p0 = params?.[0];
		return `widget_area:${p0 ?? ""}`;
	}
	if (/from "_emdash_widgets"/i.test(s)) return "widget";
	// Bylines
	if (/from "_emdash_content_bylines"/i.test(s)) return "byline_hydration";
	if (/from "_emdash_bylines"/i.test(s)) return "byline_lookup";
	// Taxonomies
	if (/from "_emdash_taxonomy_defs"/i.test(s)) return "taxonomy_defs";
	if (/from "content_taxonomies"/i.test(s) && /count\(/i.test(s)) return "taxonomy_counts";
	if (/from "content_taxonomies"/i.test(s)) return "taxonomy_for_entries";
	if (/from "taxonomies"/i.test(s)) return "taxonomy_terms";
	// Author lookup (id, author_id)
	if (/SELECT id, author_id FROM "ec_/i.test(s)) return "author_id_lookup";
	// Content tables
	const ecMatch = s.match(/from "ec_([a-z_]+)"/i) || s.match(/FROM "ec_([a-z_]+)"/);
	if (ecMatch) {
		const coll = ecMatch[1];
		// detail vs list
		if (/slug = \?/i.test(s) && /id = \?/i.test(s)) return `entry_by_slug:${coll}`;
		if (/where "id" = \?/i.test(s)) return `entry_by_id:${coll}`;
		if (/LIMIT \?/i.test(s)) return `collection_list:${coll}`;
		if (/ORDER BY/i.test(s)) return `collection_list:${coll}`;
		return `collection_other:${coll}`;
	}
	// Media
	if (/from "_emdash_media"/i.test(s)) return "media_lookup";
	// Plugins / pages dispatch
	if (/from "_emdash_plugin/i.test(s)) return "plugin_lookup";
	// SEO redirects
	if (/from "_emdash_redirects"/i.test(s)) return "redirects";
	// Comments
	if (/from "_emdash_comments"/i.test(s)) return "comments";
	// Default
	return "other";
}

const targetArg = process.argv[2] || "sqlite";
const dir = resolve(__dirname, targetArg);
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_all.json");

// per-route classification table
const tables = {}; // { routePhase: { className: count } }
const allByClass = {}; // { className: count }
const totalDuration = {}; // { className: ms }

const routeOrder = [
	"root",
	"posts",
	"posts_building_for_the_long_term",
	"pages_about",
	"category_development",
	"tag_webdev",
	"rss_xml",
	"search",
];

const phases = ["cold", "warm"];

for (const f of files) {
	const path = resolve(dir, f);
	const events = JSON.parse(readFileSync(path, "utf8"));
	const key = f.replace(/\.json$/, "");
	tables[key] = {};
	for (const e of events) {
		const cls = classify(e.sql, e.params);
		tables[key][cls] = (tables[key][cls] || 0) + 1;
		allByClass[cls] = (allByClass[cls] || 0) + 1;
		totalDuration[cls] = (totalDuration[cls] || 0) + (e.durationMs || 0);
	}
}

// print table: rows = classes, cols = route.phase
const headerRoutes = [];
for (const r of routeOrder) for (const p of phases) headerRoutes.push(`${r}.${p}`);

const allClasses = Object.keys(allByClass).toSorted(
	(a, b) => (allByClass[b] || 0) - (allByClass[a] || 0),
);

let out = `# Query classification (${targetArg})\n\n`;
out += `Total events: ${Object.values(allByClass).reduce((a, b) => a + b, 0)}\n\n`;

out += `## Top classes by total count\n\n`;
out += `| class | count | total_ms |\n|---|---:|---:|\n`;
for (const c of allClasses.slice(0, 20)) {
	out += `| ${c} | ${allByClass[c]} | ${totalDuration[c].toFixed(2)} |\n`;
}
out += "\n";

out += `## Per-route × phase classification\n\n`;
out += `| class |`;
for (const h of headerRoutes) out += ` ${h} |`;
out += ` total |\n|---|`;
for (const _ of headerRoutes) out += "---:|";
out += "---:|\n";
for (const c of allClasses) {
	out += `| ${c} |`;
	let total = 0;
	for (const h of headerRoutes) {
		const v = tables[h]?.[c] || 0;
		total += v;
		out += ` ${v || ""} |`;
	}
	out += ` ${total} |\n`;
}
out += "\n";

out += `## Per-route totals\n\n`;
out += `| route.phase | count |\n|---|---:|\n`;
for (const h of headerRoutes) {
	const total = Object.values(tables[h] || {}).reduce((a, b) => a + b, 0);
	out += `| ${h} | ${total} |\n`;
}

writeFileSync(resolve(__dirname, `classification.${targetArg}.md`), out);
process.stdout.write(out);
