/** Decode the HTTP transport used by the workerd route wrapper. */
export async function readRouteResponse(response: Response): Promise<unknown> {
	if (response.headers.get("X-EmDash-Raw-Response") !== "1") return response.json();

	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		typeof value.status !== "number" ||
		!("statusText" in value) ||
		typeof value.statusText !== "string" ||
		!("headers" in value) ||
		!Array.isArray(value.headers) ||
		!("body" in value) ||
		(value.body !== null && !Array.isArray(value.body))
	) {
		throw new Error("Invalid sandbox route response");
	}
	const headers = new Headers();
	for (const entry of value.headers) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			typeof entry[1] !== "string"
		) {
			throw new Error("Invalid sandbox route response headers");
		}
		headers.append(entry[0], entry[1]);
	}
	let body: Uint8Array<ArrayBuffer> | null = null;
	if (value.body !== null) {
		const bytes: number[] = [];
		for (const byte of value.body) {
			if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
				throw new Error("Invalid sandbox route response body");
			}
			bytes.push(byte);
		}
		body = new Uint8Array(bytes);
	}
	return new Response(body, { status: value.status, statusText: value.statusText, headers });
}
