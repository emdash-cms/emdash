/**
 * Front Worker. Static assets are served by the assets binding before this
 * runs; everything else goes to the single site Durable Object. Kept free of
 * app code so a cold isolate at any location starts quickly.
 */

interface FrontEnv {
	SITE: DurableObjectNamespace;
}

export default {
	fetch: (request, env) => env.SITE.getByName("site").fetch(request),
} satisfies ExportedHandler<FrontEnv>;
