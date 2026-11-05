import type { OptionsRepository } from "../database/repositories/options.js";

/** Prefer the General settings title, falling back to the title recorded during setup. */
export function resolveSiteTitle(setting: unknown, setupTitle: unknown): string | undefined {
	if (typeof setting === "string" && setting) return setting;
	if (typeof setupTitle === "string" && setupTitle) return setupTitle;
	return undefined;
}

export async function getSiteTitle(options: OptionsRepository): Promise<string | undefined> {
	const titles = await options.getMany(["site:title", "emdash:site_title"]);
	return resolveSiteTitle(titles.get("site:title"), titles.get("emdash:site_title"));
}
