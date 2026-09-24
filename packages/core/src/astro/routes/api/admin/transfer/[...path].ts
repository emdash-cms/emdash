/**
 * Site transfer API: /_emdash/api/admin/transfer/*
 *
 * One injected route serves the whole transfer API. Each endpoint lives in
 * its own module beside this file and is loaded only when a request reaches
 * it, so sites that never use site transfer don't compile it.
 */

import type { APIContext, APIRoute } from "astro";

import { apiError } from "#api/error.js";

export const prerender = false;

type TransferRouteModule = Partial<Record<"GET" | "HEAD" | "POST" | "PUT" | "DELETE", APIRoute>>;

interface TransferRoute {
	pattern: RegExp;
	params: readonly string[];
	load: () => Promise<TransferRouteModule>;
}

const TRANSFER_ROUTES: readonly TransferRoute[] = [
	{ pattern: /^capabilities$/, params: [], load: () => import("./capabilities.js") },
	{ pattern: /^approvals$/, params: [], load: () => import("./approvals/index.js") },
	{
		pattern: /^approvals\/([^/]+)\/approve$/,
		params: ["id"],
		load: () => import("./approvals/[id]/approve.js"),
	},
	{
		pattern: /^approvals\/([^/]+)\/deny$/,
		params: ["id"],
		load: () => import("./approvals/[id]/deny.js"),
	},
	{ pattern: /^exports$/, params: [], load: () => import("./exports/index.js") },
	{ pattern: /^exports\/([^/]+)$/, params: ["id"], load: () => import("./exports/[id]/index.js") },
	{
		pattern: /^exports\/([^/]+)\/advance$/,
		params: ["id"],
		load: () => import("./exports/[id]/advance.js"),
	},
	{
		pattern: /^exports\/([^/]+)\/manifest$/,
		params: ["id"],
		load: () => import("./exports/[id]/manifest.js"),
	},
	{
		pattern: /^exports\/([^/]+)\/archive$/,
		params: ["id"],
		load: () => import("./exports/[id]/archive.js"),
	},
	{
		pattern: /^exports\/([^/]+)\/files\/(.+)$/,
		params: ["id", "path"],
		load: () => import("./exports/[id]/files/[...path].js"),
	},
	{ pattern: /^imports$/, params: [], load: () => import("./imports/index.js") },
	{ pattern: /^imports\/([^/]+)$/, params: ["id"], load: () => import("./imports/[id]/index.js") },
	{
		pattern: /^imports\/([^/]+)\/missing$/,
		params: ["id"],
		load: () => import("./imports/[id]/missing.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/files\/(.+)$/,
		params: ["id", "path"],
		load: () => import("./imports/[id]/files/[...path].js"),
	},
	{
		pattern: /^imports\/([^/]+)\/analyze$/,
		params: ["id"],
		load: () => import("./imports/[id]/analyze.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/plan$/,
		params: ["id"],
		load: () => import("./imports/[id]/plan.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/cancel$/,
		params: ["id"],
		load: () => import("./imports/[id]/cancel.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/abandon$/,
		params: ["id"],
		load: () => import("./imports/[id]/abandon.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/execute$/,
		params: ["id"],
		load: () => import("./imports/[id]/execute.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/advance$/,
		params: ["id"],
		load: () => import("./imports/[id]/advance.js"),
	},
	{
		pattern: /^imports\/([^/]+)\/receipt$/,
		params: ["id"],
		load: () => import("./imports/[id]/receipt.js"),
	},
];

function isRouteMethod(method: string): method is keyof TransferRouteModule {
	return (
		method === "GET" ||
		method === "HEAD" ||
		method === "POST" ||
		method === "PUT" ||
		method === "DELETE"
	);
}

const handleRequest: APIRoute = async (context) => {
	const path = context.params.path ?? "";
	for (const route of TRANSFER_ROUTES) {
		const match = route.pattern.exec(path);
		if (!match) continue;
		const params: Record<string, string> = {};
		route.params.forEach((name, index) => {
			params[name] = match[index + 1] ?? "";
		});
		const module = await route.load();
		const method = context.request.method.toUpperCase();
		const handler = isRouteMethod(method) ? module[method] : undefined;
		if (!handler) return apiError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
		const routeContext = new Proxy(context, {
			get: (target, property) =>
				property === "params" ? params : Reflect.get(target, property, target),
		}) satisfies APIContext;
		return handler(routeContext);
	}
	return apiError("NOT_FOUND", "Not found", 404);
};

export const GET = handleRequest;
export const HEAD = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
