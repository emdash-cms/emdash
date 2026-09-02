import {
	getPublicKeyFromDidController,
	P256PublicKey,
	Secp256k1PublicKey,
	type PublicKey,
} from "@atcute/crypto";
import { getAtprotoVerificationMaterial, getPdsEndpoint } from "@atcute/identity";
import type { DidDocument } from "@atcute/identity";
import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { AtprotoDid, Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import { safeParse } from "@atcute/lexicons/validations";
import { fromStream, verifyRecord } from "@atcute/repo";
import { NSID, PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";

export const DEFAULT_DIRECT_PDS_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DIGITS = /^[0-9]+$/;
const PACKAGE_SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

export type DirectPdsReadErrorCode =
	| "DID_DOCUMENT_INVALID"
	| "DID_RESOLUTION_FAILED"
	| "DID_SIGNING_KEY_INVALID"
	| "DID_SIGNING_KEY_MISSING"
	| "PDS_ENDPOINT_INVALID"
	| "PDS_ENDPOINT_MISSING"
	| "PDS_REQUEST_ABORTED"
	| "PDS_REQUEST_FAILED"
	| "PDS_REQUEST_TIMEOUT"
	| "PDS_RESPONSE_TYPE_INVALID"
	| "PDS_RESPONSE_TOO_LARGE"
	| "PROFILE_LEXICON_INVALID"
	| "RECORD_NOT_FOUND"
	| "RECORD_PROOF_INVALID"
	| "REPOSITORY_NOT_FOUND"
	| "RELEASE_LEXICON_INVALID";

export class DirectPdsReadError extends Error {
	readonly code: DirectPdsReadErrorCode;
	readonly status?: number;

	constructor(code: DirectPdsReadErrorCode, message: string, status?: number) {
		super(message);
		this.name = "DirectPdsReadError";
		this.code = code;
		this.status = status;
	}
}

export interface DirectPdsDidDocumentResolver {
	resolve(did: Did): Promise<DidDocument>;
}

export interface DirectPdsClientOptions {
	did: string;
	/** Must enforce the caller's outbound URL and redirect policy. */
	fetch: typeof fetch;
	didDocumentResolver?: DirectPdsDidDocumentResolver;
	requestTimeoutMs?: number;
	maxResponseBytes?: number;
	signal?: AbortSignal;
}

export interface DirectPdsProfileRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageProfile.Main;
}

export interface DirectPdsReleaseRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageRelease.Main;
}

export interface DirectPdsPackageRepository {
	profile: DirectPdsProfileRecord;
	releases: readonly DirectPdsReleaseRecord[];
}

interface ResolvedPublisher {
	pds: URL;
	publicKey: PublicKey;
}

export class DirectPdsClient {
	readonly did: AtprotoDid;
	readonly #fetch: typeof fetch;
	readonly #resolver: DirectPdsDidDocumentResolver;
	#resolvedPublisher: Promise<ResolvedPublisher> | undefined;

	constructor(options: DirectPdsClientOptions) {
		if (!isAtprotoDid(options.did)) {
			throw new TypeError("did must be a valid did:plc or did:web identifier");
		}
		const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_DIRECT_PDS_REQUEST_TIMEOUT_MS;
		const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES;
		validatePositiveSafeInteger(requestTimeoutMs, "requestTimeoutMs");
		if (requestTimeoutMs > MAX_TIMEOUT_MS) {
			throw new RangeError(`requestTimeoutMs must not exceed ${MAX_TIMEOUT_MS}`);
		}
		validatePositiveSafeInteger(maxResponseBytes, "maxResponseBytes");

		this.did = options.did;
		this.#fetch = createBoundedFetch(options.fetch, {
			requestTimeoutMs,
			maxResponseBytes,
			signal: options.signal,
		});
		this.#resolver =
			options.didDocumentResolver ??
			new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver({ fetch: this.#fetch }),
					web: new AtprotoWebDidDocumentResolver({ fetch: this.#fetch }),
				},
			});
	}

	async getPackageProfile(packageSlug: string): Promise<DirectPdsProfileRecord> {
		validatePackageSlug(packageSlug);
		const record = await this.#getVerifiedRecord(NSID.packageProfile, packageSlug);
		const parsed = safeParse(PackageProfile.mainSchema, record.value);
		if (!parsed.ok) {
			throw new DirectPdsReadError(
				"PROFILE_LEXICON_INVALID",
				"The publisher repository contains a malformed package profile.",
			);
		}
		return {
			uri: `at://${this.did}/${NSID.packageProfile}/${packageSlug}`,
			cid: record.cid,
			rkey: packageSlug,
			value: parsed.value,
		};
	}

	async getPackageRelease(packageSlug: string, version: string): Promise<DirectPdsReleaseRecord> {
		validatePackageSlug(packageSlug);
		const rkey = `${packageSlug}:${version}`;
		const record = await this.#getVerifiedRecord(NSID.packageRelease, rkey);
		const parsed = safeParse(PackageRelease.mainSchema, record.value);
		if (!parsed.ok) {
			throw new DirectPdsReadError(
				"RELEASE_LEXICON_INVALID",
				"The publisher repository contains a malformed package release.",
			);
		}
		return {
			uri: `at://${this.did}/${NSID.packageRelease}/${rkey}`,
			cid: record.cid,
			rkey,
			value: parsed.value,
		};
	}

	async getPackageRepository(packageSlug: string): Promise<DirectPdsPackageRepository> {
		validatePackageSlug(packageSlug);
		const publisher = await this.#getResolvedPublisher();
		const url = new URL("/xrpc/com.atproto.sync.getRepo", publisher.pds);
		url.searchParams.set("did", this.did);
		const response = await this.#fetch(url, {
			method: "GET",
			headers: { Accept: "application/vnd.ipld.car" },
		});
		if (response.status === 404) {
			throw new DirectPdsReadError(
				"REPOSITORY_NOT_FOUND",
				"The publisher PDS does not contain the requested repository.",
				404,
			);
		}
		if (!response.ok) {
			throw new DirectPdsReadError(
				"PDS_REQUEST_FAILED",
				`The publisher PDS returned HTTP ${response.status}.`,
				response.status,
			);
		}
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		if (contentType !== "application/vnd.ipld.car") {
			throw new DirectPdsReadError(
				"PDS_RESPONSE_TYPE_INVALID",
				"The publisher PDS did not return an AT Protocol repository export.",
			);
		}
		const carBytes = new Uint8Array(await response.arrayBuffer());
		try {
			const verifiedProfile = await verifyRecord({
				did: this.did,
				collection: NSID.packageProfile,
				rkey: packageSlug,
				publicKey: publisher.publicKey,
				carBytes,
			});
			const parsedProfile = safeParse(PackageProfile.mainSchema, verifiedProfile.record);
			if (!parsedProfile.ok) {
				throw new DirectPdsReadError(
					"PROFILE_LEXICON_INVALID",
					"The publisher repository contains a malformed package profile.",
				);
			}
			const releases: DirectPdsReleaseRecord[] = [];
			const stream = new Response(carBytes).body;
			if (stream === null) throw new Error("Repository export is empty");
			for await (const entry of fromStream(stream)) {
				if (entry.collection !== NSID.packageRelease) continue;
				const prefix = `${packageSlug}:`;
				if (!entry.rkey.startsWith(prefix)) continue;
				const parsedRelease = safeParse(PackageRelease.mainSchema, entry.record);
				if (
					!parsedRelease.ok ||
					parsedRelease.value.package !== packageSlug ||
					entry.rkey !== `${packageSlug}:${parsedRelease.value.version}`
				) {
					throw new DirectPdsReadError(
						"RELEASE_LEXICON_INVALID",
						"The publisher repository contains a malformed package release.",
					);
				}
				releases.push({
					uri: `at://${this.did}/${NSID.packageRelease}/${entry.rkey}`,
					cid: entry.cid.$link,
					rkey: entry.rkey,
					value: parsedRelease.value,
				});
			}
			return {
				profile: {
					uri: `at://${this.did}/${NSID.packageProfile}/${packageSlug}`,
					cid: verifiedProfile.cid,
					rkey: packageSlug,
					value: parsedProfile.value,
				},
				releases,
			};
		} catch (error) {
			if (error instanceof DirectPdsReadError) throw error;
			throw new DirectPdsReadError(
				"RECORD_PROOF_INVALID",
				"The publisher repository export or commit signature is invalid.",
			);
		}
	}

	async #getResolvedPublisher(): Promise<ResolvedPublisher> {
		this.#resolvedPublisher ??= this.#resolvePublisher();
		const pendingPublisher = this.#resolvedPublisher;
		try {
			return await pendingPublisher;
		} catch (error) {
			if (this.#resolvedPublisher === pendingPublisher) this.#resolvedPublisher = undefined;
			throw error;
		}
	}

	async #resolvePublisher(): Promise<ResolvedPublisher> {
		let document: DidDocument;
		try {
			document = await this.#resolver.resolve(this.did);
		} catch (error) {
			if (error instanceof DirectPdsReadError) throw error;
			throw new DirectPdsReadError(
				"DID_RESOLUTION_FAILED",
				"The publisher DID document could not be resolved.",
			);
		}
		if (document.id !== this.did) {
			throw new DirectPdsReadError(
				"DID_DOCUMENT_INVALID",
				"The resolved DID document does not match the publisher DID.",
			);
		}
		const endpoint = getPdsEndpoint(document);
		if (!endpoint) {
			throw new DirectPdsReadError(
				"PDS_ENDPOINT_MISSING",
				"The publisher DID document has no AT Protocol PDS endpoint.",
			);
		}
		const pds = parsePdsEndpoint(endpoint);
		const material = getAtprotoVerificationMaterial(document);
		if (!material) {
			throw new DirectPdsReadError(
				"DID_SIGNING_KEY_MISSING",
				"The publisher DID document has no AT Protocol signing key.",
			);
		}

		try {
			const found = getPublicKeyFromDidController(material);
			if (found.type === "p256") {
				return { pds, publicKey: await P256PublicKey.importRaw(found.publicKeyBytes) };
			}
			if (found.type === "secp256k1") {
				return { pds, publicKey: await Secp256k1PublicKey.importRaw(found.publicKeyBytes) };
			}
			const exhaustive: never = found;
			throw new Error(`Unsupported signing key: ${String(exhaustive)}`);
		} catch {
			throw new DirectPdsReadError(
				"DID_SIGNING_KEY_INVALID",
				"The publisher DID document contains an unsupported signing key.",
			);
		}
	}

	async #getVerifiedRecord(
		collection: string,
		rkey: string,
	): Promise<{ cid: string; value: unknown }> {
		const publisher = await this.#getResolvedPublisher();
		const url = new URL("/xrpc/com.atproto.sync.getRecord", publisher.pds);
		url.searchParams.set("did", this.did);
		url.searchParams.set("collection", collection);
		url.searchParams.set("rkey", rkey);

		const response = await this.#fetch(url, {
			method: "GET",
			headers: { Accept: "application/vnd.ipld.car" },
		});
		if (response.status === 404) {
			throw new DirectPdsReadError(
				"RECORD_NOT_FOUND",
				"The publisher repository does not contain the requested record.",
				404,
			);
		}
		if (!response.ok) {
			throw new DirectPdsReadError(
				"PDS_REQUEST_FAILED",
				`The publisher PDS returned HTTP ${response.status}.`,
				response.status,
			);
		}
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		if (contentType !== "application/vnd.ipld.car") {
			throw new DirectPdsReadError(
				"PDS_RESPONSE_TYPE_INVALID",
				"The publisher PDS did not return an AT Protocol repository proof.",
			);
		}
		const carBytes = new Uint8Array(await response.arrayBuffer());
		try {
			const verified = await verifyRecord({
				did: this.did,
				collection,
				rkey,
				publicKey: publisher.publicKey,
				carBytes,
			});
			return { cid: verified.cid, value: verified.record };
		} catch {
			throw new DirectPdsReadError(
				"RECORD_PROOF_INVALID",
				"The publisher repository proof or commit signature is invalid.",
			);
		}
	}
}

function isAtprotoDid(value: string): value is AtprotoDid {
	return isDid(value) && (value.startsWith("did:plc:") || value.startsWith("did:web:"));
}

function parsePdsEndpoint(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidPdsEndpoint();
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw invalidPdsEndpoint();
	}
	return url;
}

function invalidPdsEndpoint(): DirectPdsReadError {
	return new DirectPdsReadError(
		"PDS_ENDPOINT_INVALID",
		"The publisher DID document contains an invalid PDS endpoint.",
	);
}

function validatePackageSlug(value: string): void {
	if (!PACKAGE_SLUG.test(value)) throw new TypeError("packageSlug is invalid");
}

interface BoundedFetchOptions {
	requestTimeoutMs: number;
	maxResponseBytes: number;
	signal?: AbortSignal;
}

function createBoundedFetch(
	fetchImplementation: typeof fetch,
	options: BoundedFetchOptions,
): typeof fetch {
	return async (input, init = {}) => {
		const controller = new AbortController();
		let timedOut = false;
		const cleanupSignals = forwardAbortSignals(
			[options.signal, init.signal].filter((signal): signal is AbortSignal => signal !== undefined),
			controller,
		);
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.requestTimeoutMs);

		try {
			if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
			const response = await withAbortSignal(
				Promise.resolve().then(() =>
					fetchImplementation(input, { ...init, signal: controller.signal }),
				),
				controller.signal,
			);
			const contentLength = response.headers.get("content-length");
			if (contentLength !== null) {
				const declaredLength = Number(contentLength);
				if (
					!DIGITS.test(contentLength) ||
					!Number.isSafeInteger(declaredLength) ||
					declaredLength > options.maxResponseBytes
				) {
					void response.body?.cancel().catch(() => undefined);
					throw responseTooLarge();
				}
			}
			const body = await readBoundedBody(
				response.body,
				options.maxResponseBytes,
				controller.signal,
			);
			return new Response(body.length === 0 ? null : body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			if (error instanceof DirectPdsReadError) throw error;
			if (timedOut) {
				throw new DirectPdsReadError("PDS_REQUEST_TIMEOUT", "The direct PDS request timed out.");
			}
			if (controller.signal.aborted) {
				throw new DirectPdsReadError("PDS_REQUEST_ABORTED", "The direct PDS request was aborted.");
			}
			throw new DirectPdsReadError("PDS_REQUEST_FAILED", "The direct PDS request failed.");
		} finally {
			clearTimeout(timeout);
			cleanupSignals();
		}
	};
}

async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (body === null) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let completed = false;
	try {
		for (;;) {
			const chunk = await withAbortSignal(reader.read(), signal);
			if (chunk.done) {
				completed = true;
				break;
			}
			length += chunk.value.length;
			if (length > maximumBytes) throw responseTooLarge();
			chunks.push(chunk.value);
		}
	} finally {
		if (!completed) void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal.aborted) {
			abort();
		} else {
			signal.addEventListener("abort", abort, { once: true });
		}
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
				return undefined;
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
				return undefined;
			},
		);
	});
}

function forwardAbortSignals(signals: AbortSignal[], controller: AbortController): () => void {
	const abort = () => controller.abort();
	for (const signal of signals) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	return () => {
		for (const signal of signals) signal.removeEventListener("abort", abort);
	};
}

function validatePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function responseTooLarge(): DirectPdsReadError {
	return new DirectPdsReadError(
		"PDS_RESPONSE_TOO_LARGE",
		"The direct PDS response exceeded its byte limit.",
	);
}
