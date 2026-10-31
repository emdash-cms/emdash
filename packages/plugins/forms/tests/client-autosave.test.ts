/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";

import { initForms } from "../src/client/index.js";

function embed(): HTMLFormElement {
	document.body.innerHTML = `<form class="ec-form" method="POST" action="/submit" data-ec-form data-form-id="contact">
		<fieldset data-page="0"><input name="name" /></fieldset>
		<button type="submit" class="ec-form-submit">Send</button>
		<div data-form-status></div>
	</form>`;
	return document.querySelector<HTMLFormElement>("[data-ec-form]")!;
}

function type(form: HTMLFormElement, name: string, value: string) {
	const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	sessionStorage.clear();
	document.body.innerHTML = "";
});

describe("session autosave", () => {
	test("saves what the visitor typed once they pause", async () => {
		vi.useFakeTimers();
		const form = embed();
		initForms();

		type(form, "name", "Ada");
		await vi.advanceTimersByTimeAsync(1000);
		expect(JSON.parse(sessionStorage.getItem("ec-form:contact")!).values).toEqual({ name: "Ada" });
	});

	test("leaves nothing saved when the form is submitted right after typing", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(Response.json({ data: { success: true, message: "Thanks" } }))),
		);
		const form = embed();
		initForms();

		type(form, "name", "Ada");
		form.requestSubmit();
		await vi.waitFor(() =>
			expect(form.querySelector("[data-form-status]")?.textContent).toBe("Thanks"),
		);

		await vi.advanceTimersByTimeAsync(1000);
		expect(sessionStorage.getItem("ec-form:contact")).toBeNull();
	});
});
