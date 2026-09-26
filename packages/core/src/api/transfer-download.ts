import type { ExportFileStream } from "./handlers/transfer.js";

const DOWNLOAD_HEADERS = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
};

/** A downloaded package file: raw bytes with their size and SHA-256 ETag. */
export function exportFileResponse(file: ExportFileStream): Response {
	return new Response(file.body, {
		status: 200,
		headers: {
			...DOWNLOAD_HEADERS,
			"Content-Type":
				file.path === "manifest.json" ? "application/json" : "application/octet-stream",
			"Content-Length": String(file.bytes),
			"Content-Disposition": "attachment",
			ETag: `"${file.sha256}"`,
		},
	});
}

/** A streamed `.emdash` archive of an export. */
export function exportArchiveResponse(
	operationId: string,
	body: ReadableStream<Uint8Array>,
): Response {
	return new Response(body, {
		status: 200,
		headers: {
			...DOWNLOAD_HEADERS,
			"Content-Type": "application/x-tar",
			"Content-Disposition": `attachment; filename="emdash-site-${operationId}.emdash"`,
		},
	});
}
