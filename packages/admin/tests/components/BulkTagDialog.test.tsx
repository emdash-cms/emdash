import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { BulkTagDialog } from "../../src/components/BulkTagDialog.js";
import { ContentList } from "../../src/components/ContentList.js";

import "../../dist/styles.css";
import { render } from "../utils/render.tsx";

const link = "https://blog.example.com/posts/example";
const source = { url: link };
const entry = { collection: "posts", id: "post-1", title: "Internship experience", locale: "en" };
const requests: Array<{ termId: string; apply: boolean; items: unknown[]; refreshOnly?: boolean }> =
	[];
const termRequests: string[] = [];
const createdTermLocales: Array<string | undefined> = [];
let failNextApply = false;
let failTermFetch = false;
let failCacheRefresh = false;
let skipOnCacheRetry = false;
let unmatchedSecondOnApply = false;
let createdTag = false;

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
			<a href={to ?? "#"}>{children}</a>
		),
	};
});

function response(data: unknown): Response {
	return Response.json({ success: true, data });
}

describe("bulk tag dialog", () => {
	beforeEach(() => {
		requests.length = 0;
		termRequests.length = 0;
		createdTermLocales.length = 0;
		failNextApply = false;
		failTermFetch = false;
		failCacheRefresh = false;
		skipOnCacheRetry = false;
		unmatchedSecondOnApply = false;
		createdTag = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				if (input.endsWith("/terms") && init?.method === "POST") {
					createdTag = true;
					createdTermLocales.push(JSON.parse(init.body as string).locale);
					return response({
						term: {
							id: "tag-2",
							name: "tag",
							label: "تجربة التدريب",
							slug: "intern-ar",
							locale: "ar",
							translationGroup: "tag-2",
							children: [],
						},
					});
				}
				if (input.includes("/terms?")) {
					termRequests.push(input);
					if (failTermFetch) {
						return Response.json(
							{ success: false, error: { code: "UNAVAILABLE", message: "Unavailable" } },
							{ status: 503 },
						);
					}
					const locale = new URL(input, window.location.origin).searchParams.get("locale");
					return response({
						terms: [
							{
								id: locale === "fr" ? "tag-1-fr" : "tag-1",
								name: "tag",
								label: locale === "fr" ? "Expérience de stage" : "Internship Experience",
								slug: "internship",
								locale: locale === "fr" ? "fr" : "en",
								translationGroup: "tag-1",
								children: [],
							},
							...(createdTag
								? [
										{
											id: "tag-2",
											name: "tag",
											label: "تجربة التدريب",
											slug: "intern-ar",
											locale: "ar",
											translationGroup: "tag-2",
											children: [],
										},
									]
								: []),
						],
					});
				}
				if (input.endsWith("/bulk-tag")) {
					const body = JSON.parse(init?.body as string) as {
						termId: string;
						apply: boolean;
						refreshOnly?: boolean;
						items: Array<{ url?: string; id?: string }>;
					};
					requests.push(body);
					return response({
						results: body.items.map((item, index) => {
							if (unmatchedSecondOnApply && body.apply && index === 1) {
								return { input: item, status: "unmatched", reason: "not_found" };
							}
							const duplicate = index > 0 && item.url === body.items[0]?.url;
							return {
								input: item,
								entry: index > 0 ? { ...entry, id: "post-2", title: "Second" } : entry,
								status: duplicate
									? "skipped"
									: body.apply
										? failNextApply
											? "failed"
											: body.refreshOnly ||
												  (skipOnCacheRetry &&
														requests.filter((request) => request.apply).length > 1)
												? "skipped"
												: "added"
										: "ready",
							};
						}),
						cacheRefreshFailed: body.apply && failCacheRefresh,
					});
				}
				throw new Error(`Unexpected request: ${input}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.documentElement.dir = "ltr";
	});

	it("previews the exact title and language before applying the tag", async () => {
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		const dialogSize = () => {
			const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
			return [dialog.clientWidth, dialog.clientHeight];
		};
		const initialSize = dialogSize();
		expect(initialSize[0]).toBeGreaterThan(650);
		expect(initialSize[1]).toBeLessThan(550);
		await page.getByRole("button", { name: "Review posts" }).click();
		expect(dialogSize()).toEqual(initialSize);
		await expect
			.element(page.getByRole("dialog").getByText("Internship experience", { exact: true }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole("dialog").getByText("en", { exact: true }))
			.toBeInTheDocument();
		await expect
			.element(page.getByText("Tags go live now; draft edits stay unpublished."))
			.toBeInTheDocument();
		expect(requests).toEqual([{ termId: "tag-1", apply: false, items: [source] }]);
		await page.getByRole("button", { name: "Add tag to 1 post" }).click();
		expect(dialogSize()).toEqual(initialSize);
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		expect(requests[1]).toEqual({
			termId: "tag-1",
			apply: true,
			items: [{ collection: "posts", id: "post-1" }],
		});
	});

	it("keeps the chosen tag and pasted links when returning from review", async () => {
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Back" }).click();
		await expect
			.element(page.getByRole("textbox", { name: "Post URLs (one per line)" }))
			.toHaveValue(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		expect(requests).toEqual([
			{ termId: "tag-1", apply: false, items: [source] },
			{ termId: "tag-1", apply: false, items: [source] },
		]);
	});

	it("closes and resets before reopening", async () => {
		const onClosed = vi.fn();
		function Host() {
			const [open, setOpen] = React.useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Open bulk tagging
					</button>
					<BulkTagDialog open={open} onClose={() => setOpen(false)} onClosed={onClosed} />
				</>
			);
		}
		await render(<Host />);
		expect(termRequests).toHaveLength(0);
		await page.getByRole("button", { name: "Open bulk tagging" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Close" }).click();
		await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
		await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
		await page.getByRole("button", { name: "Open bulk tagging" }).click();
		await expect
			.element(page.getByRole("textbox", { name: "Post URLs (one per line)" }))
			.toHaveValue("");
	});

	it("opens from the Posts selection bar with the selected entry", async () => {
		const screen = await render(
			<ContentList
				collection="posts"
				collectionLabel="Posts"
				items={[
					{
						id: "post-1",
						type: "posts",
						slug: "example",
						status: "published",
						locale: "fr",
						translationGroup: null,
						data: { title: "Internship experience" },
						authorId: "editor",
						createdAt: "2026-09-01",
						updatedAt: "2026-09-01",
						publishedAt: "2026-09-01",
						scheduledAt: null,
						liveRevisionId: "revision-1",
						draftRevisionId: null,
					},
				]}
				bulkTagEnabled
				activeLocale="fr"
				i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
			/>,
		);
		await screen.getByRole("checkbox", { name: "Select Internship experience" }).click();
		await screen.getByRole("button", { name: "Add tag" }).click();
		await expect
			.element(screen.getByRole("dialog").getByText("Internship experience", { exact: true }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("dialog").getByText("fr", { exact: true }))
			.toBeInTheDocument();
		expect(requests).toHaveLength(0);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Expérience de stage" }).click();
		await page.getByRole("button", { name: "Review posts" }).click();
		expect(requests[0]).toEqual({
			termId: "tag-1-fr",
			apply: false,
			items: [{ collection: "posts", id: "post-1" }],
		});
	});

	it("retries failed writes without repeating the successful review", async () => {
		failNextApply = true;
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Add tag to 1 post" }).click();
		await expect.element(page.getByText("Failed", { exact: true })).toBeInTheDocument();
		failNextApply = false;
		await page.getByRole("button", { name: "Retry failures" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		expect(requests).toEqual([
			{ termId: "tag-1", apply: false, items: [source] },
			{ termId: "tag-1", apply: true, items: [{ collection: "posts", id: "post-1" }] },
			{ termId: "tag-1", apply: true, items: [{ collection: "posts", id: "post-1" }] },
		]);
	});

	it("keeps duplicate URL rows distinct and only applies the reviewed post once", async () => {
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(`${link}\n${link}`);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Add tag to 1 post" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		await expect.element(page.getByText("Already tagged or duplicate")).toBeInTheDocument();
		expect(requests).toEqual([
			{ termId: "tag-1", apply: false, items: [source, source] },
			{ termId: "tag-1", apply: true, items: [{ collection: "posts", id: "post-1" }] },
		]);
	});

	it("creates and selects a new tag in a right-to-left dialog", async () => {
		document.documentElement.dir = "rtl";
		await render(<BulkTagDialog open defaultLocale="ar" onClose={() => undefined} />);
		await page.getByRole("button", { name: "Create new tag" }).click();
		await page.getByRole("textbox", { name: "New tag name" }).fill("تجربة التدريب");
		await page.getByRole("button", { name: "Create tag" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await expect.element(page.getByText("Internship experience")).toBeInTheDocument();
		await expect.element(page.getByText("en", { exact: true })).toBeInTheDocument();
		expect(requests[0]).toMatchObject({ termId: "tag-2", apply: false });
	});

	it("prefers the configured language and skips unused term counts", async () => {
		await render(<BulkTagDialog open defaultLocale="fr" onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Expérience de stage" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		expect(requests[0]?.termId).toBe("tag-1-fr");
		const params = new URL(termRequests[0]!, window.location.origin).searchParams;
		expect(params.get("locale")).toBe("fr");
		expect(params.get("resolveFallback")).toBe("true");
		expect(params.get("includeCounts")).toBe("false");
	});

	it("uses the active content language rather than the site default for tags", async () => {
		await render(
			<BulkTagDialog open activeLocale="fr" defaultLocale="en" onClose={() => undefined} />,
		);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await expect
			.element(page.getByRole("option", { name: "Expérience de stage" }))
			.toBeInTheDocument();
		await page.getByRole("option", { name: "Expérience de stage" }).click();
		await page.getByRole("button", { name: "Create new tag" }).click();
		await page.getByRole("textbox", { name: "New tag name" }).fill("Nouvelle étiquette");
		await page.getByRole("button", { name: "Create tag" }).click();
		expect(new URL(termRequests[0]!, window.location.origin).searchParams.get("locale")).toBe("fr");
		expect(createdTermLocales).toEqual(["fr"]);
	});

	it("shows tag loading failures and retries instead of offering to create a duplicate", async () => {
		failTermFetch = true;
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load tags.");
		await expect.element(page.getByRole("button", { name: "Create new tag" })).toBeDisabled();
		failTermFetch = false;
		await page.getByRole("button", { name: "Retry loading tags" }).click();
		await page.getByRole("combobox", { name: "Tag" }).click();
		await expect
			.element(page.getByRole("option", { name: "Internship Experience" }))
			.toBeInTheDocument();
	});

	it("shows committed results with a cache warning and allows refreshing without retagging", async () => {
		failCacheRefresh = true;
		skipOnCacheRetry = true;
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Add tag to 1 post" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		await expect
			.element(page.getByText(/cached pages may still show old tags/))
			.toBeInTheDocument();
		failCacheRefresh = false;
		await page.getByRole("button", { name: "Retry cache refresh" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		await expect
			.element(page.getByText(/cached pages may still show old tags/))
			.not.toBeInTheDocument();
		expect(requests.filter((request) => request.apply)).toHaveLength(2);
		expect(requests.at(-1)).toMatchObject({
			refreshOnly: true,
			items: [{ collection: "posts", id: "post-1" }],
		});
	});

	it("cache-only retry excludes an unmatched row with a preserved reviewed title", async () => {
		failCacheRefresh = true;
		unmatchedSecondOnApply = true;
		await render(<BulkTagDialog open onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page
			.getByRole("textbox", { name: "Post URLs (one per line)" })
			.fill(`${link}\n${link}-second`);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Add tag to 2 posts" }).click();
		await expect.element(page.getByText("Second")).toBeInTheDocument();
		await expect.element(page.getByText("Not matched")).toBeInTheDocument();
		failCacheRefresh = false;
		await page.getByRole("button", { name: "Retry cache refresh" }).click();
		expect(requests.at(-1)).toMatchObject({
			refreshOnly: true,
			items: [{ collection: "posts", id: "post-1" }],
		});
	});
});
