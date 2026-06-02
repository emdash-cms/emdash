import type * as React from "react";
import { describe, it, expect } from "vitest";

import { resolvePluginPagePath } from "../../src/lib/plugin-context";

const SettingsPage: React.ComponentType = () => null;
const SettingsPageWithSlash: React.ComponentType = () => null;
const RootPage: React.ComponentType = () => null;
const AdvancedPage: React.ComponentType = () => null;

describe("resolvePluginPagePath", () => {
	it("resolves an exact page path", () => {
		expect(resolvePluginPagePath({ "/settings": SettingsPage }, "/settings")).toBe(SettingsPage);
	});

	it("resolves a trailing-slash path to the page registered without one", () => {
		expect(resolvePluginPagePath({ "/settings": SettingsPage }, "/settings/")).toBe(SettingsPage);
	});

	it("resolves a path without a trailing slash to the page registered with one", () => {
		expect(resolvePluginPagePath({ "/settings/": SettingsPage }, "/settings")).toBe(SettingsPage);
	});

	it("prefers an exact match when both slash variants are registered", () => {
		const pages = { "/settings": SettingsPage, "/settings/": SettingsPageWithSlash };
		expect(resolvePluginPagePath(pages, "/settings")).toBe(SettingsPage);
		expect(resolvePluginPagePath(pages, "/settings/")).toBe(SettingsPageWithSlash);
	});

	it("resolves the root path to a page registered at the root", () => {
		expect(resolvePluginPagePath({ "/": RootPage }, "/")).toBe(RootPage);
	});

	it("falls back to the first registered page at the root when no root page exists", () => {
		expect(resolvePluginPagePath({ "/settings": SettingsPage }, "/")).toBe(SettingsPage);
	});

	it("falls back to the first of several pages at the root", () => {
		const pages = { "/settings": SettingsPage, "/advanced": AdvancedPage };
		expect(resolvePluginPagePath(pages, "/")).toBe(SettingsPage);
	});

	it("does not fall back for an unregistered non-root path", () => {
		expect(resolvePluginPagePath({ "/settings": SettingsPage }, "/missing")).toBeNull();
	});

	it("returns null when the plugin has no pages", () => {
		expect(resolvePluginPagePath(undefined, "/settings")).toBeNull();
	});
});
