import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	SortableContentSettingsSection,
	SortableContentSettingsSections,
} from "../../src/components/SortableContentSettingsSections";

const STORAGE_KEY = "emdash:content-settings-layout:v1:user-1:posts";

function TestSections() {
	return (
		<SortableContentSettingsSections collection="posts" userId="user-1">
			<SortableContentSettingsSection id="publish" label="Publish">
				<div data-testid="publish-section">Publish</div>
			</SortableContentSettingsSection>
			<SortableContentSettingsSection id="seo" label="SEO">
				<div data-testid="seo-section">SEO</div>
			</SortableContentSettingsSection>
		</SortableContentSettingsSections>
	);
}

function renderSections() {
	return render(
		<I18nProvider i18n={i18n}>
			<TestSections />
		</I18nProvider>,
	);
}

async function pressKey(target: Document | HTMLElement, key: string, code: string) {
	await act(async () => {
		fireEvent.keyDown(target, { key, code });
		// dnd-kit schedules keyboard sensor listeners and state updates on the next task.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("SortableContentSettingsSections", () => {
	beforeEach(() => {
		i18n.load("en", {});
		i18n.activate("en");
		window.localStorage.clear();
	});
	afterEach(cleanup);

	it("restores a saved section order and exposes accessible drag handles", () => {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ version: 1, order: ["seo", "publish"] }),
		);

		const { container } = renderSections();
		const visibleSections = [...container.querySelectorAll("section")];

		expect(visibleSections.map((section) => section.textContent)).toEqual(["SEO", "Publish"]);
		expect(screen.getByRole("button", { name: "Drag to reorder SEO" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Drag to reorder Publish" })).toBeTruthy();
	});

	it("falls back to the default order when browser state is malformed", () => {
		window.localStorage.setItem(STORAGE_KEY, "not-json");

		const { container } = renderSections();
		const visibleSections = [...container.querySelectorAll("section")];

		expect(visibleSections.map((section) => section.textContent)).toEqual(["Publish", "SEO"]);
	});

	it("keeps sortable rows full-width and exposes disclosure spacing", () => {
		const { container } = render(
			<I18nProvider i18n={i18n}>
				<SortableContentSettingsSections collection="posts" userId="user-1">
					<SortableContentSettingsSection id="outline" label="Outline" disclosure>
						<div>Outline</div>
					</SortableContentSettingsSection>
				</SortableContentSettingsSections>
			</I18nProvider>,
		);

		const section = container.querySelector<HTMLElement>("section");
		const handle = screen.getByRole("button", { name: "Drag to reorder Outline" });

		expect(section?.style.inlineSize).toBe("100%");
		expect(section?.dataset.disclosure).toBe("true");
		expect(handle.classList.contains("end-3")).toBe(true);
		expect(handle.classList.contains("end-10")).toBe(false);
	});

	it("collapses every section to its heading while keyboard sorting is active", async () => {
		const { container } = renderSections();
		const handle = screen.getByRole("button", { name: "Drag to reorder Publish" });

		handle.focus();
		await pressKey(handle, " ", "Space");

		const sections = [...container.querySelectorAll("section")];
		expect(sections.every((section) => section.dataset.sorting === "true")).toBe(true);
		expect(screen.getByTestId("publish-section").parentElement).toBe(sections[0]);
		expect(screen.getByTestId("seo-section").parentElement).toBe(sections[1]);
		for (const section of sections) {
			const heading = section.querySelector<HTMLElement>("[data-sortable-heading]");
			const sectionHandle = section.querySelector<HTMLElement>("[data-sortable-handle]");

			expect(heading?.style.minHeight).toBe("48px");
			expect(section.className).toContain(
				"[&>*:not([data-sortable-heading]):not([data-sortable-handle])]:hidden",
			);
			expect(sectionHandle?.classList.contains("top-1/2")).toBe(true);
			expect(sectionHandle?.classList.contains("-translate-y-1/2")).toBe(true);
		}

		await pressKey(document, "Escape", "Escape");

		await waitFor(() => {
			expect(sections.every((section) => section.dataset.sorting === "false")).toBe(true);
		});
		expect(container.querySelector("[data-sortable-heading]")).toBeNull();
		expect(sections[0]?.className).not.toContain(
			"[&>*:not([data-sortable-heading]):not([data-sortable-handle])]:hidden",
		);
		expect(screen.getByTestId("publish-section").parentElement).toBe(sections[0]);
		expect(screen.getByTestId("seo-section").parentElement).toBe(sections[1]);
	});

	it("persists a keyboard reorder and restores expanded section content", async () => {
		const { container } = renderSections();
		const handle = screen.getByRole("button", { name: "Drag to reorder Publish" });

		handle.focus();
		await pressKey(handle, " ", "Space");
		await pressKey(document, "ArrowDown", "ArrowDown");
		await pressKey(document, " ", "Space");

		await waitFor(() => {
			const sections = [...container.querySelectorAll("section")];
			expect(sections.map((section) => section.textContent)).toEqual(["SEO", "Publish"]);
			expect(sections.every((section) => section.dataset.sorting === "false")).toBe(true);
		});

		const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
			order: string[];
		};
		expect(saved.order.indexOf("seo")).toBeLessThan(saved.order.indexOf("publish"));
		expect(screen.getByTestId("publish-section").parentElement?.tagName).toBe("SECTION");
		expect(screen.getByTestId("seo-section").parentElement?.tagName).toBe("SECTION");
	});
});
