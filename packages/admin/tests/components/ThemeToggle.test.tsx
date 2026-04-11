import * as React from "react";
import { describe, it, expect, beforeEach } from "vitest";

import { ThemeProvider } from "../../src/components/ThemeProvider";
import { ThemeToggle } from "../../src/components/ThemeToggle";
import { render } from "../utils/render.js";

function TestThemeToggle({ defaultTheme = "system" as "system" | "light" | "dark" }) {
	return (
		<ThemeProvider defaultTheme={defaultTheme}>
			<ThemeToggle />
		</ThemeProvider>
	);
}

describe("ThemeToggle", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.removeAttribute("data-theme");
	});

	it("renders with system theme by default", async () => {
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await expect.element(button).toBeInTheDocument();
		// System theme shows Monitor icon - check the title
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("System"));
	});

	it("cycles from system to light on click", async () => {
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await button.click();
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("Light"));
	});

	it("cycles through system -> light -> dark -> system", async () => {
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");

		// Start: system
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("System"));

		// Click 1: light
		await button.click();
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("Light"));

		// Click 2: dark
		await button.click();
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("Dark"));

		// Click 3: back to system
		await button.click();
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("System"));
	});

	it("persists theme to localStorage", async () => {
		const screen = await render(<TestThemeToggle />);
		const button = screen.getByRole("button");
		await button.click(); // system -> light
		expect(localStorage.getItem("emdash-theme")).toBe("light");
	});

	it("starts with light theme when defaultTheme is light", async () => {
		const screen = await render(<TestThemeToggle defaultTheme="light" />);
		const button = screen.getByRole("button");
		await expect.element(button).toHaveAttribute("title", expect.stringContaining("Light"));
	});
});
