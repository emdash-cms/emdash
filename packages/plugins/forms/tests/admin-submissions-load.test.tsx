// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
	body: Record<string, unknown>;
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
			(url: string, init: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					requests.push({
						route: url.split("/emdash-forms/")[1] ?? url,
						body: JSON.parse(init.body as string),
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

describe.each([
	["Submissions page", pages!["/submissions"]!],
	["Recent Submissions widget", widgets!["recent-submissions"]!],
])("%s initial form", (_, Component) => {
	it("shows the latest submitted form instead of a newer empty form", async () => {
		render(<Component />);
		await settle(
			await nextRequest("forms/list"),
			ok({
				items: [
					{ ...form("b", "Empty B"), submissionCount: 0, lastSubmissionAt: null },
					{ ...form("c", "Older C"), lastSubmissionAt: "2026-09-01T00:00:00.000Z" },
					{ ...form("a", "Contact A"), lastSubmissionAt: "2026-10-01T00:00:00.000Z" },
					{ ...form("d", "Older D"), lastSubmissionAt: "2026-08-01T00:00:00.000Z" },
				],
			}),
		);
		const request = await nextRequest("submissions/list");
		expect(request.body.formId).toBe("a");
		await settle(request, ok({ items: [submission("s1", "Alice")] }));
		expect(screen.getByText("Alice")).toBeTruthy();
		expect(screen.queryByText("No submissions yet")).toBeNull();
	});

	it("ignores an empty form with a stale last submission timestamp", async () => {
		render(<Component />);
		await settle(
			await nextRequest("forms/list"),
			ok({
				items: [
					{
						...form("b", "Deleted submissions"),
						submissionCount: 0,
						lastSubmissionAt: "2026-10-02T00:00:00.000Z",
					},
					{ ...form("a", "Contact A"), lastSubmissionAt: "2026-10-01T00:00:00.000Z" },
				],
			}),
		);
		const request = await nextRequest("submissions/list");
		expect(request.body.formId).toBe("a");
		await settle(request, ok({ items: [submission("s1", "Alice")] }));
		expect(screen.getByText("Alice")).toBeTruthy();
	});

	it("falls back to the first form when no forms have submissions", async () => {
		render(<Component />);
		await settle(
			await nextRequest("forms/list"),
			ok({
				items: [
					{ ...form("b", "Empty B"), submissionCount: 0, lastSubmissionAt: null },
					{ ...form("a", "Empty A"), submissionCount: 0, lastSubmissionAt: null },
				],
			}),
		);
		const request = await nextRequest("submissions/list");
		expect(request.body.formId).toBe("b");
		await settle(request, ok({ items: [] }));
		expect(screen.getByText(/No submissions/)).toBeTruthy();
	});

	it("handles a site without forms", async () => {
		render(<Component />);
		await settle(await nextRequest("forms/list"), ok({ items: [] }));
		expect(screen.getByText(/No forms/)).toBeTruthy();
		expect(requests).toHaveLength(1);
	});
});

describe("Submissions permissions", () => {
	const SubmissionsPage = pages!["/submissions"]!;

	async function loadSubmissions(data: unknown): Promise<HTMLElement> {
		render(<SubmissionsPage />);
		await settle(await nextRequest("forms/list"), ok({ items: [form("a", "A")] }));
		const request = await nextRequest("submissions/list");
		await settle(request, ok(data));
		return screen.getByText("Alice");
	}

	it("hides all write and export controls for an Editor while keeping the row openable", async () => {
		const alice = await loadSubmissions({
			items: [{ ...submission("s1", "Alice"), starred: true }],
			canManage: false,
		});
		const row = alice.closest("tr")!;

		expect(screen.queryByText("CSV")).toBeNull();
		expect(screen.queryByText("JSON")).toBeNull();
		expect(screen.queryByRole("button", { name: "Toggle status" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		expect(screen.queryByText("Actions")).toBeNull();
		expect(row.querySelector("svg")).not.toBeNull();
		expect(within(row).queryAllByRole("button")).toHaveLength(0);
		fireEvent.click(row);
		expect(screen.getByText("Submission Detail")).toBeTruthy();
	});

	it("defaults to read-only when the capability is missing", async () => {
		await loadSubmissions({ items: [submission("s1", "Alice")] });

		expect(screen.queryByText("CSV")).toBeNull();
		expect(screen.queryByText("JSON")).toBeNull();
		expect(screen.queryByRole("button", { name: "Toggle status" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("does not expose controls while a new submissions list is loading", async () => {
		render(<SubmissionsPage />);
		await settle(await nextRequest("forms/list"), ok({ items: [form("a", "A")] }));
		await nextRequest("submissions/list");

		expect(screen.queryByText("CSV")).toBeNull();
		expect(screen.queryByText("JSON")).toBeNull();
		expect(screen.queryByRole("button", { name: "Toggle status" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("does not expose controls when loading submissions fails", async () => {
		render(<SubmissionsPage />);
		await settle(await nextRequest("forms/list"), ok({ items: [form("a", "A")] }));
		await settle(await nextRequest("submissions/list"), new Response("{}", { status: 500 }));

		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.queryByText("CSV")).toBeNull();
		expect(screen.queryByText("JSON")).toBeNull();
		expect(screen.queryByRole("button", { name: "Toggle status" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it.each(["read-only", "failure"])(
		"revokes controls when the next list is %s",
		async (outcome) => {
			await loadSubmissions({ items: [submission("s1", "Alice")], canManage: true });
			expect(screen.getByText("CSV")).toBeTruthy();
			fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), {
				target: { value: "new" },
			});
			const request = await nextRequest("submissions/list");
			expect(screen.queryByText("CSV")).toBeNull();
			await settle(
				request,
				outcome === "failure"
					? new Response("{}", { status: 500 })
					: ok({ items: [submission("s2", "Bob")], canManage: false }),
			);
			expect(screen.queryByText("CSV")).toBeNull();
			expect(screen.queryByText("JSON")).toBeNull();
			expect(screen.queryByRole("button", { name: "Toggle status" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		},
	);

	it("keeps submission actions available to an administrator", async () => {
		const alice = await loadSubmissions({
			items: [submission("s1", "Alice")],
			canManage: true,
		});
		const row = alice.closest("tr")!;

		expect(screen.getByText("CSV")).toBeTruthy();
		expect(screen.getByText("JSON")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Toggle status" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
		expect(screen.getByText("Actions")).toBeTruthy();

		fireEvent.click(within(row).getAllByRole("button")[0]!);
		await settle(await nextRequest("submissions/update"), ok({}));
		fireEvent.click(screen.getByRole("button", { name: "Toggle status" }));
		const update = await nextRequest("submissions/update");
		expect(update.body.status).toBe("read");
		await settle(update, ok({}));
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
