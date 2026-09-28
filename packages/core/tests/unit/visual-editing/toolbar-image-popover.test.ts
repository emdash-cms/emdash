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

// Local images picked in the admin or created by a seed are stored without a
// URL; the site builds it at render time.
const STORED_HERO = {
	provider: "local",
	id: "01HEROORIGINAL",
	alt: "Harbour at dawn",
	width: 1200,
	height: 800,
	mimeType: "image/jpeg",
	filename: "hero.jpg",
	meta: { storageKey: "01HEROORIGINAL.jpg" },
};

const DARK_HERO = {
	provider: "local",
	id: "01HERODARK",
	alt: "Harbour at night",
	width: 1200,
	height: 800,
	mimeType: "image/jpeg",
	filename: "hero-dark.jpg",
	meta: { storageKey: "01HERODARK.jpg" },
};

function entryRoutesWith(featuredImage: unknown): Routes {
	return {
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
					data: { title: "Hello", featured_image: featuredImage },
				},
				_rev: "rev-1",
			}),
		[`PUT ${ENTRY_URL}`]: () =>
			apiSuccess({ item: { id: "post-1", status: "published" }, _rev: "rev-2" }),
	};
}

const entryRoutes = entryRoutesWith(STORED_HERO);

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

const HERO_SRCSET = [640, 1280]
	.map((width) => `/_image?href=${encodeURIComponent(HERO_SRC)}&w=${width} ${width}w`)
	.join(", ");
const HERO_SIZES = "(min-width: 1280px) 1280px, 100vw";

interface PageOptions {
	pageShowsImage?: boolean;
	responsive?: "srcset" | "picture";
}

function mountEditablePage(
	routes: Routes,
	{ pageShowsImage = true, responsive }: PageOptions = {},
) {
	const doc = document.implementation.createHTMLDocument("Post");
	const hero = doc.createElement("div");
	hero.setAttribute(
		"data-emdash-ref",
		JSON.stringify({ collection: "posts", id: "post-1", field: "featured_image" }),
	);
	const heroImg = doc.createElement("img");
	heroImg.setAttribute("src", HERO_SRC);
	heroImg.setAttribute("alt", STORED_HERO.alt);
	if (responsive) {
		heroImg.setAttribute("srcset", HERO_SRCSET);
		heroImg.setAttribute("sizes", HERO_SIZES);
	}
	if (responsive === "picture") {
		const picture = doc.createElement("picture");
		for (const type of ["image/avif", "image/webp"]) {
			const source = doc.createElement("source");
			source.setAttribute("type", type);
			source.setAttribute("srcset", HERO_SRCSET);
			source.setAttribute("sizes", HERO_SIZES);
			picture.append(source);
		}
		picture.append(heroImg);
		hero.append(picture);
	} else if (pageShowsImage) {
		hero.append(heroImg);
	}
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

	return { doc, hero, heroImg, requests };
}

async function openImagePopover(page: ReturnType<typeof mountEditablePage>): Promise<HTMLElement> {
	(page.heroImg.isConnected ? page.heroImg : page.hero).click();
	return vi.waitFor(() => {
		const popover = page.doc.querySelector<HTMLElement>(".emdash-img-popover");
		if (!popover) throw new Error("Image popover did not open");
		return popover;
	});
}

function chooseFileToUpload(popover: HTMLElement, file: File): void {
	const input = popover.querySelector<HTMLInputElement>("#emdash-img-upload")!;
	Object.defineProperty(input, "files", { value: [file] });
	input.dispatchEvent(new Event("change"));
}

function pngFile(name: string): File {
	return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

function savedImage(requests: RecordedRequest[]): unknown {
	const save = requests.find((request) => request.method === "PUT" && request.url === ENTRY_URL);
	if (typeof save?.body !== "string") return undefined;
	return JSON.parse(save.body).data.featured_image;
}

const LIBRARY_URL = "/_emdash/api/media?mimeType=image/&limit=30";
const UPLOADED = mediaItem("01UPLOADED", "new-hero.png");
const PICKED = mediaItem("01LIBRARYPICK", "picked.png");
const NEW_ALT = "Fishing boats in the harbour at dawn";

const replacementRoutes: Routes = {
	"POST /_emdash/api/media": () => apiSuccess({ item: UPLOADED }, 201),
	[`GET ${LIBRARY_URL}`]: () => apiSuccess({ items: [PICKED], totalCount: 1 }),
};

async function uploadReplacement(popover: HTMLElement): Promise<void> {
	chooseFileToUpload(popover, pngFile(UPLOADED.filename));
}

async function pickReplacement(popover: HTMLElement): Promise<void> {
	popover.querySelector<HTMLButtonElement>('[data-action="browse"]')!.click();
	const thumbnail = await vi.waitFor(() => {
		const item = popover.querySelector<HTMLElement>(".emdash-img-grid-item");
		if (!item) throw new Error("Media library did not render");
		return item;
	});
	thumbnail.click();
}

async function removeImage(popover: HTMLElement): Promise<void> {
	popover.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
}

async function editAltText(popover: HTMLElement): Promise<void> {
	const altInput = popover.querySelector<HTMLInputElement>("#emdash-img-alt")!;
	altInput.value = NEW_ALT;
	altInput.dispatchEvent(new Event("input"));
}

const REPLACEMENTS = [
	["an upload", uploadReplacement, UPLOADED],
	["a library pick", pickReplacement, PICKED],
] as const;

function pageImageState(page: ReturnType<typeof mountEditablePage>) {
	const img = page.heroImg;
	return {
		src: img.getAttribute("src"),
		srcset: img.getAttribute("srcset"),
		sizes: img.getAttribute("sizes"),
		alt: img.getAttribute("alt"),
		hidden: img.style.display === "none",
	};
}

describe("toolbar image popover", () => {
	it("puts an uploaded image into the field", async () => {
		const uploaded = mediaItem("01UPLOADED", "new-hero.png");
		const page = mountEditablePage({
			...entryRoutes,
			"POST /_emdash/api/media": () => apiSuccess({ item: uploaded }, 201),
		});
		const popover = await openImagePopover(page);

		const file = pngFile("new-hero.png");
		chooseFileToUpload(popover, file);

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

	it("saves edited alt text together with the existing image reference", async () => {
		const page = mountEditablePage(entryRoutes);
		const popover = await openImagePopover(page);

		await editAltText(popover);

		await vi.waitFor(
			() => expect(savedImage(page.requests)).toEqual({ ...STORED_HERO, alt: NEW_ALT }),
			{ timeout: 2000 },
		);
		await vi.waitFor(() => expect(page.heroImg.getAttribute("alt")).toBe(NEW_ALT));
	});

	it("highlights the field's current image in the media library", async () => {
		const other = mediaItem("01LIBRARYOTHER", "other.png");
		const current = mediaItem(STORED_HERO.id, "hero.jpg");
		const page = mountEditablePage({
			...entryRoutes,
			"GET /_emdash/api/media?mimeType=image/&limit=30": () =>
				apiSuccess({ items: [other, current], totalCount: 2 }),
		});
		const popover = await openImagePopover(page);

		popover.querySelector<HTMLButtonElement>('[data-action="browse"]')!.click();

		await vi.waitFor(() =>
			expect(popover.querySelectorAll(".emdash-img-grid-item")).toHaveLength(2),
		);
		const highlighted = Array.from(
			popover.querySelectorAll(".emdash-img-grid-item--selected img"),
			(img) => img.getAttribute("src"),
		);
		expect(highlighted).toEqual([current.url]);
	});

	it("previews the page's image when the stored value carries no URL", async () => {
		const page = mountEditablePage(entryRoutes);
		const popover = await openImagePopover(page);

		expect(popover.querySelector(".emdash-img-preview")?.getAttribute("src")).toBe(HERO_SRC);
		expect(popover.querySelector(".emdash-img-empty")).toBeNull();
		expect(popover.querySelector('[data-action="remove"]')).not.toBeNull();
	});

	it("falls back to the page's image when the entry cannot be loaded", async () => {
		const page = mountEditablePage({
			...entryRoutes,
			[`GET ${ENTRY_URL}`]: () => apiError("NOT_FOUND", "Content item not found: post-1", 404),
		});
		const popover = await openImagePopover(page);

		expect(popover.querySelector(".emdash-img-preview")?.getAttribute("src")).toBe(HERO_SRC);
		expect(popover.querySelector<HTMLInputElement>("#emdash-img-alt")?.value).toBe(STORED_HERO.alt);
		expect(popover.querySelector('[data-action="remove"]')).not.toBeNull();
	});

	it("shows an empty image field as having no image", async () => {
		const page = mountEditablePage(entryRoutesWith(null), { pageShowsImage: false });
		const popover = await openImagePopover(page);

		expect(popover.querySelector(".emdash-img-empty")?.textContent).toBe("No image selected");
		expect(popover.querySelector(".emdash-img-preview")).toBeNull();
		expect(popover.querySelector('[data-action="remove"]')).toBeNull();
		expect(popover.querySelector<HTMLInputElement>("#emdash-img-alt")?.value).toBe("");
	});

	describe.each([
		["an img with srcset", "srcset"],
		["a picture with sources", "picture"],
	] as const)("when the page renders the image as %s", (_markup, responsive) => {
		function responsiveCandidates(page: ReturnType<typeof mountEditablePage>): string[] {
			return Array.from(page.hero.querySelectorAll("[srcset], [sizes]"), (el) => el.outerHTML);
		}

		it.each(REPLACEMENTS)(
			"displays the image from %s instead of the previous one",
			async (_action, replace, replacement) => {
				const page = mountEditablePage({ ...entryRoutes, ...replacementRoutes }, { responsive });
				const popover = await openImagePopover(page);

				await replace(popover);

				await vi.waitFor(() => expect(page.heroImg.getAttribute("src")).toBe(replacement.url));
				expect(responsiveCandidates(page)).toEqual([]);
			},
		);
	});

	it.each(REPLACEMENTS)(
		"keeps the dark variant when the image is replaced by %s",
		async (_action, replace, replacement) => {
			const page = mountEditablePage({
				...entryRoutesWith({ ...STORED_HERO, darkVariant: DARK_HERO }),
				...replacementRoutes,
			});
			const popover = await openImagePopover(page);

			await replace(popover);

			await vi.waitFor(() => expect(savedImage(page.requests)).toBeDefined());
			expect(savedImage(page.requests)).toEqual(
				expect.objectContaining({ id: replacement.id, darkVariant: DARK_HERO }),
			);
		},
	);

	it("clears the field and hides the page image when the image is removed", async () => {
		const page = mountEditablePage(entryRoutes);
		const popover = await openImagePopover(page);

		await removeImage(popover);

		await vi.waitFor(() => expect(page.heroImg.style.display).toBe("none"));
		expect(savedImage(page.requests)).toBeNull();
	});

	it("saves the picked image's default focal point", async () => {
		const focused = { ...mediaItem("01LIBRARYFOCUS", "focus.png"), focalX: 0.25, focalY: 0.75 };
		const page = mountEditablePage({
			...entryRoutes,
			[`GET ${LIBRARY_URL}`]: () => apiSuccess({ items: [focused], totalCount: 1 }),
		});
		const popover = await openImagePopover(page);

		await pickReplacement(popover);

		await vi.waitFor(() => expect(savedImage(page.requests)).toBeDefined());
		expect(savedImage(page.requests)).toEqual(
			expect.objectContaining({ id: focused.id, focalX: 0.25, focalY: 0.75 }),
		);
	});

	it.each([
		["an uploaded image", uploadReplacement],
		["a library pick", pickReplacement],
		["a removal", removeImage],
		["an alt text edit", editAltText],
	] as const)("leaves the page image unchanged when saving %s fails", async (_action, act) => {
		const page = mountEditablePage(
			{
				...entryRoutes,
				...replacementRoutes,
				[`PUT ${ENTRY_URL}`]: () =>
					apiError("FORBIDDEN", "You can only edit your own content", 403),
			},
			{ responsive: "srcset" },
		);
		const before = pageImageState(page);
		const popover = await openImagePopover(page);

		await act(popover);

		const saveStatus = page.doc.getElementById("emdash-tb-save-status")!;
		await vi.waitFor(() => expect(saveStatus.textContent).toBe("Save failed"), { timeout: 2000 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pageImageState(page)).toEqual(before);
	});
});
