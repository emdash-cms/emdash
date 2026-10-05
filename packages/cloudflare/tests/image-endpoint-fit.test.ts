import type { APIContext } from "astro";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { adapterGET, transform, images } = vi.hoisted(() => {
	/** Records the transform the endpoint hands to the Images binding. */
	const recordTransform = vi.fn();
	const output = vi.fn(() => ({
		response: () => new Response("bytes", { headers: { "Content-Type": "image/webp" } }),
	}));
	return {
		adapterGET: vi.fn(() => new Response("adapter", { status: 200 })),
		transform: recordTransform,
		images: {
			input: () => ({
				transform: (options: unknown) => {
					recordTransform(options);
					return { output };
				},
			}),
		},
	};
});

vi.mock("@astrojs/cloudflare/image-transform-endpoint", () => ({ GET: adapterGET }));
vi.mock("cloudflare:workers", () => ({ env: { IMAGES: images } }));

const { GET } = await import("../src/image-endpoint.js");

const storage = {
	download: async () => ({
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		}),
		contentType: "image/jpeg",
	}),
};

/** Request the endpoint the way Astro's image service does. */
function request(params: string): Promise<Response> {
	const href = encodeURIComponent("/_emdash/api/media/file/01J5ABC.webp");
	const ctx = {
		request: new Request(`https://example.com/_image?href=${href}&${params}`),
		locals: { emdash: { storage } },
	} as unknown as APIContext;
	return GET(ctx) as Promise<Response>;
}

/** The options passed to the Images binding for the most recent request. */
function lastTransform(): Record<string, unknown> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- vitest mock call args
	return transform.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
	transform.mockClear();
});

describe("Cloudflare image endpoint: fit and position", () => {
	it("crops for fit=cover instead of scaling down inside the box", async () => {
		await request("w=32&h=32&f=webp&fit=cover&position=center");

		expect(lastTransform()).toMatchObject({ width: 32, height: 32, fit: "crop" });
	});

	it("never asks the binding to enlarge, matching Astro's sharp service", async () => {
		for (const fit of ["cover", "contain", "inside", "scale-down"]) {
			await request(`w=64&h=64&fit=${fit}`);
			expect(["crop", "scale-down"]).toContain(lastTransform().fit);
		}
	});

	it("maps position to the binding's gravity vocabulary", async () => {
		await request("w=32&h=32&fit=cover&position=top");
		expect(lastTransform().gravity).toBe("top");

		// sharp spells it "centre" and calls saliency-based cropping
		// "attention"; the binding uses "center" and "auto".
		await request("w=32&h=32&fit=cover&position=centre");
		expect(lastTransform().gravity).toBe("center");

		await request("w=32&h=32&fit=cover&position=attention");
		expect(lastTransform().gravity).toBe("auto");
	});

	it("maps sharp's compass names onto the edges they mean", async () => {
		// Astro forwards sharp's vocabulary verbatim, so `position="north"`
		// reaches the endpoint and means the same edge as `top`.
		for (const [position, gravity] of [
			["north", "top"],
			["south", "bottom"],
			["east", "right"],
			["west", "left"],
		]) {
			await request(`w=32&h=32&fit=cover&position=${position}`);
			expect(lastTransform().gravity).toBe(gravity);
		}
	});

	it("maps Astro's sharp-only inside fit onto scale-down", async () => {
		await request("w=64&h=64&fit=inside");
		expect(lastTransform().fit).toBe("scale-down");
	});

	it("maps Astro's fill to the binding's squeeze", async () => {
		await request("w=64&h=64&fit=fill");
		expect(lastTransform().fit).toBe("squeeze");
	});

	it("omits fit and gravity the binding would reject rather than forwarding them", async () => {
		// `outside` resizes to exceed the box without cropping, which the binding
		// cannot express, and a compound position names a corner it has no keyword
		// for. Both are dropped so the rendition still resolves, and neither is
		// swapped for a fit that would crop.
		await request("w=64&h=64&fit=outside&position=top%20left");

		const options = lastTransform();
		expect(options.fit).toBeUndefined();
		expect(options.gravity).toBeUndefined();
		expect(options).toMatchObject({ width: 64, height: 64 });
	});

	it("leaves fit unset when the request carries none", async () => {
		await request("w=800&f=webp");
		expect(lastTransform().fit).toBeUndefined();
	});
});
