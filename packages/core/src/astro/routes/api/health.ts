import type { APIRoute } from "astro";

import { apiSuccess } from "#api/error.js";

import { VERSION } from "../../../version.js";

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
	const response = apiSuccess({
		product: "emdash",
		version: VERSION,
		registry: Boolean(locals.emdash?.config.experimental?.registry),
	});
	response.headers.set("Access-Control-Allow-Origin", "*");
	return response;
};
