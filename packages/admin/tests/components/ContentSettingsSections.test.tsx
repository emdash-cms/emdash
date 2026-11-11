import { describe, expect, it } from "vitest";

import {
	ContentSettingsSection,
	ContentSettingsSections,
} from "../../src/components/ContentSettingsSections";
import { EMPTY_LIST_LAYOUT, type ListLayout } from "../../src/lib/admin-layout";
import { render } from "../utils/render.tsx";

function sectionTexts(container: HTMLElement): string[] {
	return Array.from(
		container.querySelectorAll<HTMLElement>("section[data-settings-section]"),
		(section) => section.textContent ?? "",
	);
}

describe("ContentSettingsSections", () => {
	it("renders the sections in the layout's order", async () => {
		const layout: ListLayout = { order: ["seo", "publish", "url-language"], hidden: [] };
		const screen = await render(
			<ContentSettingsSections layout={layout}>
				<ContentSettingsSection id="publish">publish</ContentSettingsSection>
				<ContentSettingsSection id="url-language">url-language</ContentSettingsSection>
				<ContentSettingsSection id="seo">seo</ContentSettingsSection>
			</ContentSettingsSections>,
		);

		expect(sectionTexts(screen.container)).toEqual(["seo", "publish", "url-language"]);
	});

	it("takes the default order from the section catalog, not from the children's order", async () => {
		const screen = await render(
			<ContentSettingsSections layout={EMPTY_LIST_LAYOUT}>
				<ContentSettingsSection id="revisions">revisions</ContentSettingsSection>
				<ContentSettingsSection id="plugin:forms:summary">plugin</ContentSettingsSection>
				<ContentSettingsSection id="seo">seo</ContentSettingsSection>
				<ContentSettingsSection id="bylines">bylines</ContentSettingsSection>
				<ContentSettingsSection id="publish">publish</ContentSettingsSection>
			</ContentSettingsSections>,
		);

		expect(sectionTexts(screen.container)).toEqual([
			"publish",
			"bylines",
			"seo",
			"plugin",
			"revisions",
		]);
	});

	it("leaves hidden sections out but always renders Publish", async () => {
		const layout: ListLayout = { order: [], hidden: ["publish", "seo"] };
		const screen = await render(
			<ContentSettingsSections layout={layout}>
				<ContentSettingsSection id="publish">publish</ContentSettingsSection>
				<ContentSettingsSection id="seo">seo</ContentSettingsSection>
				<ContentSettingsSection id="outline">outline</ContentSettingsSection>
			</ContentSettingsSections>,
		);

		expect(sectionTexts(screen.container)).toEqual(["publish", "outline"]);
	});

	it("offers no way to reorder sections in the editor", async () => {
		const screen = await render(
			<ContentSettingsSections layout={EMPTY_LIST_LAYOUT}>
				<ContentSettingsSection id="publish">publish</ContentSettingsSection>
				<ContentSettingsSection id="seo">seo</ContentSettingsSection>
			</ContentSettingsSections>,
		);

		expect(sectionTexts(screen.container)).toEqual(["publish", "seo"]);
		expect(screen.container.querySelectorAll("button")).toHaveLength(0);
	});
});
