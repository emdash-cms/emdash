import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cdp, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import { ContentSettingsPanel } from "../../src/components/ContentSettingsPanel.js";
import { DocumentOutline } from "../../src/components/editor/DocumentOutline.js";
import { RevisionHistory } from "../../src/components/RevisionHistory.js";
import { Sidebar } from "../../src/components/Sidebar.js";
import { fetchRevisions } from "../../src/lib/api.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api.js", async () => {
	const actual = await vi.importActual("../../src/lib/api.js");
	return {
		...actual,
		fetchRevisions: vi.fn(),
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

const editors: Editor[] = [];
const hosts: HTMLElement[] = [];

afterEach(async () => {
	for (const editor of editors.splice(0)) editor.destroy();
	for (const host of hosts.splice(0)) host.remove();
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

async function heightTransitionsOnToggle(trigger: Locator) {
	const transitions = new Set<Animation>();
	trigger.element().click();
	const start = performance.now();
	await new Promise<void>((resolve) => {
		function sample() {
			const id = trigger.element().getAttribute("aria-controls");
			const panel = id ? document.getElementById(id) : null;
			for (const animation of panel?.getAnimations() ?? []) {
				if (animation instanceof CSSTransition && animation.transitionProperty === "height")
					transitions.add(animation);
			}
			if (performance.now() - start < 250) requestAnimationFrame(sample);
			else resolve();
		}
		requestAnimationFrame(sample);
	});
	return transitions.size;
}

async function renderRevisionHistory() {
	(fetchRevisions as Mock).mockResolvedValue({ items: [], total: 0 });
	const screen = await render(<RevisionHistory collection="posts" entryId="entry-1" />);
	const trigger = screen.getByRole("button", { name: /^Revisions/ });
	return { trigger, opened: screen.getByText("No versions yet") };
}

async function renderDocumentOutline() {
	const element = document.createElement("div");
	document.body.append(element);
	hosts.push(element);
	const editor = new Editor({
		element,
		extensions: [StarterKit],
		content: {
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Intro" }] },
			],
		},
	});
	editors.push(editor);
	const screen = await render(
		<Sidebar.Provider>
			<DocumentOutline editor={editor} />
		</Sidebar.Provider>,
	);
	const trigger = screen.getByRole("button", { name: "Outline" });
	const opened = screen.getByRole("button", { name: "Intro" });
	await expect.element(opened).toBeVisible();
	trigger.element().click();
	await expect.element(opened).not.toBeInTheDocument();
	return { trigger, opened };
}

async function renderContentDates() {
	const screen = await render(
		<ContentSettingsPanel
			collection="posts"
			item={{
				id: "item-1",
				type: "posts",
				slug: "my-post",
				status: "draft",
				data: { title: "My Post" },
				authorId: null,
				createdAt: "2025-01-15T10:30:00Z",
				updatedAt: "2025-01-15T10:30:00Z",
				publishedAt: null,
				scheduledAt: null,
				liveRevisionId: null,
				draftRevisionId: null,
			}}
			slug="my-post"
			onSlugChange={vi.fn()}
			status="draft"
			supportsDrafts
			isLive={false}
			hasPendingChanges={false}
			supportsRevisions={false}
			activeBylines={[]}
			onBylinesChange={vi.fn()}
			hasSeo={false}
			portableTextEditor={null}
			blockSidebarPanel={null}
			onBlockSidebarClose={vi.fn()}
			onBlockSidebarDelete={vi.fn()}
		/>,
	);
	const trigger = screen.getByRole("button", { name: "Created and updated" });
	return { trigger, opened: screen.getByText("Created", { exact: true }) };
}

const panels = [
	["revision history", renderRevisionHistory],
	["document outline", renderDocumentOutline],
	["content dates", renderContentDates],
] as const;

describe("sidebar disclosure motion", () => {
	it.each(panels)(
		"%s opens without a height transition when reduced motion is requested",
		async (_, setup) => {
			await cdp().send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-reduced-motion", value: "reduce" }],
			});
			const { trigger, opened } = await setup();

			expect(await heightTransitionsOnToggle(trigger)).toBe(0);
			await expect.element(opened).toBeVisible();
		},
	);

	it.each(panels)("%s animates its height when motion is allowed", async (_, setup) => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
		});
		const { trigger } = await setup();

		expect(await heightTransitionsOnToggle(trigger)).toBeGreaterThan(0);
	});
});
