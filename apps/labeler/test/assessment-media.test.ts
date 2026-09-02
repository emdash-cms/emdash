import type { CanonicalMediaDescriptor } from "@emdash-cms/registry-moderation";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { describe, expect, it, vi } from "vitest";

import {
	acquireDisplayMediaSet,
	createFailClosedNativeFetchMediaTransport,
	createGuardedMediaAcquirer,
	createPinnedMediaTransport,
	isPublicAddress,
	type DisplayMediaAcquirer,
	type GuardedMediaAcquirerOptions,
	type VerifiedDisplayMedia,
} from "../src/assessment/media.js";
import { PNG_BYTES, RELEASE_CID, RELEASE_URI } from "./assessment-fixtures.js";

const SUBJECT = { uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" } as const;
const PUBLIC_ADDRESS = "203.0.113.8";

function createOptions(
	overrides: Partial<GuardedMediaAcquirerOptions> = {},
): GuardedMediaAcquirerOptions {
	return {
		resolver: {
			async resolve() {
				return [PUBLIC_ADDRESS];
			},
		},
		transport: {
			async fetch() {
				return {
					response: new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
					connectedAddress: PUBLIC_ADDRESS,
				};
			},
		},
		decoder: {
			async decode() {
				return { mimeType: "image/png", width: 1, height: 1, frames: 1 };
			},
		},
		store: {
			async put(input) {
				return { contentRef: "quarantine://release/icon", contentAddress: input.contentAddress };
			},
		},
		...overrides,
	};
}

async function iconDescriptor(): Promise<CanonicalMediaDescriptor> {
	const checksum = await computeMultihash(PNG_BYTES);
	if (!checksum.success) throw new Error("test checksum could not be computed");
	return {
		kind: "icon",
		index: 0,
		url: "https://media.example/icon.png",
		checksum: checksum.value,
		contentType: "image/png",
		width: 1,
		height: 1,
	};
}

describe("guarded display media acquisition", () => {
	it("pins each manual request and stores content-addressed bytes idempotently", async () => {
		const connector = vi.fn(async (input) => ({
			response: new Response(PNG_BYTES),
			connectedAddress: input.allowedAddresses[0] ?? "",
		}));
		const stored: Array<{ idempotencyKey: string; contentAddress: string }> = [];
		const acquirer = createGuardedMediaAcquirer(
			createOptions({
				transport: createPinnedMediaTransport({ fetch: connector }),
				store: {
					async put(input) {
						stored.push({
							idempotencyKey: input.idempotencyKey,
							contentAddress: input.contentAddress,
						});
						return {
							contentRef: `quarantine://${input.contentAddress}`,
							contentAddress: input.contentAddress,
						};
					},
				},
			}),
		);
		const descriptor = await iconDescriptor();
		const first = await acquirer.acquire(SUBJECT, descriptor);
		const retry = await acquirer.acquire(SUBJECT, descriptor);
		expect(connector).toHaveBeenCalledTimes(2);
		expect(connector.mock.calls[0]?.[0].init.redirect).toBe("manual");
		expect(stored[0]).toEqual(stored[1]);
		expect(first.contentAddress).toMatch(/^sha256:/);
		expect(retry).toEqual(first);
	});

	it("fails closed when only native fetch is available", async () => {
		const acquirer = createGuardedMediaAcquirer(
			createOptions({ transport: createFailClosedNativeFetchMediaTransport() }),
		);
		await expect(acquirer.acquire(SUBJECT, await iconDescriptor())).rejects.toThrow(/DNS pinning/);
	});

	it("does not decode or store bytes that fail the signed checksum", async () => {
		const other = await computeMultihash(new TextEncoder().encode("not the image"));
		if (!other.success) throw new Error("test checksum could not be computed");
		const decode = vi.fn(async () => ({
			mimeType: "image/png",
			width: 1,
			height: 1,
			frames: 1,
		}));
		const store = vi.fn();
		const acquirer = createGuardedMediaAcquirer(
			createOptions({ decoder: { decode }, store: { put: store } }),
		);
		await expect(
			acquirer.acquire(SUBJECT, { ...(await iconDescriptor()), checksum: other.value }),
		).rejects.toThrow(/checksum/);
		expect(decode).not.toHaveBeenCalled();
		expect(store).not.toHaveBeenCalled();
	});

	it("cancels redirect bodies and rejects a redirect to a private address", async () => {
		let cancelled = false;
		const redirectBody = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		const fetch = vi.fn(async () => ({
			response: new Response(redirectBody, {
				status: 302,
				headers: { location: "https://metadata.internal/icon.png" },
			}),
			connectedAddress: PUBLIC_ADDRESS,
		}));
		const acquirer = createGuardedMediaAcquirer(
			createOptions({
				resolver: {
					async resolve(hostname) {
						return hostname === "media.example" ? [PUBLIC_ADDRESS] : ["169.254.169.254"];
					},
				},
				transport: { fetch },
			}),
		);
		await expect(acquirer.acquire(SUBJECT, await iconDescriptor())).rejects.toThrow(
			/public addresses/,
		);
		expect(cancelled).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		expect(isPublicAddress("127.0.0.1")).toBe(false);
		expect(isPublicAddress("169.254.169.254")).toBe(false);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
	});

	it.each([
		"https://trap.invalid/package.tgz",
		"https://trap.invalid/sbom",
		"https://trap.invalid/provenance",
	])("rejects a redirect to the fragment-insensitive never-fetch target %s", async (target) => {
		const fetch = vi.fn(async () => ({
			response: new Response(null, {
				status: 302,
				headers: { location: `${target}#redirect-fragment` },
			}),
			connectedAddress: PUBLIC_ADDRESS,
		}));
		const acquirer = createGuardedMediaAcquirer(createOptions({ transport: { fetch } }));
		await expect(
			acquirer.acquire(SUBJECT, await iconDescriptor(), {
				neverFetchUrls: new Set([target]),
			}),
		).rejects.toThrow(/never-fetch/);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("rejects an initial never-fetch target before transport", async () => {
		const fetch = vi.fn();
		const descriptor = await iconDescriptor();
		const acquirer = createGuardedMediaAcquirer(createOptions({ transport: { fetch } }));
		await expect(
			acquirer.acquire(SUBJECT, descriptor, {
				neverFetchUrls: new Set([`${descriptor.url}#another-fragment`]),
			}),
		).rejects.toThrow(/never-fetch/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects non-default HTTPS ports before the pinned transport", async () => {
		const fetch = vi.fn();
		const descriptor = await iconDescriptor();
		const acquirer = createGuardedMediaAcquirer(createOptions({ transport: { fetch } }));
		await expect(
			acquirer.acquire(SUBJECT, { ...descriptor, url: "https://media.example:8443/icon.png" }),
		).rejects.toThrow(/port 443/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses one deadline through resolution, fetch, decode, and storage", async () => {
		const deadlines: number[] = [];
		const signals: AbortSignal[] = [];
		const acquirer = createGuardedMediaAcquirer(
			createOptions({
				resolver: {
					async resolve(_hostname, options) {
						deadlines.push(options.deadline);
						signals.push(options.signal);
						return [PUBLIC_ADDRESS];
					},
				},
				transport: {
					async fetch(input) {
						deadlines.push(input.deadline);
						signals.push(input.signal);
						return { response: new Response(PNG_BYTES), connectedAddress: PUBLIC_ADDRESS };
					},
				},
				decoder: {
					async decode(_bytes, limits) {
						deadlines.push(limits.deadline);
						signals.push(limits.signal);
						return { mimeType: "image/png", width: 1, height: 1, frames: 1 };
					},
				},
				store: {
					async put(input) {
						deadlines.push(input.deadline);
						signals.push(input.signal);
						return {
							contentRef: "quarantine://deadline",
							contentAddress: input.contentAddress,
						};
					},
				},
			}),
		);
		await acquirer.acquire(SUBJECT, await iconDescriptor());
		expect(new Set(deadlines).size).toBe(1);
		expect(new Set(signals).size).toBe(1);
	});

	it("bounds set concurrency and enforces aggregate budgets", async () => {
		let active = 0;
		let maximumActive = 0;
		const acquirer: DisplayMediaAcquirer = {
			async acquire(_subject, descriptor, context) {
				const reservation = context?.budget?.reserve(10);
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				reservation?.commit({ bytes: 10, pixels: 1, frames: 1 });
				return mediaResult(descriptor);
			},
		};
		const descriptors = [0, 1, 2, 3].map((index) => ({
			kind: "screenshot" as const,
			index,
			url: `https://media.example/${index}.png`,
			checksum: `bafy${index}`,
		}));
		await acquireDisplayMediaSet(SUBJECT, descriptors, acquirer, {
			maxConcurrency: 2,
			maxAggregateBytes: 100,
		});
		expect(maximumActive).toBe(2);
		await expect(
			acquireDisplayMediaSet(SUBJECT, descriptors, acquirer, {
				maxConcurrency: 2,
				maxAggregateBytes: 25,
			}),
		).rejects.toThrow(/byte budget|aggregate budget/);
	});
});

function mediaResult(descriptor: CanonicalMediaDescriptor): VerifiedDisplayMedia {
	return {
		kind: descriptor.kind,
		index: descriptor.index,
		sha256: "11".repeat(32),
		mimeType: "image/png",
		byteLength: 10,
		width: 1,
		height: 1,
		frames: 1,
		contentAddress: `sha256:${"11".repeat(32)}`,
		contentRef: `quarantine://${descriptor.index}`,
	};
}
