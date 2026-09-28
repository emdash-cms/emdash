const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function getRequestId(request: Request): string {
	const supplied = request.headers.get("x-request-id");
	return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}
