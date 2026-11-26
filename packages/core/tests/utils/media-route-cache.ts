import type { APIContext } from "astro";
import memoryProvider from "astro/cache/memory";
import { buildCacheControlDirectives } from "astro/cache/provider-utils";

export function memoryMediaRequests() {
	const provider = memoryProvider({ query: { include: ["page"] } });
	return async (
		request: Request,
		next: (cache: Pick<APIContext["cache"], "enabled" | "set">) => Promise<Response> | Response,
	): Promise<Response> => {
		const headers = new Headers();
		return provider.onRequest!(
			{ request, url: new URL(request.url), logger: console },
			async () => {
				const response = await next({
					enabled: true,
					set(options) {
						if (options === false) {
							headers.delete("CDN-Cache-Control");
							headers.delete("Cache-Tag");
							return;
						}
						if (!("maxAge" in options)) return;
						const directives = buildCacheControlDirectives(options);
						if (directives) headers.set("CDN-Cache-Control", directives);
						if (options.tags) headers.set("Cache-Tag", options.tags.join(","));
					},
				});
				for (const [name, value] of headers) response.headers.set(name, value);
				return response;
			},
		);
	};
}
