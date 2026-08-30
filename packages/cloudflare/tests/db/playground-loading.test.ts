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
		const message = html.match(/<div class="pg-message"[\s\S]*?<\/div>/)?.[0];

		expect(message).toContain('id="pg-message"');
		expect(message).toContain('class="pg-message-measure" aria-hidden="true"');
		expect(message?.match(/Creating your playground/g)).toHaveLength(2);
	});

	it("announces status and error changes", () => {
		const html = renderPlaygroundLoadingPage();

		expect(html).toContain('class="pg-message" role="status" aria-live="polite"');
		expect(html).toContain('id="pg-error-message" role="alert"');
	});

	it("animates cosmetic setup stages without delaying a completed setup", async () => {
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

		let resolveSetup!: (response: Response) => void;
		const setup = new Promise<Response>((resolve) => {
			resolveSetup = resolve;
		});
		const fetchMock = vi.fn().mockReturnValue(setup);
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

		await vi.advanceTimersByTimeAsync(800);
		expect(elements.get("step-db")!.className).toBe("pg-step completing");
		await vi.advanceTimersByTimeAsync(150);
		expect(elements.get("step-content")!.className).toBe("pg-step active");

		resolveSetup(Response.json({ ok: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(elements.get("step-db")!.className).toBe("pg-step done");
		expect(elements.get("step-content")!.className).toBe("pg-step done");
		expect(elements.get("step-ready")!.className).toBe("pg-step completing");
		expect(elements.get("pg-message")!.textContent).toBe("Ready!");
		expect(replace).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(399);
		expect(elements.get("step-ready")!.className).toBe("pg-step completing");
		expect(replace).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(elements.get("step-ready")!.className).toBe("pg-step done");
		expect(replace).toHaveBeenCalledWith("/_emdash/admin");
	});
});
