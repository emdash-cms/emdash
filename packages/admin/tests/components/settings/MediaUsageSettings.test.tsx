import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { render } from "../../utils/render.tsx";

const activationMocks = vi.hoisted(() => ({
	fetchStatus: vi.fn(),
	fetchProgress: vi.fn(),
	advance: vi.fn(),
}));
const currentUserMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/api/media-usage-activation.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../../src/lib/api/media-usage-activation.js")
	>("../../../src/lib/api/media-usage-activation.js");
	return {
		...actual,
		fetchMediaUsageActivationStatus: activationMocks.fetchStatus,
		fetchMediaUsageProgress: activationMocks.fetchProgress,
		advanceMediaUsageActivation: activationMocks.advance,
	};
});

vi.mock("../../../src/lib/api/current-user.js", () => ({
	useCurrentUser: currentUserMock,
}));

vi.mock("../../../src/components/settings/BackToSettingsLink.js", () => ({
	BackToSettingsLink: () => <a href="/settings">Back to Settings</a>,
}));

const { MEDIA_USAGE_ACTIVATION_QUERY_KEY, MediaUsageActivationRequestError } =
	await import("../../../src/lib/api/media-usage-activation.js");
const { MediaUsageSettings } =
	await import("../../../src/components/settings/MediaUsageSettings.js");

type ActivationState = "expanded" | "activating" | "active";

function status(state: ActivationState, options: { failed?: boolean } = {}) {
	return {
		state,
		collectionCursor: state === "activating" ? "posts" : null,
		attemptCount: state === "expanded" ? 0 : 1,
		drainConfirmedAt: state === "expanded" ? null : "2026-08-16T09:00:00.000Z",
		lastAttemptedAt: state === "expanded" ? null : "2026-08-16T09:00:00.000Z",
		lastErrorCode: options.failed ? ("MEDIA_USAGE_ACTIVATION_FAILED" as const) : null,
		leaseExpiresAt: null,
		activatedAt: state === "active" ? "2026-08-16T09:00:01.000Z" : null,
		updatedAt: "2026-08-16T09:00:01.000Z",
	};
}

function setCurrentUser(role: number | null, isLoading = false) {
	currentUserMock.mockReturnValue({
		data: role === null ? null : { id: "user-1", email: "admin@example.com", role },
		isLoading,
	});
}

async function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const screen = await render(
		<QueryClientProvider client={queryClient}>
			<MediaUsageSettings />
		</QueryClientProvider>,
	);
	return { queryClient, screen };
}

async function openConfirmation(screen: Awaited<ReturnType<typeof renderPage>>["screen"]) {
	await userEvent.click(screen.getByRole("button", { name: "Enable Media Usage" }));
	await expect.element(screen.getByRole("dialog", { name: "Enable Media Usage" })).toBeVisible();
}

async function confirmAll(screen: Awaited<ReturnType<typeof renderPage>>["screen"]) {
	const dialog = screen.getByRole("dialog", { name: "Enable Media Usage" });
	for (const checkbox of [
		dialog.getByRole("checkbox", { name: /Background tasks are running/ }),
		dialog.getByRole("checkbox", { name: /Editing and direct database writes are paused/ }),
		dialog.getByRole("checkbox", { name: /can’t be cancelled or reset/ }),
	]) {
		checkbox.element().focus();
		await userEvent.keyboard(" ");
	}
}

async function submitConfirmation(screen: Awaited<ReturnType<typeof renderPage>>["screen"]) {
	const confirm = screen.getByRole("button", { name: "Enable and start indexing" });
	confirm.element().focus();
	await userEvent.keyboard("{Enter}");
}

describe("MediaUsageSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setCurrentUser(50);
		activationMocks.fetchStatus.mockResolvedValue(status("expanded"));
		activationMocks.fetchProgress.mockResolvedValue({
			status: "indexing",
			readyCollections: 1,
			totalCollections: 2,
		});
	});

	it("denies a direct Editor visit before requesting activation status", async () => {
		setCurrentUser(40);

		const { screen } = await renderPage();

		await expect
			.element(screen.getByRole("heading", { name: "Access denied" }))
			.toBeInTheDocument();
		expect(activationMocks.fetchStatus).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Enable Media Usage" }).query()).toBeNull();
	});

	it("keeps safety confirmations behind one clear enable action", async () => {
		const activating = status("activating");
		activationMocks.advance.mockResolvedValue({
			outcome: "activating",
			processedCollections: 1,
			activation: activating,
		});
		const { queryClient, screen } = await renderPage();

		await expect.element(screen.getByText("Automatic indexing is off")).toBeInTheDocument();
		expect(screen.getByRole("checkbox").query()).toBeNull();
		await openConfirmation(screen);
		const confirm = screen.getByRole("button", { name: "Enable and start indexing" });
		await expect.element(confirm).toBeDisabled();
		await confirmAll(screen);
		await expect.element(confirm).toBeEnabled();
		confirm.element().focus();
		await userEvent.keyboard("{Enter}");

		await expect
			.element(screen.getByRole("button", { name: "Continue setup" }))
			.toBeInTheDocument();
		expect(screen.getByRole("dialog").query()).toBeNull();
		expect(activationMocks.advance).toHaveBeenCalledOnce();
		expect(activationMocks.advance).toHaveBeenCalledWith({
			writersDrained: true,
			maintenanceReady: true,
		});
		expect(activationMocks.fetchStatus).toHaveBeenCalledOnce();
		expect(queryClient.getQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY)).toEqual(activating);

		await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));
		expect(activationMocks.advance).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("dialog").query()).toBeNull();
	});

	it("blocks duplicate activation and renders the confirmed active state", async () => {
		let resolveAdvance!: (value: unknown) => void;
		activationMocks.advance.mockImplementation(
			() => new Promise((resolve) => (resolveAdvance = resolve)),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);

		await submitConfirmation(screen);
		const pending = screen.getByRole("button", { name: "Enabling…" });
		await expect.element(pending).toBeDisabled();
		pending.element().click();
		expect(activationMocks.advance).toHaveBeenCalledOnce();
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		window.dispatchEvent(new PageTransitionEvent("pageshow"));
		expect(activationMocks.fetchStatus).toHaveBeenCalledOnce();

		resolveAdvance({ outcome: "active", processedCollections: 1, activation: status("active") });
		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /setup/i }).query()).toBeNull();
	});

	it("clears safety confirmations when the dialog is cancelled", async () => {
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.element().focus();
		await userEvent.keyboard("{Enter}");

		await openConfirmation(screen);
		for (const checkbox of screen.getByRole("checkbox").all()) {
			await expect.element(checkbox).not.toBeChecked();
		}
	});

	it("resets confirmations after leaving and returning", async () => {
		activationMocks.advance.mockResolvedValue({
			outcome: "activating",
			processedCollections: 1,
			activation: status("activating"),
		});
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		await submitConfirmation(screen);

		activationMocks.fetchStatus.mockResolvedValue(status("activating"));
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		window.dispatchEvent(new PageTransitionEvent("pageshow"));
		await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));

		await expect.element(screen.getByRole("dialog", { name: "Enable Media Usage" })).toBeVisible();
		for (const checkbox of screen.getByRole("checkbox").all()) {
			await expect.element(checkbox).not.toBeChecked();
		}
	});

	it("recovers an ambiguous activation response with one status read", async () => {
		activationMocks.advance.mockRejectedValue(
			new MediaUsageActivationRequestError("advance_failure", 500),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		activationMocks.fetchStatus.mockResolvedValue(status("active"));

		await submitConfirmation(screen);

		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeInTheDocument();
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
		expect(activationMocks.advance).toHaveBeenCalledOnce();
	});

	it("keeps writers paused when an ambiguous response cannot be confirmed", async () => {
		activationMocks.advance.mockRejectedValue(
			new MediaUsageActivationRequestError("advance_failure", 500),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		activationMocks.fetchStatus.mockRejectedValue(
			new MediaUsageActivationRequestError("read_failure", 500),
		);

		await submitConfirmation(screen);

		await expect
			.element(
				screen.getByText(
					"Activation cannot be confirmed. Keep editing paused and refresh the status.",
				),
			)
			.toBeInTheDocument();
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
	});

	it("keeps validation blocking after leaving and returning", async () => {
		activationMocks.advance.mockRejectedValue(
			new MediaUsageActivationRequestError("validation", 400),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		await submitConfirmation(screen);
		await expect
			.element(screen.getByText("Reload after updating EmDash before trying again."))
			.toBeInTheDocument();

		activationMocks.fetchStatus.mockResolvedValue(status("activating"));
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		window.dispatchEvent(new PageTransitionEvent("pageshow"));

		await expect
			.element(screen.getByText("Reload after updating EmDash before trying again."))
			.toBeInTheDocument();
		expect(activationMocks.advance).toHaveBeenCalledOnce();
	});

	it("does not move focus when an already-active page first loads", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));

		const { screen } = await renderPage();
		const heading = screen.getByRole("heading", { name: "Indexing existing content" });
		await expect.element(heading).toBeInTheDocument();
		expect(document.activeElement).not.toBe(heading.element());
	});

	it.each([
		["indexing", "Indexing existing content", "1 of 2 content types ready"],
		["ready", "Media Usage is ready", "2 of 2 content types ready"],
		["needs_attention", "Media Usage needs attention", "1 of 2 content types ready"],
	] as const)("shows %s progress after activation", async (progressStatus, heading, summary) => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.fetchProgress.mockResolvedValue({
			status: progressStatus,
			readyCollections: progressStatus === "ready" ? 2 : 1,
			totalCollections: 2,
		});

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
		await expect.element(screen.getByText(summary)).toBeInTheDocument();
		expect(activationMocks.fetchProgress).toHaveBeenCalledOnce();
	});

	it("keeps active setup visible when progress cannot be loaded", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.fetchProgress.mockRejectedValue(
			new MediaUsageActivationRequestError("read_failure", 500),
		);

		const { screen } = await renderPage();

		await expect
			.element(screen.getByRole("heading", { name: "Indexing progress unavailable" }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /setup/i }).query()).toBeNull();
	});

	it("keeps a busy request resumable through deliberate refresh", async () => {
		activationMocks.advance.mockRejectedValue(new MediaUsageActivationRequestError("busy", 409));
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await confirmAll(screen);
		await submitConfirmation(screen);

		await expect
			.element(screen.getByRole("button", { name: "Refresh status" }))
			.toBeInTheDocument();
		activationMocks.fetchStatus.mockResolvedValue(status("activating"));
		await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
		await expect.element(screen.getByRole("button", { name: "Continue setup" })).toBeEnabled();
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
	});
});
