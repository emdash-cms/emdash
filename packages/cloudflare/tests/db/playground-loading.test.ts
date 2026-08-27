import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPlaygroundLoadingPage } from "../../src/db/playground-loading.js";

interface FakeElement {
	className: string;
	style: { display: string };
	textContent: string;
	addEventListener: () => void;
}

function createElement(): FakeElement {
	return {
		className: "",
		style: { display: "" },
		textContent: "",
		addEventListener: () => undefined,
	};
}

describe("playground loading progress", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reserves the setup message width when the status changes", () => {
		const html = renderPlaygroundLoadingPage();
		const message = html.match(/<div class="pg-message">([\s\S]*?)<\/div>/)?.[1];

		expect(message).toContain('id="pg-message"');
		expect(message).toContain('class="pg-message-measure" aria-hidden="true"');
		expect(message?.match(/Creating your playground/g)).toHaveLength(2);
	});

	it("advances only when the server reports completed initialization phases", async () => {
		vi.useFakeTimers();
		const elements = new Map(
			[
				"step-db",
				"step-content",
				"step-ready",
				"pg-message",
				"pg-steps",
				"pg-error",
				"pg-error-message",
				"pg-retry",
			].map((id) => [id, createElement()]),
		);
		elements.get("step-db")!.className = "pg-step active";
		elements.get("step-content")!.className = "pg-step";
		elements.get("step-ready")!.className = "pg-step";
		elements.get("pg-message")!.textContent = "Creating your playground…";

		let streamController!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
		});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(body, {
				headers: { "content-type": "application/x-ndjson" },
			}),
		);
		const replace = vi.fn();

		vi.stubGlobal("document", {
			getElementById: (id: string) => elements.get(id) ?? null,
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("location", { replace });

		const html = renderPlaygroundLoadingPage();
		const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
		expect(script).toBeDefined();
		// oxlint-disable-next-line typescript/no-implied-eval -- executes the rendered inline script in a controlled test environment
		new Function(script!)();
		await Promise.resolve();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(elements.get("step-db")!.className).toBe("pg-step active");
		expect(elements.get("step-content")!.className).toBe("pg-step");
		expect(elements.get("step-ready")!.className).toBe("pg-step");

		const encoder = new TextEncoder();
		streamController.enqueue(encoder.encode('{"step":"database"}\n'));
		await vi.advanceTimersByTimeAsync(900);
		expect(elements.get("step-db")!.className).toBe("pg-step done");
		expect(elements.get("step-content")!.className).toBe("pg-step active");

		streamController.enqueue(encoder.encode('{"step":"content"}\n'));
		await vi.advanceTimersByTimeAsync(900);
		expect(elements.get("step-content")!.className).toBe("pg-step done");
		expect(elements.get("step-ready")!.className).toBe("pg-step active");
		expect(elements.get("pg-message")!.textContent).toBe("Creating your playground…");

		streamController.enqueue(encoder.encode('{"step":"ready"}\n'));
		streamController.close();
		await vi.advanceTimersByTimeAsync(400);
		expect(elements.get("step-ready")!.className).toBe("pg-step done");
		expect(elements.get("pg-message")!.textContent).toBe("Ready!");
		expect(replace).toHaveBeenCalledWith("/_emdash/admin");
	});
});
