// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RouteContext } from "emdash";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pages } from "../src/admin.js";
import { formsListHandler } from "../src/handlers/forms.js";
import {
	exportHandler,
	submissionDeleteHandler,
	submissionUpdateHandler,
	submissionsListHandler,
} from "../src/handlers/submissions.js";
import { createPlugin } from "../src/index.js";
import type { FormDefinition, Submission } from "../src/types.js";

// The built core pulls in Astro virtual modules that a jsdom test cannot resolve. The page
// and the handlers only need these three exports, so the route table stays the real one.
vi.mock("emdash", () => ({
	definePlugin: (definition: unknown) => definition,
	after: () => {},
	PluginRouteError: class extends Error {
		static notFound(message: string) {
			return new this(message);
		}
	},
}));

vi.mock("@cloudflare/kumo", () => ({
	Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
	Button: ({
		children,
		onClick,
		disabled,
		"aria-label": ariaLabel,
	}: {
		children?: React.ReactNode;
		onClick?: React.MouseEventHandler;
		disabled?: boolean;
		"aria-label"?: string;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
			{children}
		</button>
	),
	Checkbox: () => null,
	Input: () => null,
	Loader: () => <div role="status" aria-label="Loading" />,
	Select: ({
		value,
		onValueChange,
		items,
		"aria-label": ariaLabel,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		items: { label: string; value: string }[];
		"aria-label": string;
	}) => (
		<select aria-label={ariaLabel} value={value} onChange={(e) => onValueChange(e.target.value)}>
			{items.map((item) => (
				<option key={item.value} value={item.value}>
					{item.label}
				</option>
			))}
		</select>
	),
}));

const ADMIN = 50;
const EDITOR = 40;

/**
 * The lowest role that holds each permission a forms route can declare
 * (`packages/auth/src/rbac.ts`). An unknown permission throws, so a route that starts
 * using a new one has to be added here.
 */
const ROLE_NEEDED: Record<string, number> = {
	"plugins:read": EDITOR,
	"content:edit_any": EDITOR,
	"plugins:manage": ADMIN,
};

const routes = createPlugin().routes;

/** Mirrors the core dispatch rule: a private route without `permission` needs plugins:manage. */
function roleNeeded(route: string): number {
	const meta = routes[route];
	if (!meta) throw new Error(`Route "${route}" is not registered`);
	const permission = meta.public ? undefined : (meta.permission ?? "plugins:manage");
	if (permission === undefined) return 0;
	const needed = ROLE_NEEDED[permission];
	if (needed === undefined) throw new Error(`No role mapped for permission "${permission}"`);
	return needed;
}

function memoryCollection<T>(initial: Record<string, T>) {
	const rows = new Map(Object.entries(initial));
	return {
		get: async (id: string) => rows.get(id) ?? null,
		put: async (id: string, value: T) => {
			rows.set(id, value);
		},
		delete: async (id: string) => rows.delete(id),
		count: async () => rows.size,
		query: async () => ({
			items: Array.from(rows, ([id, data]) => ({ id, data })),
			hasMore: false,
			cursor: undefined,
		}),
	};
}

function storedForm(): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		pages: [{ fields: [] }],
		settings: {
			confirmationMessage: "Thanks.",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 30,
			spamProtection: "honeypot",
			submitLabel: "Send",
		},
		status: "active",
		submissionCount: 1,
		lastSubmissionAt: "2026-10-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function storedSubmission(): Submission {
	return {
		formId: "form-1",
		data: { name: "Alice" },
		status: "new",
		starred: false,
		createdAt: "2026-10-01T00:00:00.000Z",
		meta: { ip: "203.0.113.7", userAgent: "Mozilla/5.0", country: "DE" },
	};
}

const handlers: Record<string, (ctx: never) => Promise<unknown>> = {
	"forms/list": formsListHandler,
	"submissions/list": submissionsListHandler,
	"submissions/update": submissionUpdateHandler,
	"submissions/delete": submissionDeleteHandler,
	"submissions/export": exportHandler,
};

/**
 * Stands in for the server: applies the route's real permission for `role`, then runs the
 * real handler against in-memory storage, as the core dispatcher does.
 */
function serverAs(role: number) {
	const storage = {
		forms: memoryCollection({ "form-1": storedForm() }),
		submissions: memoryCollection({ "sub-1": storedSubmission() }),
	};
	return vi.fn(async (url: string, init: RequestInit) => {
		const route = url.split("/emdash-forms/")[1] ?? url;
		if (role < roleNeeded(route)) {
			return new Response(
				JSON.stringify({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } }),
				{ status: 403 },
			);
		}
		const handler = handlers[route];
		if (!handler) throw new Error(`No handler for route "${route}"`);
		const ctx = { input: JSON.parse(init.body as string), storage, user: { role } };
		const data = await handler(ctx as unknown as RouteContext as never);
		return new Response(JSON.stringify({ success: true, data }), { status: 200 });
	});
}

const pause = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

async function openSubmissionsPageAs(role: number) {
	vi.stubGlobal("fetch", serverAs(role));
	vi.stubGlobal("confirm", () => true);
	const SubmissionsPage = pages!["/submissions"]!;
	render(<SubmissionsPage />);
	await vi.waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
}

function describeControl(button: HTMLElement): string {
	return button.getAttribute("aria-label") ?? (button.textContent?.trim() || "star");
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Submissions page controls", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("offers an Editor only controls the API accepts", async () => {
		await openSubmissionsPageAs(EDITOR);

		const refused: string[] = [];
		const controls = screen.getAllByRole("button");
		expect(controls.length).toBeGreaterThan(0);
		for (const control of controls) {
			fireEvent.click(control);
			await pause();
			if (screen.queryByRole("alert")) refused.push(describeControl(control));
		}

		expect(refused).toEqual([]);
	});

	it("lets an Editor star a submission", async () => {
		await openSubmissionsPageAs(EDITOR);

		const star = screen.getAllByRole("row")[1]!.querySelector("button")!;
		const before = star.innerHTML;
		fireEvent.click(star);
		await pause();

		expect(screen.queryByRole("alert")?.textContent).toBeUndefined();
		expect(star.innerHTML).not.toBe(before);
	});

	it("lets an Editor change the status", async () => {
		await openSubmissionsPageAs(EDITOR);

		fireEvent.click(screen.getByRole("button", { name: "Toggle status" }));
		await pause();

		expect(screen.queryByRole("alert")?.textContent).toBeUndefined();
		expect(screen.getAllByText("read").length).toBeGreaterThan(0);
	});

	it("keeps star, status, delete and export for an Admin", async () => {
		await openSubmissionsPageAs(ADMIN);

		expect(screen.getByRole("button", { name: "Toggle status" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "CSV" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "JSON" })).toBeTruthy();

		fireEvent.click(screen.getAllByRole("row")[1]!.querySelector("button")!);
		await pause();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
