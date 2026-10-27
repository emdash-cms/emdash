import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getRobots } from "../../../src/astro/routes/robots.txt.js";
import type { Database } from "../../../src/database/types.js";
import { setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function mockContext(db: Kysely<Database>): APIContext {
	return {
		locals: { emdash: { db, config: undefined } },
		url: new URL("https://example.com/robots.txt"),
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

async function robots(db: Kysely<Database>): Promise<string> {
	const res = await getRobots(mockContext(db));
	expect(res.status).toBe(200);
	return res.text();
}

interface Rule {
	allow: boolean;
	path: string;
}

/**
 * RFC 9309 matching without wildcards: a user-agent line after a rule starts
 * a new group, lines other than user-agent/allow/disallow are ignored, groups
 * for the same agent merge, the longest matching path wins, and Allow wins ties.
 */
function isAllowed(robotsTxt: string, agent: string, path: string): boolean {
	const groups: { agents: string[]; rules: Rule[] }[] = [];
	let current: { agents: string[]; rules: Rule[] } | undefined;
	for (const raw of robotsTxt.split("\n")) {
		const line = raw.replace(/#.*/, "").trim();
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === "user-agent") {
			if (!current || current.rules.length > 0) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
		} else if ((key === "allow" || key === "disallow") && current) {
			current.rules.push({ allow: key === "allow", path: value });
		}
	}

	const named = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
	const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
	let best: Rule | undefined;
	for (const rule of applicable.flatMap((g) => g.rules)) {
		if (!rule.path || !path.startsWith(rule.path)) continue;
		if (
			!best ||
			rule.path.length > best.path.length ||
			(rule.path.length === best.path.length && rule.allow)
		) {
			best = rule;
		}
	}
	return best?.allow ?? true;
}

describe("robots.txt route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("leaves AI crawlers alone by default", async () => {
		const body = await robots(db);
		expect(isAllowed(body, "GPTBot", "/")).toBe(true);
		expect(body).not.toContain("Content-Signal");
		expect(body).toContain("Sitemap: https://example.com/sitemap.xml");
	});

	it("blocks AI training crawlers but not search engines in the default robots.txt", async () => {
		await setSiteSettings({ seo: { disallowAiTraining: true } }, db);
		const body = await robots(db);

		expect(isAllowed(body, "Googlebot", "/blog")).toBe(true);
		expect(isAllowed(body, "Googlebot", "/_emdash/admin")).toBe(false);
		expect(isAllowed(body, "GPTBot", "/blog")).toBe(false);
		expect(isAllowed(body, "Google-Extended", "/blog")).toBe(false);
		expect(body).toContain("Content-Signal: search=yes, ai-train=no");
		expect(body.trimEnd().endsWith("Sitemap: https://example.com/sitemap.xml")).toBe(true);
	});

	it("keeps a custom robots.txt's rules for search engines when appending the AI rules", async () => {
		await setSiteSettings(
			{ seo: { robotsTxt: "User-agent: *\nDisallow: /private/\n", disallowAiTraining: true } },
			db,
		);
		const body = await robots(db);

		expect(isAllowed(body, "Googlebot", "/blog")).toBe(true);
		expect(isAllowed(body, "Googlebot", "/private/page")).toBe(false);
		expect(isAllowed(body, "GPTBot", "/blog")).toBe(false);
		expect(body.trimEnd().endsWith("Sitemap: https://example.com/sitemap.xml")).toBe(true);
	});

	it("does not unblock a custom robots.txt that disallows everything", async () => {
		await setSiteSettings(
			{ seo: { robotsTxt: "User-agent: *\nDisallow: /", disallowAiTraining: true } },
			db,
		);
		const body = await robots(db);

		expect(isAllowed(body, "Googlebot", "/")).toBe(false);
		expect(isAllowed(body, "GPTBot", "/")).toBe(false);
	});

	it("does not block search engines when a custom robots.txt has no catch-all group", async () => {
		await setSiteSettings(
			{ seo: { robotsTxt: "User-agent: BadBot\nDisallow: /", disallowAiTraining: true } },
			db,
		);
		const body = await robots(db);

		expect(isAllowed(body, "Googlebot", "/")).toBe(true);
		expect(isAllowed(body, "BadBot", "/")).toBe(false);
		expect(isAllowed(body, "ClaudeBot", "/")).toBe(false);
	});

	it("keeps a custom robots.txt's own sitemap when appending the AI rules", async () => {
		const custom = "User-agent: *\nDisallow: /private/\nSitemap: https://example.com/custom.xml";
		await setSiteSettings({ seo: { robotsTxt: custom, disallowAiTraining: true } }, db);
		const body = await robots(db);

		expect(body.startsWith(custom)).toBe(true);
		expect(body).not.toContain("https://example.com/sitemap.xml");
		expect(isAllowed(body, "Googlebot", "/blog")).toBe(true);
		expect(isAllowed(body, "Googlebot", "/private/page")).toBe(false);
		expect(isAllowed(body, "GPTBot", "/blog")).toBe(false);
	});

	it("serves a custom robots.txt unchanged when it has a sitemap and the option is off", async () => {
		const custom = "User-agent: *\nDisallow: /private/\nSitemap: https://example.com/custom.xml";
		await setSiteSettings({ seo: { robotsTxt: custom } }, db);
		expect(await robots(db)).toBe(custom);
	});
});
