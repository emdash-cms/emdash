import * as React from "react";
import { describe, it, expect } from "vitest";

import { EditorHeader } from "../../src/components/EditorHeader";
import { render } from "../utils/render";

describe("EditorHeader", () => {
	it("renders title content", async () => {
		const screen = await render(
			<EditorHeader>
				<h1>Hello title</h1>
			</EditorHeader>,
		);
		await expect.element(screen.getByRole("heading", { name: "Hello title" })).toBeInTheDocument();
	});

	it("renders leading content next to the title", async () => {
		const screen = await render(
			<EditorHeader leading={<button type="button">Back</button>}>
				<h1>Title</h1>
			</EditorHeader>,
		);
		await expect.element(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
	});

	it("renders actions area for the primary save button", async () => {
		const screen = await render(
			<EditorHeader actions={<button type="submit">Save</button>}>
				<h1>Title</h1>
			</EditorHeader>,
		);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("omits the actions area when no actions prop is provided", async () => {
		const screen = await render(
			<EditorHeader>
				<h1>Just a title</h1>
			</EditorHeader>,
		);
		// The actions container has flex + gap utility classes; assert it
		// isn't present in the header subtree. Looking at the underlying DOM
		// avoids relying on global queries that may be affected by leftover
		// nodes from earlier tests in the shared browser session.
		const wrapper = screen.getByText("Just a title").element().closest("[data-editor-header]");
		expect(wrapper).not.toBeNull();
		// Only one direct child div (the title group) — no actions div.
		const directChildren = wrapper!.children;
		expect(directChildren.length).toBe(1);
	});
});
