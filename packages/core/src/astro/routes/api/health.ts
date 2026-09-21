import type { APIRoute } from "astro";

import { apiSuccess } from "#api/error.js";

import { getRegistryConfigInput } from "../../../registry/config.js";
import { VERSION } from "../../../version.js";

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
	const response = apiSuccess({
		product: "emdash",
		version: VERSION,
		registry: Boolean(
			getRegistryConfigInput(
				locals.emdash?.config.registry,
				locals.emdash?.config.experimental?.registry,
			),
		),
	});
	response.headers.set("Access-Control-Allow-Origin", "*");
	return response;
};
