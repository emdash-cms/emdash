import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContentEditor, type FieldDescriptor } from "../../src/components/ContentEditor.js";
import { RepeaterField } from "../../src/components/RepeaterField";
import type { ContentItem } from "../../src/lib/api";
import { type MediaItem } from "../../src/lib/api/media.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

const pickerApi = vi.hoisted(() => ({
	fetchMediaList: vi.fn(),
	uploadMedia: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
		fetchReferenceChildren: vi.fn().mockResolvedValue({ children: [] }),
		fetchMediaList: pickerApi.fetchMediaList,
		fetchMediaFolders: vi.fn().mockResolvedValue({ items: [] }),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadMedia: pickerApi.uploadMedia,
	};
});

vi.mock("../../src/lib/api/current-user.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/current-user.js")>(
		"../../src/lib/api/current-user.js",
	);
	return {
		...actual,
		useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
	};
});

function mediaItem(id: string, filename: string, mimeType: string): MediaItem {
	return {
		id,
		filename,
		mimeType,
		url: `/_emdash/api/media/file/${filename}`,
		storageKey: filename,
		size: 100,
		width: 100,
		height: 100,
		createdAt: "2026-09-09T00:00:00Z",
	};
}

function setInputFiles(input: HTMLInputElement, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	input.files = dataTransfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
	vi.clearAllMocks();
	pickerApi.fetchMediaList.mockImplementation(({ mimeType }: { mimeType?: string[] }) => {
		const items = [
			mediaItem("svg-1", "logo.svg", "image/svg+xml"),
			mediaItem("png-1", "logo.png", "image/png"),
		];
		const filtered = mimeType?.length
			? items.filter((item) =>
					mimeType.some((filter) => item.mimeType.startsWith(filter) || item.mimeType === filter),
				)
			: items;
		return Promise.resolve({ items: filtered, totalCount: filtered.length });
	});
	pickerApi.uploadMedia.mockResolvedValue(mediaItem("uploaded", "logo.svg", "image/svg+xml"));
});

function blockType(slug: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label: "Partners",
		currentVersion: 1,
		source: "seed",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-type`,
				version: 1,
				fields,
				fingerprint: slug,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

const partners = blockType("partners", [
	{
		slug: "logos",
		label: "Logos",
		type: "repeater",
		validation: {
			subFields: [
				{
					slug: "logo",
					label: "Logo",
					type: "image",
					validation: { allowedMimeTypes: ["image/svg+xml"] },
				},
			],
		},
	},
]);

const partnersBlock = { _type: "partners", _version: 1, _key: "k1", logos: [{ logo: null }] };

it("uses the real picker from ContentEditor for a block repeater image upload", async () => {
	const fields: Record<string, FieldDescriptor> = {
		content: {
			id: "blocks-field",
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: ["partners"], retiredTypes: [] },
			blockTypes: [partners],
		},
	};
	const item: ContentItem = {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		locale: "en",
		translationGroup: null,
		data: { content: [partnersBlock] },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
	const screen = await render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fields}
			isNew={false}
			item={item}
			onSave={vi.fn()}
		/>,
		{ wrapper: Toasty },
	);

	await screen.getByRole("button", { name: "Partners", exact: true }).click();
	await screen.getByRole("button", { name: "Select Logo", exact: true }).click();
	await expect.element(screen.getByRole("dialog")).toBeVisible();
	await vi.waitFor(() =>
		expect(pickerApi.fetchMediaList).toHaveBeenCalledWith(
			expect.objectContaining({ mimeType: ["image/svg+xml"] }),
		),
	);

	setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
		new File(["svg"], "logo.svg", { type: "image/svg+xml" }),
	]);
	await vi.waitFor(() => expect(pickerApi.uploadMedia).toHaveBeenCalledTimes(1));
	expect(pickerApi.uploadMedia).toHaveBeenCalledWith(
		expect.any(File),
		expect.objectContaining({
			fieldId: "blocks-field:k1:logos.logo",
			blockType: "partners",
			blockVersion: 1,
		}),
	);
});

describe("RepeaterField image sub-field media picker", () => {
	it("passes the sub-field allowlist to the real picker and excludes other image types", async () => {
		const screen = await render(
			<RepeaterField
				label="Partners"
				id="partners"
				value={[{ logo: null }]}
				onChange={vi.fn()}
				subFields={[
					{
						slug: "logo",
						type: "image",
						label: "Logo",
						validation: { allowedMimeTypes: ["image/svg+xml"] },
					},
				]}
			/>,
		);

		await screen.getByRole("button", { name: "Select image" }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "logo.svg" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "logo.png" })).not.toBeInTheDocument();
		expect(pickerApi.fetchMediaList).toHaveBeenCalledWith(
			expect.objectContaining({ mimeType: ["image/svg+xml"] }),
		);
	});

	it.each([
		{ fieldId: "database-field", blockType: undefined, blockVersion: undefined },
		{ fieldId: "blocks-field:k1:partners", blockType: "hero", blockVersion: 3 },
	])("uploads through the picker with context $fieldId", async (context) => {
		const screen = await render(
			<RepeaterField
				label="Partners"
				id="partners"
				{...context}
				value={[{ logo: null }]}
				onChange={vi.fn()}
				subFields={[
					{
						slug: "logo",
						type: "image",
						label: "Logo",
						validation: { allowedMimeTypes: ["image/svg+xml"] },
					},
				]}
			/>,
		);

		await screen.getByRole("button", { name: "Select image" }).click();
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["svg"], "logo.svg", { type: "image/svg+xml" }),
		]);

		await vi.waitFor(() => expect(pickerApi.uploadMedia).toHaveBeenCalledTimes(1));
		expect(pickerApi.uploadMedia).toHaveBeenCalledWith(
			expect.any(File),
			expect.objectContaining({
				...context,
				fieldId: `${context.fieldId}.logo`,
			}),
		);
	});
});
