import * as React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { ThemeProvider } from "../../src/components/ThemeProvider";
import { ThemeToggle } from "../../src/components/ThemeToggle";
import { render } from "../utils/render.tsx";

function TestThemeToggle({ defaultTheme = "system" as "system" | "light" | "dark" }) {
	return (
		<ThemeProvider defaultTheme={defaultTheme}>
			<ThemeToggle />
		</ThemeProvider>
	);
}

function mockSystemTheme(theme: "light" | "dark") {
	vi.spyOn(window, "matchMedia").mockImplementation(
		(query) =>
			({
				matches: query === "(prefers-color-scheme: dark)" && theme === "dark",
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
			}) satisfies MediaQueryList,
	);
}

describe("ThemeToggle", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
	});

	// Kumo 2.x's <Button title="..."> wraps the button in a Tooltip popup
	// rather than setting the native `title` attribute. The action is also
	// exposed in `aria-label`, which is what these assertions read.

	it("offers dark when the system theme is light", async () => {
		mockSystemTheme("light");
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await expect.element(button).toBeInTheDocument();
		await expect.element(button).toHaveAttribute("aria-label", "Light theme. Switch to dark");
	});

	it("labels the button with the current theme", async () => {
		mockSystemTheme("dark");
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await expect.element(button).toHaveTextContent("Dark");
		await button.click();
		await expect.element(button).toHaveTextContent("Light");
	});

	it("follows operating system theme changes by default", async () => {
		let prefersDark = false;
		let onChange: ((event: MediaQueryListEvent) => void) | undefined;
		vi.spyOn(window, "matchMedia").mockImplementation(
			(query) =>
				({
					matches: query === "(prefers-color-scheme: dark)" && prefersDark,
					media: query,
					onchange: null,
					addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
						onChange = listener;
					},
					removeEventListener: vi.fn(),
					dispatchEvent: vi.fn(),
					addListener: vi.fn(),
					removeListener: vi.fn(),
				}) as unknown as MediaQueryList,
		);
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await expect.element(button).toHaveTextContent("Light");

		prefersDark = true;
		onChange?.({ matches: true } as MediaQueryListEvent);

		await expect.element(button).toHaveTextContent("Dark");
		await expect.element(document.documentElement).toHaveAttribute("data-mode", "dark");
		expect(localStorage.getItem("emdash-theme")).toBeNull();
	});

	it("switches from the light system theme to a dark override", async () => {
		mockSystemTheme("light");
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await button.click();
		await expect.element(document.documentElement).toHaveAttribute("data-mode", "dark");
		expect(localStorage.getItem("emdash-theme")).toBe("dark");
	});

	it("switches from the dark system theme to a light override", async () => {
		mockSystemTheme("dark");
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await button.click();
		await expect.element(document.documentElement).toHaveAttribute("data-mode", "light");
		expect(localStorage.getItem("emdash-theme")).toBe("light");
	});

	it("returns to the system theme by removing a matching override", async () => {
		mockSystemTheme("light");
		localStorage.setItem("emdash-theme", "dark");
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await button.click();
		await expect.element(document.documentElement).toHaveAttribute("data-mode", "light");
		expect(localStorage.getItem("emdash-theme")).toBeNull();
	});

	it("starts with light theme when defaultTheme is light", async () => {
		mockSystemTheme("light");
		const screen = await render(<TestThemeToggle defaultTheme="light" />);
		const button = screen.getByRole("button");
		await expect.element(button).toHaveAttribute("aria-label", "Light theme. Switch to dark");
	});
});
