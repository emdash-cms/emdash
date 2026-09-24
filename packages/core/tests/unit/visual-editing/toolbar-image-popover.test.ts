// @vitest-environment jsdom

import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { apiError, apiSuccess } from "../../../src/api/error.js";
import { renderToolbar } from "../../../src/visual-editing/toolbar.js";

const LABELS = {
	publish: "Publish",
	publishing: "Publishing…",
	sessionExpired: "Editing session expired.",
	refreshPage: "Refresh page",
	publishFailed: "Publish failed.",
	editMode: "Edit mode",
	openInAdmin: "Open in admin",
	hideToolbar: "Hide toolbar",
};

const ENTRY_URL = "/_emdash/api/content/posts/post-1";
const HERO_SRC = "/_emdash/api/media/file/01HEROORIGINAL.jpg";

interface RecordedRequest {
	method: string;
	url: string;
	body: unknown;
}

type Routes = Record<string, () => Response>;

function mediaItem(id: string, filename: string) {
	const storageKey = `${id}.png`;
	return {
		id,
		filename,
		mimeType: "image/png",
		size: 2048,
		width: 640,
		height: 480,
		focalX: null,
		focalY: null,
		alt: null,
		caption: null,
		storageKey,
		status: "ready",
		contentHash: null,
		blurhash: null,
		dominantColor: null,
		createdAt: "2026-09-24T00:00:00.000Z",
		authorId: "user-1",
		url: `/_emdash/api/media/file/${storageKey}`,
	};
}

const entryRoutes: Routes = {
	"GET /_emdash/api/manifest": () =>
		apiSuccess({
			collections: {
				posts: { label: "Posts", fields: { featured_image: { kind: "image", label: "Image" } } },
			},
		}),
	[`GET ${ENTRY_URL}`]: () =>
		apiSuccess({
			item: {
				id: "post-1",
				slug: "hello",
				status: "published",
				data: {
					title: "Hello",
					featured_image: { id: "01HEROORIGINAL", provider: "local", src: HERO_SRC, alt: "Hero" },
				},
			},
			_rev: "rev-1",
		}),
	[`PUT ${ENTRY_URL}`]: () =>
		apiSuccess({ item: { id: "post-1", status: "published" }, _rev: "rev-2" }),
};

// jsdom never decodes images, so load events have to be simulated for the
// dimension probe that runs before an upload.
class DecodedImage {
	naturalWidth = 640;
	naturalHeight = 480;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	#src = "";

	get src(): string {
		return this.#src;
	}

	set src(value: string) {
		this.#src = value;
		queueMicrotask(() => this.onload?.());
	}
}

function mountEditablePage(routes: Routes) {
	const doc = document.implementation.createHTMLDocument("Post");
	const hero = doc.createElement("div");
	hero.setAttribute(
		"data-emdash-ref",
		JSON.stringify({ collection: "posts", id: "post-1", field: "featured_image" }),
	);
	const heroImg = doc.createElement("img");
	heroImg.setAttribute("src", HERO_SRC);
	heroImg.setAttribute("alt", "Hero");
	hero.append(heroImg);
	doc.body.append(hero);
	doc.body.insertAdjacentHTML(
		"beforeend",
		renderToolbar({ editMode: true, isPreview: false, labels: LABELS }),
	);

	const requests: RecordedRequest[] = [];
	const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const method = init.method ?? "GET";
		requests.push({ method, url, body: init.body });
		const respond = routes[`${method} ${url}`];
		if (!respond) throw new Error(`Unexpected request: ${method} ${url}`);
		return respond();
	};

	const script = doc.querySelector("script")?.textContent;
	if (!script) throw new Error("Toolbar script was not rendered");
	runInNewContext(script, {
		document: doc,
		window,
		localStorage,
		fetch,
		FormData,
		Image: DecodedImage,
		URL: { createObjectURL: () => "blob:upload", revokeObjectURL: () => {} },
		setTimeout,
		clearTimeout,
		console,
	});

	return { doc, heroImg, requests };
}

async function openImagePopover(page: ReturnType<typeof mountEditablePage>): Promise<HTMLElement> {
	page.heroImg.click();
	return vi.waitFor(() => {
		const popover = page.doc.querySelector<HTMLElement>(".emdash-img-popover");
		if (!popover) throw new Error("Image popover did not open");
		return popover;
	});
}

function savedImage(requests: RecordedRequest[]): unknown {
	const save = requests.find((request) => request.method === "PUT" && request.url === ENTRY_URL);
	if (typeof save?.body !== "string") return undefined;
	return JSON.parse(save.body).data.featured_image;
}

describe("toolbar image popover", () => {
	it("puts an uploaded image into the field", async () => {
		const uploaded = mediaItem("01UPLOADED", "new-hero.png");
		const page = mountEditablePage({
			...entryRoutes,
			"POST /_emdash/api/media": () => apiSuccess({ item: uploaded }, 201),
		});
		const popover = await openImagePopover(page);

		const input = popover.querySelector<HTMLInputElement>("#emdash-img-upload")!;
		const file = new File([new Uint8Array([137, 80, 78, 71])], "new-hero.png", {
			type: "image/png",
		});
		Object.defineProperty(input, "files", { value: [file] });
		input.dispatchEvent(new Event("change"));

		const saveStatus = page.doc.getElementById("emdash-tb-save-status")!;
		await vi.waitFor(() => expect(saveStatus.textContent).toBe("Saved"));

		const uploads = page.requests.filter((request) => request.method === "POST");
		expect(uploads).toHaveLength(1);
		const uploadBody = uploads[0]?.body;
		if (!(uploadBody instanceof FormData)) throw new Error("Upload was not sent as form data");
		expect(uploadBody.get("file")).toBe(file);
		expect(savedImage(page.requests)).toMatchObject({ id: uploaded.id, src: uploaded.url });
		expect(page.heroImg.getAttribute("src")).toBe(uploaded.url);
		expect(page.doc.querySelector(".emdash-img-popover")).toBeNull();
	});

	it("lists the media library and puts the chosen image into the field", async () => {
		const first = mediaItem("01LIBRARYFIRST", "first.png");
		const second = mediaItem("01LIBRARYSECOND", "second.png");
		const page = mountEditablePage({
			...entryRoutes,
			"GET /_emdash/api/media?mimeType=image/&limit=30": () =>
				apiSuccess({ items: [first, second], totalCount: 2 }),
		});
		const popover = await openImagePopover(page);

		popover.querySelector<HTMLButtonElement>('[data-action="browse"]')!.click();

		const thumbnails = () =>
			Array.from(popover.querySelectorAll(".emdash-img-grid-item img"), (img) =>
				img.getAttribute("src"),
			);
		await vi.waitFor(() => expect(thumbnails()).toEqual([first.url, second.url]));
		expect(popover.textContent).not.toContain("No images found");

		popover.querySelectorAll<HTMLElement>(".emdash-img-grid-item")[1]!.click();

		await vi.waitFor(() => expect(page.heroImg.getAttribute("src")).toBe(second.url));
		expect(savedImage(page.requests)).toMatchObject({ id: second.id, src: second.url });
	});

	it("reports a rejected media library request as a load failure", async () => {
		const page = mountEditablePage({
			...entryRoutes,
			"GET /_emdash/api/media?mimeType=image/&limit=30": () =>
				apiError("FORBIDDEN", "Insufficient permissions", 403),
		});
		const popover = await openImagePopover(page);

		popover.querySelector<HTMLButtonElement>('[data-action="browse"]')!.click();

		const browser = popover.querySelector<HTMLElement>(".emdash-img-browser")!;
		await vi.waitFor(() => expect(browser.textContent).toContain("Failed to load media"));
		expect(browser.textContent).not.toContain("No images found");
	});
});
