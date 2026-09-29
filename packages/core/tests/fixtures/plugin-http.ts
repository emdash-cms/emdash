export const INVALID_PLUGIN_HTTP_BYTES = new Uint8Array([
	0x00, 0xff, 0xc3, 0x28, 0x89, 0x50, 0x4e, 0x47,
]);
export const PLUGIN_HTTP_FORM_BYTES = new TextEncoder().encode("event=publish&locale=en");
export const PLUGIN_HTTP_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";

export function pluginHttpFormBody(): URLSearchParams {
	return new URLSearchParams([
		["event", "publish"],
		["locale", "en"],
	]);
}

export function chunkedBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

export function bytesOverLimit(limit: number): ReadableStream<Uint8Array> {
	const chunk = new Uint8Array(64 * 1024);
	let remaining = limit + 1;
	return new ReadableStream({
		pull(controller) {
			if (remaining === 0) {
				controller.close();
				return;
			}
			const size = Math.min(remaining, chunk.byteLength);
			controller.enqueue(chunk.subarray(0, size));
			remaining -= size;
		},
	});
}
