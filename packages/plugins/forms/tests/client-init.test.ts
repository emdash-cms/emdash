/**
 * @vitest-environment jsdom
 *
 * initForms() disables native validation so the plugin can show its own inline errors.
 * These tests guard that behavior while ensuring the markup itself keeps `novalidate` off
 * for readers without JavaScript.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { initForms } from "../src/client/index.js";

function embed(html: string): HTMLFormElement[] {
	document.body.innerHTML = html;
	return [...document.querySelectorAll<HTMLFormElement>("[data-ec-form]")];
}

describe("initForms", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	test("turns native validation off so the plugin's own errors can render", () => {
		const [form] = embed(
			`<form class="ec-form" method="POST" data-ec-form data-form-id="newsletter">
				<input type="email" name="email" required />
			</form>`,
		);
		expect(form.noValidate).toBe(false);
		initForms();
		expect(form.noValidate).toBe(true);
	});

	test("does it for every embedded form, not just the first", () => {
		const forms = embed(
			`<form class="ec-form" data-ec-form data-form-id="a"><input name="x" required /></form>
			 <form class="ec-form" data-ec-form data-form-id="b"><input name="y" required /></form>`,
		);
		initForms();
		expect(forms.map((f) => f.noValidate)).toEqual([true, true]);
	});

	test("fills the field's error span when an invalid form is submitted", () => {
		const [form] = embed(
			`<form class="ec-form" method="POST" action="/submit" data-ec-form data-form-id="newsletter">
				<fieldset data-page="0">
					<input type="email" name="email" required />
					<span data-error-for="email"></span>
				</fieldset>
				<button type="submit" class="ec-form-submit">Subscribe</button>
			</form>`,
		);
		initForms();
		form.requestSubmit();
		expect(form.querySelector('[data-error-for="email"]')?.textContent).not.toBe("");
	});
});
