import { setupI18n, type I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { LoginForm, SetupStep } from "../../auth-atproto/src/admin.js";
import { messages as polishMessages } from "../src/locales/pl/messages.mjs";

// Sample translations for messages not yet translated in the shipped catalog.
const translated = {
	"/gyI39": "Uchwyt Atmosphere",
	J28zul: "Łączenie...",
	"9M2CU4": "Nie udało się rozpocząć logowania AT Protocol",
	jS2X6L: "Zaloguj się za pomocą uchwytu Bluesky/Atmosphere",
};

function testI18n() {
	return setupI18n({
		locale: "en",
		messages: { en: {}, pl: { ...polishMessages, ...translated } },
	});
}

function FormWithI18n({ children, i18n }: React.PropsWithChildren<{ i18n: I18n }>) {
	return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

async function renderLogin(i18n = testI18n()) {
	return render(
		<FormWithI18n i18n={i18n}>
			<LoginForm />
		</FormWithI18n>,
	);
}

async function renderSetup(i18n = testI18n()) {
	return render(
		<FormWithI18n i18n={i18n}>
			<SetupStep onComplete={vi.fn()} />
		</FormWithI18n>,
	);
}

const fetchMock = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
	fetchMock.mockReset();
});

afterEach(() => {
	fetchMock.mockReset();
});

describe("AT Protocol admin forms", () => {
	it("reuses the existing Polish sign-in translation and translates the login label", async () => {
		const i18n = testI18n();
		i18n.activate("pl");
		const screen = await renderLogin(i18n);

		await expect.element(screen.getByRole("textbox")).toHaveAccessibleName("Uchwyt Atmosphere");
		await expect.element(screen.getByRole("button")).toHaveTextContent("Zaloguj się");
	});

	it("renders translated SetupStep labels, button, and description", async () => {
		const i18n = testI18n();
		i18n.activate("pl");
		const screen = await renderSetup(i18n);

		await expect.element(screen.getByRole("textbox")).toHaveAccessibleName("Uchwyt Atmosphere");
		await expect.element(screen.getByRole("button")).toHaveTextContent("Zaloguj się");
		await expect
			.element(screen.getByText("Zaloguj się za pomocą uchwytu Bluesky/Atmosphere"))
			.toBeInTheDocument();
	});

	it.each([
		["LoginForm", renderLogin],
		["SetupStep", renderSetup],
	])("updates %s when the locale changes", async (_name, renderForm) => {
		const i18n = testI18n();
		const screen = await renderForm(i18n);

		await expect.element(screen.getByRole("button")).toHaveTextContent("Sign in");
		i18n.activate("pl");
		await expect.element(screen.getByRole("button")).toHaveTextContent("Zaloguj się");
		await expect.element(screen.getByRole("textbox")).toHaveAccessibleName("Uchwyt Atmosphere");
	});

	it.each([
		["LoginForm", renderLogin],
		["SetupStep", renderSetup],
	])("shows a translated pending button in %s", async (_name, renderForm) => {
		const pending = new Promise<Response>(() => undefined);
		fetchMock.mockReturnValue(pending);
		const i18n = testI18n();
		i18n.activate("pl");
		const screen = await renderForm(i18n);

		await screen.getByRole("textbox").fill("alice.bsky.social");
		await screen.getByRole("button", { name: "Zaloguj się" }).click();
		await expect.element(screen.getByRole("button")).toHaveTextContent("Łączenie...");
		expect(screen.getByRole("button").element()).toBeDisabled();
	});

	it.each([
		["LoginForm", renderLogin],
		["SetupStep", renderSetup],
	])("uses the translated fallback for malformed error bodies in %s", async (_name, renderForm) => {
		fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
		const i18n = testI18n();
		i18n.activate("pl");
		const screen = await renderForm(i18n);

		await screen.getByRole("textbox").fill("alice.bsky.social");
		await screen.getByRole("button", { name: "Zaloguj się" }).click();
		await expect
			.element(screen.getByText("Nie udało się rozpocząć logowania AT Protocol"))
			.toBeInTheDocument();
	});

	it.each([
		["LoginForm", renderLogin],
		["SetupStep", renderSetup],
	])(
		"uses the translated fallback for non-Error fetch rejections in %s",
		async (_name, renderForm) => {
			fetchMock.mockRejectedValue("network failure");
			const i18n = testI18n();
			i18n.activate("pl");
			const screen = await renderForm(i18n);

			await screen.getByRole("textbox").fill("alice.bsky.social");
			await screen.getByRole("button", { name: "Zaloguj się" }).click();
			await expect
				.element(screen.getByText("Nie udało się rozpocząć logowania AT Protocol"))
				.toBeInTheDocument();
		},
	);

	it.each([
		["LoginForm", renderLogin],
		["SetupStep", renderSetup],
	])("preserves a server error message in %s", async (_name, renderForm) => {
		const serverMessage = "This handle is not registered";
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { message: serverMessage } }), { status: 400 }),
		);
		const screen = await renderForm();

		await screen.getByRole("textbox").fill("alice.bsky.social");
		await screen.getByRole("button", { name: "Sign in" }).click();
		await expect.element(screen.getByText(serverMessage)).toBeInTheDocument();
	});
});
