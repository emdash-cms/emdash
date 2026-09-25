import { expectTypeOf, it } from "vitest";

import type { PluginContext } from "../../../src/plugins/types.js";

async function updateRedirectFromDocumentedContext(
	ctx: PluginContext,
	redirectId: string,
): Promise<void> {
	const current = await ctx.redirects!.get(redirectId);
	if (current) {
		await ctx.redirects!.update!(redirectId, {
			destination: "/guides/current",
			_rev: current._rev,
		});
	}
}

it("type-checks the documented redirect update pattern", () => {
	expectTypeOf(updateRedirectFromDocumentedContext).toBeFunction();
});
