# `@emdash-cms/registry-loader`

Use the public EmDash plugin registry as an [Astro live content collection](https://docs.astro.build/en/guides/content-collections/#live-content-collections). The loader returns the registry's moderated public projection through `@emdash-cms/registry-client`.

## Register the collection

Install the loader in an Astro project:

```sh
pnpm add @emdash-cms/registry-loader
```

The following configuration registers a `plugins` live collection against the hosted registry:

```ts title="src/live.config.ts"
import { registryLoader } from "@emdash-cms/registry-loader";
import { defineLiveCollection } from "astro:content";

export const collections = {
	plugins: defineLiveCollection({ loader: registryLoader() }),
};
```

Pass `aggregatorUrl` to read from another compatible registry.

## Browse plugins

Use `getLiveCollection()` to browse or search visible packages:

```astro title="src/pages/plugins.astro"
---
import { getLiveCollection } from "astro:content";

const result = await getLiveCollection("plugins", {
	q: Astro.url.searchParams.get("q") ?? undefined,
	limit: 24,
});

if (!result.error) {
	Astro.cache.set({ maxAge: 60, swr: 300, tags: ["registry"] });
}
---

<ul>
	{result.entries?.map(({ data }) => <li>{data.package.profile?.name ?? data.package.slug}</li>)}
</ul>
```

The collection filter accepts `q`, `capability`, and `limit`. An exact handle, DID, or identity followed by `/slug` selects that publisher or package. Astro's live collection result does not expose pagination metadata. Use `DiscoveryClient` from `@emdash-cms/registry-client/discovery` when an interface needs the registry's cursor pagination.

## Load a plugin

Use a publisher handle or DID with the package slug. A single-entry load also includes the latest visible release when one exists:

```astro title="src/pages/plugins/[publisher]/[slug].astro"
---
import { getLiveEntry } from "astro:content";

const result = await getLiveEntry("plugins", {
	publisher: Astro.params.publisher!,
	slug: Astro.params.slug!,
});

if (!result.entry) return Astro.redirect("/404");

const { package: plugin, latestRelease } = result.entry.data;
---

<h1>{plugin.profile?.name ?? plugin.slug}</h1>
<p>{plugin.profile?.description}</p>
{latestRelease && <p>Latest version: {latestRelease.version}</p>}
```

Astro represents a missing or unavailable loader entry as `LiveEntryNotFoundError` in the `getLiveEntry()` result. Other registry and validation failures are returned through the same `error` field. Check the error name when a route needs to distinguish a 404 from an upstream outage.
