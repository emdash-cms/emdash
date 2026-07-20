export function xrpcError(
	error: string,
	message: string,
	status: number,
	headers?: HeadersInit,
): Response {
	return Response.json({ error, message }, { status, headers });
}
