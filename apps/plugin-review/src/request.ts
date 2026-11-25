import type { PluginReviewRequest, ReviewFile } from "./types.js";

const MAX_FILES = 64;

export class InvalidReviewRequestError extends Error {
	override readonly name = "InvalidReviewRequestError";
}

export function parseRequest(value: unknown): PluginReviewRequest {
	if (!isRecord(value)) throw new InvalidReviewRequestError("request must be an object");
	const { model, subject, listing, declaredAccess, files } = value;
	if (typeof model !== "string" || model.length === 0) {
		throw new InvalidReviewRequestError("model is required");
	}
	if (
		!isRecord(subject) ||
		typeof subject["uri"] !== "string" ||
		typeof subject["cid"] !== "string" ||
		typeof subject["version"] !== "string"
	) {
		throw new InvalidReviewRequestError("subject needs uri, cid and version");
	}
	if (
		!Array.isArray(listing) ||
		!listing.every(
			(item) =>
				isRecord(item) && typeof item["ref"] === "string" && typeof item["text"] === "string",
		)
	) {
		throw new InvalidReviewRequestError("listing must be a list of { ref, text }");
	}
	if (!isRecord(declaredAccess))
		throw new InvalidReviewRequestError("declaredAccess must be an object");
	if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
		throw new InvalidReviewRequestError(`files must list between 1 and ${MAX_FILES} files`);
	}
	const paths = new Set<string>();
	const reviewFiles: ReviewFile[] = files.map((file) => {
		if (
			!isRecord(file) ||
			typeof file["path"] !== "string" ||
			typeof file["byteLength"] !== "number" ||
			(file["text"] !== undefined && typeof file["text"] !== "string")
		) {
			throw new InvalidReviewRequestError("each file needs a path, a byteLength and optional text");
		}
		if (paths.has(file["path"]))
			throw new InvalidReviewRequestError(`duplicate file ${file["path"]}`);
		paths.add(file["path"]);
		return {
			path: file["path"],
			byteLength: file["byteLength"],
			...(typeof file["text"] === "string" ? { text: file["text"] } : {}),
		};
	});
	return {
		model,
		subject: { uri: subject["uri"], cid: subject["cid"], version: subject["version"] },
		listing: listing.map((item) => ({ ref: String(item["ref"]), text: String(item["text"]) })),
		declaredAccess,
		files: reviewFiles,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
