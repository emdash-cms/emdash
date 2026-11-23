#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createLunaria } from "@lunariajs/core";
import { po } from "gettext-parser";

const DASHBOARD_URL = "https://i18n.emdashcms.com/";
const GUIDE_URL = "https://docs.emdashcms.com/contributing/translating/";

const SOURCE_CATALOG = "packages/admin/src/locales/en/messages.po";
const CATALOG_URL = "https://github.com/emdash-cms/emdash/blob/main/";
const DESCRIPTION_LIMIT = 4096;
const TIERS = [
	{ label: "Under 100 missing", below: 100, counts: true },
	{ label: "100 to 999 missing", below: 1000, counts: false },
	{ label: "1,000 or more missing", below: Infinity, counts: false },
];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Key paths in Lunaria's shape: `[msgid]`, or `[msgctxt, msgid]` for entries with a context. */
export function catalogKeys(contents) {
	const keys = [];
	for (const [context, entries] of Object.entries(po.parse(contents).translations)) {
		for (const msgid of Object.keys(entries)) {
			if (msgid !== "") keys.push(context ? [context, msgid] : [msgid]);
		}
	}
	return keys;
}

const keyId = (key) => key.join("\u0004");

/**
 * Scheduled runs start late by varying amounts. Flooring to midnight UTC keeps each window
 * overlapping the previous run's instead of leaving a gap that no digest covers.
 */
export function weekCutoff(now) {
	const cutoff = new Date(now - WEEK_MS);
	cutoff.setUTCHours(0, 0, 0, 0);
	return cutoff;
}

/** A Discord webhook payload: the digest as an embed, and the role ping, if any, as content. */
export function buildMessage({ count, locales, release, since, roleId }) {
	const strings = count === 1 ? "1 new string" : `${count} new strings`;
	const title = release ? `New admin strings since ${release}` : "New admin strings this week";
	const intro = release
		? `${strings} landed on main since the ${release} release and will ship with the next one.`
		: `${strings} landed on main since ${since}.`;
	const behind = locales
		.filter(({ missing }) => missing > 0)
		.toSorted((a, b) => a.missing - b.missing || a.lang.localeCompare(b.lang));
	const complete = locales
		.filter(({ missing }) => missing === 0)
		.map(({ lang }) => lang)
		.toSorted();

	const describe = (linked) => {
		const lines = [intro];
		if (complete.length > 0) lines.push("", "**Complete**", complete.join(" · "));
		let from = 0;
		for (const { label, below, counts } of TIERS) {
			let to = from;
			while (to < behind.length && behind[to].missing < below) to += 1;
			if (to === from) continue;
			const entries = behind.slice(from, to).map(({ lang, path, missing }, offset) => {
				const name = from + offset < linked ? `[${lang}](${CATALOG_URL}${path})` : lang;
				return counts ? `${name} ${missing}` : name;
			});
			lines.push("", `**${label}**`, entries.join(" · "));
			from = to;
		}
		lines.push(
			"",
			`[Translation dashboard](${DASHBOARD_URL}) · [How to help translate](${GUIDE_URL})`,
		);
		return lines.join("\n");
	};

	let linked = behind.length;
	let description = describe(linked);
	while (description.length > DESCRIPTION_LIMIT && linked > 0) {
		linked -= 1;
		description = describe(linked);
	}

	return {
		...(roleId ? { content: `<@&${roleId}>` } : {}),
		embeds: [{ title, url: DASHBOARD_URL, description }],
	};
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function resolveBase(since) {
	if (since === "last-release") {
		const tag = git("describe", "--tags", "--abbrev=0", "--match", "emdash@*", "HEAD");
		return { rev: tag, release: tag.slice("emdash@".length) };
	}
	if (since === "week") {
		const cutoff = weekCutoff(Date.now()).toISOString();
		const rev = git("rev-list", "-1", `--before=${cutoff}`, "HEAD");
		if (!rev)
			throw new Error(`No commit before ${cutoff}. A shallow clone has no history to compare.`);
		return { rev, since: cutoff.slice(0, 10) };
	}
	throw new Error(`Unknown --since value "${since}". Use "week" or "last-release".`);
}

async function main(args) {
	const { values } = parseArgs({ args, options: { since: { type: "string", default: "week" } } });
	const base = resolveBase(values.since);

	const before = new Set(catalogKeys(git("show", `${base.rev}:${SOURCE_CATALOG}`)).map(keyId));
	const current = catalogKeys(await readFile(SOURCE_CATALOG, "utf8"));
	const newStrings = current.filter((key) => !before.has(keyId(key)));
	if (newStrings.length === 0) {
		console.log(`No new strings since ${base.release ?? base.rev}. Nothing to post.`);
		return;
	}

	const lunaria = await createLunaria({ logLevel: "error" });
	const [entry] = await lunaria.getFullStatus();
	const locales = entry.localizations.map((localization) => ({
		lang: localization.lang,
		path: localization.path,
		missing: localization.status === "missing" ? current.length : localization.missingKeys.length,
	}));

	const roleId = process.env.DISCORD_ROLE_ID || undefined;
	const message = buildMessage({
		count: newStrings.length,
		locales,
		release: base.release,
		since: base.since,
		roleId,
	});
	const [embed] = message.embeds;
	console.log(
		[message.content, `**${embed.title}**`, embed.description].filter(Boolean).join("\n"),
	);

	const webhook = process.env.DISCORD_WEBHOOK_URL;
	if (!webhook) {
		console.log("\nDISCORD_WEBHOOK_URL is not set. Printed the message instead of posting it.");
		return;
	}
	const response = await fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...message,
			allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
		}),
	});
	if (!response.ok) {
		throw new Error(`Discord webhook returned ${response.status}: ${await response.text()}`);
	}
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (scriptPath === import.meta.url) {
	process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	await main(process.argv.slice(2));
}
