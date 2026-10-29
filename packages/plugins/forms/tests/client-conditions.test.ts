/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { initForms, serializeSubmission } from "../src/client/index.js";
import { evaluateCondition, validateSubmission } from "../src/validation.js";

const formsCss = readFileSync(resolve(import.meta.dirname, "../src/styles/forms.css"), "utf-8");

function embed(html: string): HTMLFormElement {
	const style = document.createElement("style");
	style.textContent = formsCss;
	document.head.appendChild(style);
	document.body.innerHTML = html;
	return document.querySelector<HTMLFormElement>("[data-ec-form]")!;
}

function wrapperFor(form: HTMLFormElement, name: string): HTMLElement {
	return form.querySelector<HTMLElement>(`[data-condition*="${name}"]`)!;
}

describe("initForms conditional fields", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
	});

	test("hides conditional fields whose condition is false", () => {
		const form = embed(
			`<form class="ec-form" method="POST" data-ec-form data-form-id="workshift">
				<fieldset data-page="0">
					<div class="ec-form-field">
						<select name="workshift" id="workshift">
							<option value="NPC" selected>NPC</option>
							<option value="Other">Other</option>
						</select>
					</div>
					<div class="ec-form-field" data-condition='{"field":"workshift","op":"eq","value":"Other"}'>
						<input type="text" name="details" class="ec-form-input" id="details" />
					</div>
				</fieldset>
			</form>`,
		);
		initForms();
		const wrapper = wrapperFor(form, "workshift");

		expect(wrapper.hidden).toBe(true);
		expect(getComputedStyle(wrapper).display).toBe("none");
	});

	test("shows conditional fields when their condition becomes true", () => {
		const form = embed(
			`<form class="ec-form" method="POST" data-ec-form data-form-id="workshift">
				<fieldset data-page="0">
					<div class="ec-form-field">
						<select name="workshift" id="workshift">
							<option value="NPC" selected>NPC</option>
							<option value="Other">Other</option>
						</select>
					</div>
					<div class="ec-form-field" data-condition='{"field":"workshift","op":"eq","value":"Other"}'>
						<input type="text" name="details" class="ec-form-input" id="details" />
					</div>
				</fieldset>
			</form>`,
		);
		initForms();
		const select = form.querySelector<HTMLSelectElement>("select[name='workshift']")!;
		const wrapper = wrapperFor(form, "workshift");

		select.value = "Other";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		expect(wrapper.hidden).toBe(false);
		expect(getComputedStyle(wrapper).display).not.toBe("none");
	});

	test("hides conditional fields again when their condition becomes false", () => {
		const form = embed(
			`<form class="ec-form" method="POST" data-ec-form data-form-id="workshift">
				<fieldset data-page="0">
					<div class="ec-form-field">
						<select name="workshift" id="workshift">
							<option value="NPC">NPC</option>
							<option value="Other" selected>Other</option>
						</select>
					</div>
					<div class="ec-form-field" data-condition='{"field":"workshift","op":"eq","value":"Other"}'>
						<input type="text" name="details" class="ec-form-input" id="details" />
					</div>
				</fieldset>
			</form>`,
		);
		initForms();
		const select = form.querySelector<HTMLSelectElement>("select[name='workshift']")!;
		const wrapper = wrapperFor(form, "workshift");

		expect(wrapper.hidden).toBe(false);
		expect(getComputedStyle(wrapper).display).toBe("flex");

		select.value = "NPC";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		expect(wrapper.hidden).toBe(true);
		expect(getComputedStyle(wrapper).display).toBe("none");
	});

	describe.each(["checkbox", "radio"] as const)("%s controllers", (type) => {
		test.each([
			["eq", "enabled", false, true],
			["neq", "enabled", true, false],
			["filled", undefined, false, true],
			["empty", undefined, true, false],
		] as const)(
			"keeps %s conditions consistent with server validation",
			async (op, conditionValue, uncheckedVisible, checkedVisible) => {
				const value = conditionValue === undefined ? "" : `,"value":"${conditionValue}"`;
				const form = embed(
					`<form class="ec-form" method="POST" data-ec-form data-form-id="checkbox-condition">
				<fieldset data-page="0">
					<div class="ec-form-field">
						<input type="${type}" name="controller" value="enabled" />
					</div>
					<div class="ec-form-field" data-condition='{"field":"controller","op":"${op}"${value}}'>
						<input type="text" name="dependent" required />
					</div>
				</fieldset>
			</form>`,
				);
				initForms();

				const controller = form.querySelector<HTMLInputElement>("input[name='controller']")!;
				const dependent = form.querySelector<HTMLInputElement>("input[name='dependent']")!;
				const wrapper = wrapperFor(form, "controller");
				const fields = [
					{
						id: "controller",
						type,
						label: "Controller",
						name: "controller",
						required: false,
						width: "full" as const,
					},
					{
						id: "dependent",
						type: "text" as const,
						label: "Dependent",
						name: "dependent",
						required: true,
						width: "full" as const,
						condition: {
							field: "controller",
							op,
							...(conditionValue === undefined ? {} : { value: conditionValue }),
						},
					},
				];

				const assertState = async (visible: boolean) => {
					const payload = JSON.parse(await serializeSubmission(new FormData(form))) as {
						data: Record<string, unknown>;
					};
					const serverCondition = evaluateCondition(fields[1].condition!, payload.data);
					const result = validateSubmission(fields, payload.data);

					expect(wrapper.hidden).toBe(!visible);
					expect(dependent.disabled).toBe(!visible);
					expect(serverCondition).toBe(visible);
					expect(result.errors.some((error) => error.field === "dependent")).toBe(visible);
				};

				await assertState(uncheckedVisible);
				controller.checked = true;
				controller.dispatchEvent(new Event("change", { bubbles: true }));
				await assertState(checkedVisible);
				controller.checked = false;
				controller.dispatchEvent(new Event("change", { bubbles: true }));
				await assertState(uncheckedVisible);
			},
		);
	});

	test("disables inputs inside hidden conditional fields", () => {
		const form = embed(
			`<form class="ec-form" method="POST" data-ec-form data-form-id="workshift">
				<fieldset data-page="0">
					<div class="ec-form-field">
						<select name="workshift" id="workshift">
							<option value="NPC" selected>NPC</option>
							<option value="Other">Other</option>
						</select>
					</div>
					<div class="ec-form-field" data-condition='{"field":"workshift","op":"eq","value":"Other"}'>
						<input type="text" name="details" class="ec-form-input" id="details" />
					</div>
				</fieldset>
			</form>`,
		);
		initForms();
		const input = form.querySelector<HTMLInputElement>("input[name='details']")!;

		expect(input.disabled).toBe(true);
		expect(new FormData(form).has("details")).toBe(false);

		const select = form.querySelector<HTMLSelectElement>("select[name='workshift']")!;
		select.value = "Other";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		expect(input.disabled).toBe(false);
		expect(new FormData(form).has("details")).toBe(true);

		select.value = "NPC";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		expect(input.disabled).toBe(true);
		expect(new FormData(form).has("details")).toBe(false);
	});
});
