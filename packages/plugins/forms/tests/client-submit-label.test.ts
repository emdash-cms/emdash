/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";

import { initForms } from "../src/client/index.js";

function embed(submitLabel: string): HTMLFormElement {
	document.body.innerHTML = `<form class="ec-form" method="POST" action="/submit" data-ec-form data-form-id="contact">
		<fieldset data-page="0"><input name="name" value="Ada" /></fieldset>
		<button type="submit" class="ec-form-submit">${submitLabel}</button>
		<div data-form-status></div>
	</form>`;
	return document.querySelector<HTMLFormElement>("[data-ec-form]")!;
}

function submitButton(form: HTMLFormElement): HTMLButtonElement {
	return form.querySelector<HTMLButtonElement>(".ec-form-submit")!;
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("submit button label", () => {
	test("shows the configured label again after a successful submission", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(Response.json({ data: { success: true, message: "Thanks" } }))),
		);
		const form = embed("Send message");
		initForms();

		form.requestSubmit();
		expect(submitButton(form).disabled).toBe(true);

		await vi.waitFor(() => expect(submitButton(form).disabled).toBe(false));
		expect(submitButton(form).textContent).toBe("Send message");
	});

	test("shows the configured label again after a network error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("offline"))),
		);
		const form = embed("この内容で送信する");
		initForms();

		form.requestSubmit();

		await vi.waitFor(() => expect(submitButton(form).disabled).toBe(false));
		expect(submitButton(form).textContent).toBe("この内容で送信する");
	});
});
