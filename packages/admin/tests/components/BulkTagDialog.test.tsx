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
const requests: Array<{ termId: string; apply: boolean; items: unknown[] }> = [];
let failNextApply = false;
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
		failNextApply = false;
		createdTag = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				if (input.endsWith("/terms") && init?.method === "POST") {
					createdTag = true;
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
				if (input.endsWith("/terms"))
					return response({
						terms: [
							{
								id: "tag-1",
								name: "tag",
								label: "Internship Experience",
								slug: "internship",
								locale: "en",
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
				if (input.endsWith("/bulk-tag")) {
					const body = JSON.parse(init?.body as string) as {
						termId: string;
						apply: boolean;
						items: Array<{ url?: string; id?: string }>;
					};
					requests.push(body);
					return response({
						results: body.items.map((item) => ({
							input: item,
							entry,
							status: body.apply ? (failNextApply ? "failed" : "added") : "ready",
						})),
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
		await render(<BulkTagDialog onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await expect.element(page.getByText("Internship experience (en)")).toBeInTheDocument();
		expect(requests).toEqual([{ termId: "tag-1", apply: false, items: [source] }]);
		await page.getByRole("button", { name: "Apply now" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		expect(requests[1]).toEqual({ termId: "tag-1", apply: true, items: [source] });
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
			/>,
		);
		await screen.getByRole("checkbox", { name: "Select Internship experience" }).click();
		await screen.getByRole("button", { name: "Add tag" }).click();
		await expect.element(screen.getByText("1 selected posts")).toBeInTheDocument();
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("button", { name: "Review posts" }).click();
		expect(requests[0]).toEqual({
			termId: "tag-1",
			apply: false,
			items: [{ collection: "posts", id: "post-1" }],
		});
	});

	it("retries failed writes without repeating the successful review", async () => {
		failNextApply = true;
		await render(<BulkTagDialog onClose={() => undefined} />);
		await page.getByRole("combobox", { name: "Tag" }).click();
		await page.getByRole("option", { name: "Internship Experience" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await page.getByRole("button", { name: "Apply now" }).click();
		await expect.element(page.getByText("Failed")).toBeInTheDocument();
		failNextApply = false;
		await page.getByRole("button", { name: "Retry failures" }).click();
		await expect.element(page.getByText("Added")).toBeInTheDocument();
		expect(requests).toEqual([
			{ termId: "tag-1", apply: false, items: [source] },
			{ termId: "tag-1", apply: true, items: [source] },
			{ termId: "tag-1", apply: true, items: [source] },
		]);
	});

	it("creates and selects a new tag in a right-to-left dialog", async () => {
		document.documentElement.dir = "rtl";
		await render(<BulkTagDialog defaultLocale="ar" onClose={() => undefined} />);
		await page.getByRole("button", { name: "Create new tag" }).click();
		await page.getByRole("textbox", { name: "New tag name" }).fill("تجربة التدريب");
		await page.getByRole("button", { name: "Create tag" }).click();
		await page.getByRole("textbox", { name: "Post URLs (one per line)" }).fill(link);
		await page.getByRole("button", { name: "Review posts" }).click();
		await expect.element(page.getByText("Internship experience (en)")).toBeInTheDocument();
		expect(requests[0]).toMatchObject({ termId: "tag-2", apply: false });
	});
});
