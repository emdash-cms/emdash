import { z } from "zod";

const routeResponseSchema = z.object({
	status: z.number(),
	statusText: z.string(),
	headers: z.array(z.tuple([z.string(), z.string()])),
	body: z.array(z.number().int().min(0).max(255)).nullable(),
});

/** Decode the HTTP transport used by the workerd route wrapper. */
export async function readRouteResponse(response: Response): Promise<unknown> {
	if (response.headers.get("X-EmDash-Raw-Response") !== "1") return response.json();

	const value = routeResponseSchema.parse(await response.json());
	const body = value.body === null ? null : new Uint8Array(value.body);
	return new Response(body, {
		status: value.status,
		statusText: value.statusText,
		headers: value.headers,
	});
}
