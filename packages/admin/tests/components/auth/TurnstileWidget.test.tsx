import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget, toTurnstileLanguage } from "../../../src/components/auth/TurnstileWidget";
import { render } from "../../utils/render.tsx";

describe("toTurnstileLanguage", () => {
	it("maps admin locales to languages the Turnstile widget accepts", () => {
		expect(toTurnstileLanguage("en")).toBe("en");
		expect(toTurnstileLanguage("en-GB")).toBe("en");
		expect(toTurnstileLanguage("pt-BR")).toBe("pt-br");
		expect(toTurnstileLanguage("zh-TW")).toBe("zh-tw");
		expect(toTurnstileLanguage("es-419")).toBe("es");
		expect(toTurnstileLanguage("sr-Latn")).toBe("sr");
	});

	it("falls back to the browser language for locales Turnstile doesn't support", () => {
		expect(toTurnstileLanguage("eu")).toBe("auto");
		expect(toTurnstileLanguage("ka")).toBe("auto");
		expect(toTurnstileLanguage("pseudo")).toBe("auto");
	});
});

describe("TurnstileWidget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries loading the script after it loaded without defining Turnstile", async () => {
		const appended: HTMLScriptElement[] = [];
		vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
			appended.push(...(nodes as HTMLScriptElement[]));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const first = await render(<TurnstileWidget siteKey="site-key" onToken={() => {}} />);
		await vi.waitFor(() => expect(appended).toHaveLength(1));
		appended[0]!.onload?.(new Event("load"));
		await expect.element(first.getByRole("alert")).toBeInTheDocument();
		await first.unmount();

		await render(<TurnstileWidget siteKey="site-key" onToken={() => {}} />);
		await vi.waitFor(() => expect(appended).toHaveLength(2));
	});
});
