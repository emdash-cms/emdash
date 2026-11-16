// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pages } from "../src/admin.js";

type Request = { route: string; body: Record<string, unknown>; resolve: (res: Response) => void };
let requests: Request[] = [];

vi.mock("@cloudflare/kumo", () => ({
	Badge: ({ children }: { children?: React.ReactNode }) => (
		<span data-testid="badge">{children}</span>
	),
	Button: ({ children, onClick, disabled, ...props }: React.ComponentProps<"button">) => (
		<button type="button" onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	Checkbox: ({ label }: { label: string }) => <input type="checkbox" aria-label={label} />,
	Input: ({ label, value, onChange }: React.ComponentProps<"input"> & { label?: string }) => (
		<input aria-label={label ?? "input"} value={value ?? ""} onChange={onChange} />
	),
	InputArea: () => null,
	Loader: () => <span role="status" />,
	Select: ({
		label,
		value,
		onValueChange,
		items,
		"aria-label": ariaLabel,
	}: {
		label?: string;
		value?: string;
		onValueChange: (value: string | undefined) => void;
		items: Array<{ label: string; value: string }>;
		"aria-label"?: string;
	}) => (
		<select
			aria-label={label ?? ariaLabel}
			value={value ?? ""}
			onChange={(e) => onValueChange(e.target.value)}
		>
			{items.map((item) => (
				<option key={item.value} value={item.value}>
					{item.label}
				</option>
			))}
		</select>
	),
}));

// Sample translations keyed by the IDs Lingui generates for the English messages.
const ja = {
	CiIFml: "フォーム",
	F6pfE9: "有効",
	"IgrLD/": "一時停止",
	ePK91l: "編集",
	dVuW4v: "フォームを編集",
	"7kzmXB": "編集中: {name}",
	nf0K9R: "チェックボックスグループ",
	IUwGEM: "変更を保存",
	LdA9gy: "送信内容",
	isRobC: "新規",
};

function testI18n() {
	const i18n = setupI18n({ locale: "en", messages: { en: {}, ja } });
	i18n.activate("ja");
	return i18n;
}

beforeEach(() => {
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(url: string, init: RequestInit) =>
				new Promise<Response>((resolve) => {
					requests.push({
						route: url.split("/emdash-forms/")[1] ?? url,
						body: typeof init.body === "string" ? JSON.parse(init.body) : {},
						resolve,
					});
				}),
		),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const ok = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), { status: 200 });

async function respond(route: string, data: unknown) {
	await waitFor(() => expect(requests.at(-1)?.route).toBe(route));
	requests.at(-1)!.resolve(ok(data));
}

const form = {
	id: "form-1",
	name: "Contact",
	slug: "contact",
	status: "active",
	submissionCount: 1,
	lastSubmissionAt: "2026-01-02T00:00:00Z",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
	pages: [
		{
			fields: [
				{
					id: "f1",
					type: "checkbox-group",
					label: "Topics",
					name: "topics",
					required: false,
					width: "full",
					options: [{ label: "A", value: "a" }],
				},
			],
		},
	],
	settings: {
		confirmationMessage: "Thanks",
		notifyEmails: [],
		digestEnabled: false,
		digestHour: 9,
		retentionDays: 0,
		spamProtection: "honeypot",
		submitLabel: "Send",
	},
};

function renderPage(path: "/" | "/submissions", withProvider = true) {
	const page = pages?.[path];
	expect(page).toBeTypeOf("function");
	const element = React.createElement(page!);
	return render(withProvider ? <I18nProvider i18n={testI18n()}>{element}</I18nProvider> : element);
}

describe("forms admin localization", () => {
	it("translates the list, status badge and editor while keeping stored values", async () => {
		renderPage("/");
		await respond("forms/list", { items: [form] });

		expect(await screen.findByRole("heading", { name: "フォーム" })).toBeTruthy();
		expect(screen.getByTestId("badge").textContent).toBe("有効");

		fireEvent.click(screen.getByRole("button", { name: "一時停止" }));
		await waitFor(() => expect(requests.at(-1)?.route).toBe("forms/update"));
		expect(requests.at(-1)!.body).toEqual({ id: "form-1", status: "paused" });
		requests.at(-1)!.resolve(ok({}));
		await respond("forms/list", { items: [form] });

		fireEvent.click(await screen.findByRole("button", { name: "編集" }));
		expect(screen.getByRole("heading", { name: "フォームを編集" })).toBeTruthy();
		expect(screen.getByText("編集中: Contact")).toBeTruthy();

		const type = screen.getByLabelText("Type") as HTMLSelectElement;
		expect(type.value).toBe("checkbox-group");
		expect(within(type).getByRole("option", { name: "チェックボックスグループ" })).toHaveProperty(
			"value",
			"checkbox-group",
		);

		fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
		await waitFor(() => expect(requests.at(-1)?.route).toBe("forms/update"));
		expect(requests.at(-1)!.body).toMatchObject({
			pages: [{ fields: [{ type: "checkbox-group", width: "full" }] }],
		});
	});

	it("translates submission status badges and keeps the stored status filter value", async () => {
		renderPage("/submissions");
		await respond("forms/list", { items: [form] });
		await respond("submissions/list", {
			items: [
				{
					id: "s1",
					formId: "form-1",
					data: { topics: "a" },
					status: "new",
					starred: false,
					createdAt: "2026-01-02T00:00:00Z",
					meta: { country: null },
				},
			],
		});

		expect(await screen.findByRole("heading", { name: "送信内容" })).toBeTruthy();
		await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("新規"));
		const filter = screen.getByLabelText("Filter by status");
		expect(within(filter).getByRole("option", { name: "新規" })).toHaveProperty("value", "new");
	});

	it("renders interpolated English when the host provides no Lingui context", async () => {
		renderPage("/", false);
		await respond("forms/list", { items: [form] });
		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		expect(screen.getByText("Editing: Contact")).toBeTruthy();
		expect(screen.getByRole("option", { name: "Checkbox group" })).toHaveProperty(
			"value",
			"checkbox-group",
		);
	});
});

// Plugin source is not run through the Lingui macro, so the IDs are written out.
// They must match the IDs Lingui generates (sha256 of message + unit separator +
// context, base64, first 6 characters) so existing catalog translations apply.
describe("forms admin message IDs", () => {
	const DESCRIPTOR = /\{\s*id: "([^"]+)",\s*message:\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
	const generateMessageId = (message: string) =>
		createHash("sha256").update(`${message}\u001F`).digest("base64").slice(0, 6);

	it.each(["../src/admin.tsx", "../src/admin-errors.ts"])("uses generated IDs in %s", (file) => {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		const descriptors = [...source.matchAll(DESCRIPTOR)];
		expect(descriptors.length).toBeGreaterThan(0);
		for (const [, id, doubleQuoted, singleQuoted] of descriptors) {
			const message =
				doubleQuoted === undefined ? singleQuoted! : (JSON.parse(`"${doubleQuoted}"`) as string);
			expect(id, message).toBe(generateMessageId(message));
		}
	});
});
