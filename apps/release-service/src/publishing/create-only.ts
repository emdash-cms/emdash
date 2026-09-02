// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers -- registers com.atproto.repo RPC types
import type {} from "@atcute/atproto";
import { Client, ok, type FetchHandlerObject } from "@atcute/client";
import type { Blob } from "@atcute/lexicons/interfaces";
import { isCid, isDid } from "@atcute/lexicons/syntax";
import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";

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
	readonly code: "CREATE_INPUT_INVALID" | "CREATE_RESPONSE_INVALID";

	constructor(code: CreateReleaseError["code"]) {
		super(code);
		this.name = "CreateReleaseError";
		this.code = code;
	}
}

export async function createReleaseRecord(
	session: FetchHandlerObject,
	input: CreateReleaseInput,
): Promise<CreatedRelease> {
	if (
		!DID_PATTERN.test(input.publisherDid) ||
		!isDid(input.publisherDid) ||
		!RKEY_PATTERN.test(input.rkey) ||
		input.rkey !== `${input.record.package}:${input.record.version}`
	) {
		throw new CreateReleaseError("CREATE_INPUT_INVALID");
	}
	const client = new Client({ handler: session });
	const result = await ok(
		client.post("com.atproto.repo.createRecord", {
			input: {
				repo: input.publisherDid,
				collection: NSID.packageRelease,
				rkey: input.rkey,
				record: input.record,
				validate: true,
			},
		}),
	);
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
