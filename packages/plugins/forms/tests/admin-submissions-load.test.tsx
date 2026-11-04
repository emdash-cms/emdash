// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pages, widgets } from "../src/admin.js";

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

interface PendingRequest {
	route: string;
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
}

let requests: PendingRequest[] = [];
let taken = 0;

beforeEach(() => {
	requests = [];
	taken = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(url: string) =>
				new Promise<Response>((resolve, reject) => {
					requests.push({
						route: url.split("/emdash-forms/")[1] ?? url,
						resolve,
						reject,
					});
				}),
		),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function ok(data: unknown): Response {
	return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

function form(id: string, name: string) {
	return { id, name, submissionCount: 1 };
}

function submission(id: string, name: string) {
	return {
		id,
		formId: "a",
		data: { name },
		status: "new",
		starred: false,
		createdAt: "2026-10-01T00:00:00.000Z",
		meta: { country: null },
	};
}

/** An ok response whose JSON body is sent only when `finish` is called. */
function heldBody(): { response: Response; finish: (data: unknown) => void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start: (c) => {
			controller = c;
		},
	});
	return {
		response: new Response(stream, { status: 200 }),
		finish: (data) => {
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ success: true, data })));
			controller.close();
		},
	};
}

async function nextRequest(route: string): Promise<PendingRequest> {
	await vi.waitFor(() => expect(requests.length).toBeGreaterThan(taken));
	const request = requests[taken++]!;
	expect(request.route).toBe(route);
	return request;
}

async function settle(request: PendingRequest, outcome: Response | Error) {
	await act(async () => {
		if (outcome instanceof Error) request.reject(outcome);
		else request.resolve(outcome);
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

const lateOutcomes: [string, () => Response | Error][] = [
	["succeeds", () => ok({ items: [submission("s1", "Alice")] })],
	["fails", () => new Response("{}", { status: 500 })],
	["throws", () => new TypeError("Failed to fetch")],
];

describe.each([
	{
		change: "switching forms",
		apply: () =>
			fireEvent.change(screen.getByRole("combobox", { name: "Select form" }), {
				target: { value: "b" },
			}),
	},
	{
		change: "changing the status filter",
		apply: () =>
			fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), {
				target: { value: "new" },
			}),
	},
])("Submissions page after $change", ({ apply }) => {
	const SubmissionsPage = pages!["/submissions"]!;

	async function openPage(): Promise<PendingRequest> {
		render(<SubmissionsPage />);
		await settle(await nextRequest("forms/list"), ok({ items: [form("a", "A"), form("b", "B")] }));
		return nextRequest("submissions/list");
	}

	it.each(lateOutcomes)(
		"keeps the current list when the earlier request %s later",
		async (_, outcome) => {
			const earlier = await openPage();
			apply();
			await settle(await nextRequest("submissions/list"), ok({ items: [submission("s2", "Bob")] }));
			await settle(earlier, outcome());

			expect(screen.getByText("Bob")).toBeTruthy();
			expect(screen.queryByText("Alice")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		},
	);

	it("keeps the current list when the earlier response body arrives later", async () => {
		const earlier = await openPage();
		const body = heldBody();
		await settle(earlier, body.response);
		apply();
		await settle(await nextRequest("submissions/list"), ok({ items: [submission("s2", "Bob")] }));
		await act(async () => {
			body.finish({ items: [submission("s1", "Alice")] });
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.queryByText("Alice")).toBeNull();
	});

	it("keeps loading when the earlier request finishes first", async () => {
		const earlier = await openPage();
		apply();
		const current = await nextRequest("submissions/list");
		await settle(earlier, ok({ items: [submission("s1", "Alice")] }));

		expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
		expect(screen.queryByText("Alice")).toBeNull();

		await settle(current, ok({ items: [submission("s2", "Bob")] }));
		expect(screen.getByText("Bob")).toBeTruthy();
	});
});

describe("Recent Submissions widget", () => {
	const RecentSubmissionsWidget = widgets!["recent-submissions"]!;

	it("reports a failed submissions request as a submissions error", async () => {
		render(<RecentSubmissionsWidget />);
		await settle(await nextRequest("forms/list"), ok({ items: [form("a", "A")] }));
		await settle(await nextRequest("submissions/list"), new TypeError("Failed to fetch"));

		expect(screen.getByText("Failed to load submissions")).toBeTruthy();
	});
});
