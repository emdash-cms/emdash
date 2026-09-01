// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	InlinePortableTextEditor,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("inline Portable Text media picker", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("canonicalizes a legacy direct URL provider when an existing image is saved", () => {
		const pm = portableTextToPM([
			{
				_type: "image",
				_key: "external-image",
				asset: {
					_ref: "",
					url: "https://media.example/external.jpg",
					provider: "external-url",
				},
			},
		]);

		const restored = pmToPortableText(pm);
		expect((restored[0] as { asset?: { provider?: string } }).asset?.provider).toBe("external");
	});

	async function expectSavedProvider(provider: string, storedProvider: string) {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push({ url, init });
				if (url === "/_emdash/api/media/providers") {
					return Response.json({
						data: {
							items: [
								{
									id: provider,
									name: "Test Provider",
									capabilities: { browse: true, search: true, upload: true, delete: true },
								},
							],
						},
					});
				}
				if (url.startsWith(`/_emdash/api/media/providers/${provider}?`)) {
					return Response.json({
						data: {
							items: [
								{
									id: "provider-image",
									filename: "provider.jpg",
									mimeType: "image/jpeg",
									previewUrl: "https://media.example/provider.jpg",
									width: 1200,
									height: 800,
								},
							],
						},
					});
				}
				if (url.startsWith("/_emdash/api/media?")) {
					return Response.json({ data: { items: [] } });
				}
				if (url === "/_emdash/api/content/posts/post-1") {
					return new Response(null, { status: 204 });
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: [],
					collection: "posts",
					entryId: "post-1",
					field: "body",
				}),
			);
		});
		await vi.waitFor(() => expect(container.querySelector(".emdash-inline-editor")).not.toBeNull());

		await act(async () => document.dispatchEvent(new CustomEvent("emdash:open-media-picker")));
		const providerTab = await vi.waitFor(() => {
			const button = [...document.querySelectorAll("button")].find(
				(candidate) => candidate.textContent === "Test Provider",
			);
			expect(button).not.toBeUndefined();
			return button!;
		});
		await act(async () => providerTab.click());

		const providerImage = await vi.waitFor(() => {
			const button = document.querySelector<HTMLButtonElement>('button[aria-label="provider.jpg"]');
			expect(button).not.toBeNull();
			return button!;
		});
		await act(async () => providerImage.click());
		const insert = [
			...document.querySelectorAll<HTMLButtonElement>(".emdash-media-picker button"),
		].find((button) => button.textContent === "Insert");
		expect(insert).not.toBeUndefined();
		await act(async () => insert!.click());

		const saved = await vi.waitFor(() => {
			const request = requests.find(
				(candidate) => candidate.url === "/_emdash/api/content/posts/post-1",
			);
			expect(request).not.toBeUndefined();
			return request!;
		});
		const requestBody = saved.init?.body;
		expect(typeof requestBody).toBe("string");
		if (typeof requestBody !== "string") throw new TypeError("Expected a string request body");
		const body = JSON.parse(requestBody) as {
			data: { body: Array<{ asset: { provider?: string } }> };
		};
		expect(saved.init?.method).toBe("PUT");
		expect(body.data.body[0]?.asset.provider).toBe(storedProvider);
	}

	it("saves the configured provider for an inserted image", () =>
		expectSavedProvider("cloudflare-images", "cloudflare-images"));

	it("canonicalizes the legacy direct URL provider for an inserted image", () =>
		expectSavedProvider("external-url", "external"));
});
