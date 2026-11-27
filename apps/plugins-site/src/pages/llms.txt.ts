import type { APIRoute } from "astro";

import { searchCatalog } from "../lib/catalog.js";
import { pluginPath, publisherHandle } from "../lib/registry.js";

const WHITESPACE = /\s+/g;
/** Includes full-width and CJK stops, so a Japanese description keeps its 。 alone. */
const ENDS_SENTENCE = /[.!?…。！？]$/u;
const LINK_TEXT_SPECIAL = /[[\]\\]/g;

/**
 * llms.txt (https://llmstxt.org): a Markdown map of the registry for language
 * models, listing every plugin with a link to its page.
 */
export const GET: APIRoute = async ({ site }) => {
	const origin = site ?? new URL("https://plugins.emdashcms.com");
	const result = await searchCatalog("");
	if ("error" in result) {
		// Like the sitemap: an outage mustn't be cached as a registry with no plugins.
		return new Response(null, { status: 503, headers: { "retry-after": "30" } });
	}

	const plugins = result.packages
		.map((plugin) => {
			const name = oneLine(plugin.profile?.name) || plugin.slug;
			const description = oneLine(plugin.profile?.description);
			const handle = publisherHandle(plugin);
			const publisher = `Published by ${handle ? `@${handle}` : plugin.did}${plugin.latestVersion ? `, v${plugin.latestVersion}` : ""}.`;
			const details = [
				description && ENDS_SENTENCE.test(description)
					? description
					: description && `${description}.`,
				publisher,
			]
				.filter(Boolean)
				.join(" ");
			return {
				name,
				line: `- [${escapeLinkText(name)}](${new URL(pluginPath(plugin), origin).href}): ${details}`,
			};
		})
		.toSorted((a, b) => a.name.localeCompare(b.name, "en"))
		.map((plugin) => plugin.line);

	const body = `# EmDash Plugins

> The plugin registry for EmDash CMS. Each plugin runs in its own sandbox and gets only the capabilities it declares and the site owner approves. It can't read environment variables, the filesystem, or another plugin's storage.

- Install a plugin: open its page here, choose Open in EmDash, and enter your site's URL. Your EmDash admin lists the permissions and network hosts the plugin asks for, and verifies the bundle's checksum, name, version, and permissions before it installs.
- Publish a plugin: write it in TypeScript, declare the capabilities it needs, and publish it from your own Atmosphere account.

## Plugins

${plugins.length > 0 ? plugins.join("\n") : "No plugins are listed yet."}

## Docs

- [Plugins overview](https://docs.emdashcms.com/plugins/overview/)
- [Installing plugins](https://docs.emdashcms.com/plugins/installing/)
- [The plugin registry](https://docs.emdashcms.com/plugins/registry/)
- [Plugin capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/)
- [Your first plugin](https://docs.emdashcms.com/plugins/creating-plugins/your-first-plugin/)
- [Publishing a plugin](https://docs.emdashcms.com/plugins/creating-plugins/publishing/)
- [EmDash docs for language models](https://docs.emdashcms.com/llms.txt)

## Optional

- [EmDash CMS](https://emdashcms.com)
- [Sitemap](${new URL("/sitemap.xml", origin).href})
`;

	return new Response(body, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=300, stale-while-revalidate=3600",
		},
	});
};

/** Registry text on one line, since a newline would end the list item. */
function oneLine(value: string | undefined): string {
	return value?.replace(WHITESPACE, " ").trim() ?? "";
}

function escapeLinkText(value: string): string {
	return value.replace(LINK_TEXT_SPECIAL, "\\$&");
}
