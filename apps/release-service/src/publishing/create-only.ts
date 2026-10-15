// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers -- registers com.atproto.repo RPC types
import type {} from "@atcute/atproto";
import { Client, ClientResponseError, ok, type FetchHandlerObject } from "@atcute/client";
import { safeParse } from "@atcute/lexicons";
import type { Blob } from "@atcute/lexicons/interfaces";
import { isCid, isDid } from "@atcute/lexicons/syntax";
import { NSID, PackageRelease } from "@emdash-cms/registry-lexicons";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const RKEY_PATTERN = /^[A-Za-z0-9._:~-]{1,512}$/;

export interface CreateReleaseInput {
	publisherDid: string;
	rkey: string;
	record: PackageRelease.Main;
}

export interface CreatedRelease {
	uri: string;
	cid: string;
}

export class CreateReleaseError extends Error {
	readonly code:
		| "CREATE_INPUT_INVALID"
		| "CREATE_RESPONSE_INVALID"
		| "PDS_RECORD_INVALID"
		| "PDS_AUTHORIZATION_FAILED"
		| "PDS_RATE_LIMITED"
		| "PDS_UNAVAILABLE"
		| "PDS_WRITE_FAILED";
	readonly status?: number;
	readonly pdsError?: string;

	constructor(code: CreateReleaseError["code"], response?: ClientResponseError) {
		super(code);
		this.name = "CreateReleaseError";
		this.code = code;
		if (response) {
			this.status = response.status;
			this.pdsError = [
				"InvalidRecord",
				"InvalidRequest",
				"Unauthorized",
				"Forbidden",
				"ExpiredToken",
				"InvalidToken",
				"RateLimitExceeded",
				"InternalServerError",
				"UpstreamFailure",
			].includes(response.error)
				? response.error
				: "UnknownError";
		}
	}
}

export async function createReleaseRecord(
	session: FetchHandlerObject,
	input: CreateReleaseInput,
): Promise<CreatedRelease> {
	if (
		!DID_PATTERN.test(input.publisherDid) ||
		!isDid(input.publisherDid) ||
		!safeParse(PackageRelease.mainSchema, input.record, { strict: true }).ok ||
		!RKEY_PATTERN.test(input.rkey) ||
		input.rkey !== `${input.record.package}:${input.record.version}`
	) {
		throw new CreateReleaseError("CREATE_INPUT_INVALID");
	}
	const client = new Client({ handler: session });
	let result;
	try {
		result = await ok(
			client.post("com.atproto.repo.createRecord", {
				input: {
					repo: input.publisherDid,
					collection: NSID.packageRelease,
					rkey: input.rkey,
					record: input.record,
					// PDSes without dynamic lexicon resolution reject externally published schemas.
					validate: false,
				},
			}),
		);
	} catch (error) {
		if (!(error instanceof ClientResponseError)) throw error;
		const code =
			error.status === 401 || error.status === 403
				? "PDS_AUTHORIZATION_FAILED"
				: error.status === 429
					? "PDS_RATE_LIMITED"
					: error.status >= 500
						? "PDS_UNAVAILABLE"
						: error.error === "InvalidRecord"
							? "PDS_RECORD_INVALID"
							: "PDS_WRITE_FAILED";
		throw new CreateReleaseError(code, error);
	}
	const expectedUri = `at://${input.publisherDid}/${NSID.packageRelease}/${input.rkey}`;
	if (result.uri !== expectedUri || typeof result.cid !== "string" || !isCid(result.cid)) {
		throw new CreateReleaseError("CREATE_RESPONSE_INVALID");
	}
	return { uri: result.uri, cid: result.cid };
}

export async function uploadReleaseBlob(
	session: FetchHandlerObject,
	bytes: Uint8Array,
	mimeType: string,
): Promise<Blob> {
	const client = new Client({ handler: session });
	const result = await ok(
		client.post("com.atproto.repo.uploadBlob", {
			headers: { "content-type": mimeType },
			input: bytes,
		}),
	);
	return result.blob;
}
