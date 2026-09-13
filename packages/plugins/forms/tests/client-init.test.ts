/**
 * @vitest-environment jsdom
 *
 * Native constraint validation blocks the submit event before the plugin's delegated handler can reach it, so the
 * plugin's own field errors never render. initForms() turns it off per form; these pin that it still does, and
 * that the markup does not do it instead - a reader without JavaScript must keep native validation.
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
});
