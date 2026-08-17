import { defineMiddleware } from "astro:middleware";
import { getRequestContext } from "emdash/request-context";

const FINALIZER_NONCE = "outer-finalizer";

function preNextState(locals: App.Locals): string {
	return JSON.stringify({
		emdash: locals.emdash !== undefined,
		user: locals.user !== undefined,
		requestContext: getRequestContext() !== undefined,
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const state = preNextState(context.locals);

	if (context.url.pathname === "/outer-cache-hit") {
		return new Response("cached before EmDash initialization", {
			headers: {
				"Content-Type": "text/plain",
				"X-Outer-Pre-Next-State": state,
				"X-Outer-Request-Path": context.url.pathname,
			},
		});
	}

	const response = await next();
	if (context.request.headers.get("X-Outer-Finalize") !== "1") return response;

	const html = (await response.text()).replaceAll(
		"<script>",
		`<script nonce="${FINALIZER_NONCE}">`,
	);
	const headers = new Headers(response.headers);
	headers.set("Content-Security-Policy", `script-src 'nonce-${FINALIZER_NONCE}'`);
	headers.set("Content-Length", String(new TextEncoder().encode(html).byteLength));
	headers.set("X-Outer-Pre-Next-State", state);
	headers.set("X-Outer-Saw-Toolbar", String(html.includes('id="emdash-toolbar"')));

	return new Response(html, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
});
