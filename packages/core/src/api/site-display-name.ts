import type { Kysely } from "kysely";

import { SiteSettingsRepository } from "../database/repositories/site-settings.js";
import type { Database } from "../database/types.js";
import { getRequestContext } from "../request-context.js";

export async function getSelectedSiteTitle(db: Kysely<Database>): Promise<string | undefined> {
	if (!getRequestContext()?.siteId) return undefined;
	return new SiteSettingsRepository(db).get<string>("title");
}

export async function getSiteDisplayName(db: Kysely<Database>): Promise<string> {
	return (await getSelectedSiteTitle(db)) || "EmDash";
}
