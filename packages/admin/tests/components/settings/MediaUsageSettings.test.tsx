import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { render } from "../../utils/render.tsx";

const activationMocks = vi.hoisted(() => ({
	fetchStatus: vi.fn(),
	fetchProgress: vi.fn(),
	advance: vi.fn(),
	advanceProgress: vi.fn(),
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
		advanceMediaUsageProgress: activationMocks.advanceProgress,
	};
});

vi.mock("../../../src/lib/api/current-user.js", () => ({
	useCurrentUser: currentUserMock,
}));

vi.mock("../../../src/components/settings/BackToSettingsLink.js", () => ({
	BackToSettingsLink: () => <a href="/settings">Back to Settings</a>,
}));

const {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MEDIA_USAGE_PROGRESS_QUERY_KEY,
	MediaUsageActivationRequestError,
} = await import("../../../src/lib/api/media-usage-activation.js");
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

function createQueryClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

async function renderPage(queryClient = createQueryClient()) {
	const screen = await render(
		<QueryClientProvider client={queryClient}>
			<MediaUsageSettings />
		</QueryClientProvider>,
	);
	return { queryClient, screen };
}

async function openConfirmation(screen: Awaited<ReturnType<typeof renderPage>>["screen"]) {
	await userEvent.click(screen.getByRole("button", { name: "Enable Media Usage" }));
	await expect.element(screen.getByRole("dialog", { name: "Turn on Media Usage?" })).toBeVisible();
	await expect
		.element(
			screen.getByText(
				"EmDash will scan existing content to show where media is used. Keep this page open until setup finishes; returning to this page continues where it stopped. Once enabled, it can’t be turned off.",
			),
		)
		.toBeVisible();
}

async function submitConfirmation(screen: Awaited<ReturnType<typeof renderPage>>["screen"]) {
	const confirm = screen.getByRole("dialog", { name: "Turn on Media Usage?" }).getByRole("button", {
		name: "Turn on",
	});
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
			indexingStarted: true,
		});
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
				indexingStarted: true,
			},
			nextRequestInMs: null,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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

	it("uses one native confirmation before enabling Media Usage", async () => {
		const activating = status("activating");
		activationMocks.advance.mockResolvedValue({
			outcome: "activating",
			processedCollections: 1,
			activation: activating,
		});
		const { screen } = await renderPage();

		await expect.element(screen.getByText("Automatic indexing is off")).toBeInTheDocument();
		expect(screen.getByRole("checkbox").query()).toBeNull();
		await openConfirmation(screen);
		const confirm = screen
			.getByRole("dialog", { name: "Turn on Media Usage?" })
			.getByRole("button", { name: "Turn on" });
		await expect.element(confirm).toBeEnabled();
		expect(screen.getByRole("checkbox").query()).toBeNull();
		confirm.element().focus();
		await userEvent.keyboard("{Enter}");

		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /setup/i }).query()).toBeNull();
		expect(screen.getByRole("dialog").query()).toBeNull();
		expect(activationMocks.advance).toHaveBeenCalledOnce();
		expect(activationMocks.advance).toHaveBeenCalledWith({
			writersDrained: true,
		});
		expect(activationMocks.fetchStatus).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());
	});

	it("reads durable Ready without advancing when an already-ready page opens", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.fetchProgress.mockResolvedValue({
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
			indexingStarted: true,
		});
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: "ready",
				readyCollections: 2,
				totalCollections: 2,
				indexingStarted: true,
			},
			nextRequestInMs: null,
		});

		const { queryClient, screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(activationMocks.fetchProgress).toHaveBeenCalledOnce();
		expect(activationMocks.advanceProgress).not.toHaveBeenCalled();
		expect(queryClient.getQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY)).toEqual(
			expect.objectContaining({ status: "ready" }),
		);
	});

	it("keeps cached Ready visible while revisit status reads are in flight", async () => {
		let finishStatus!: (value: ReturnType<typeof status>) => void;
		activationMocks.fetchStatus.mockImplementation(
			() => new Promise((resolve) => (finishStatus = resolve)),
		);
		activationMocks.fetchProgress.mockResolvedValue({
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
			indexingStarted: true,
		});
		const queryClient = createQueryClient();
		queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, status("active"));
		queryClient.setQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY, {
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
			indexingStarted: true,
		});

		const { screen } = await renderPage(queryClient);

		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(screen.getByRole("heading", { name: "Indexing existing content" }).query()).toBeNull();
		expect(activationMocks.advanceProgress).not.toHaveBeenCalled();

		finishStatus(status("active"));
		await vi.waitFor(() => expect(activationMocks.fetchProgress).toHaveBeenCalledOnce());
		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(activationMocks.advanceProgress).not.toHaveBeenCalled();
	});

	it("does not claim indexing while the first durable progress read is pending", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		let finishProgress!: (value: {
			status: "ready";
			readyCollections: number;
			totalCollections: number;
			indexingStarted: true;
		}) => void;
		activationMocks.fetchProgress.mockImplementation(
			() => new Promise((resolve) => (finishProgress = resolve)),
		);

		const { screen } = await renderPage();

		await vi.waitFor(() => expect(activationMocks.fetchProgress).toHaveBeenCalledOnce());
		await expect.element(screen.getByText("Loading Media Usage settings…")).toBeVisible();
		expect(screen.getByRole("heading", { name: "Indexing existing content" }).query()).toBeNull();
		expect(activationMocks.advanceProgress).not.toHaveBeenCalled();

		finishProgress({
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
			indexingStarted: true,
		});
		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
	});

	it("follows an existing continuation even when the page already shows Ready", async () => {
		vi.useFakeTimers();
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: 0,
			})
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});

		await renderPage();
		await vi.advanceTimersByTimeAsync(0);

		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2));
	});

	it("blocks duplicate activation and renders the confirmed active state", async () => {
		let resolveAdvance!: (value: unknown) => void;
		activationMocks.advance.mockImplementation(
			() => new Promise((resolve) => (resolveAdvance = resolve)),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);

		await submitConfirmation(screen);
		const pending = screen.getByRole("button", { name: "Turning on…" });
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

	it("returns focus to the enable action when the dialog is cancelled", async () => {
		const { screen } = await renderPage();
		const trigger = screen.getByRole("button", { name: "Enable Media Usage" });
		await expect.element(trigger).toBeVisible();
		trigger.element().focus();
		await userEvent.keyboard("{Enter}");
		await expect
			.element(screen.getByRole("dialog", { name: "Turn on Media Usage?" }))
			.toBeVisible();
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.element().focus();
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(trigger.element());
	});

	it("closes the confirmation when the page is hidden", async () => {
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const { screen } = await renderPage();
		await openConfirmation(screen);

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
	});

	it("recovers an ambiguous activation response with one status read", async () => {
		activationMocks.advance.mockRejectedValue(
			new MediaUsageActivationRequestError("advance_failure", 500),
		);
		const { screen } = await renderPage();
		await openConfirmation(screen);
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
		["indexing", "Indexing existing content", "Content types ready: 1 of 2"],
		["ready", "Ready", "Content types ready: 2 of 2"],
		[
			"needs_attention",
			"Needs attention",
			"Check the server logs, then use the Media Usage recovery API for the failed work.",
		],
	] as const)("shows %s progress after activation", async (progressStatus, heading, summary) => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: progressStatus,
				readyCollections: progressStatus === "ready" ? 2 : 1,
				totalCollections: 2,
				indexingStarted: true,
			},
			nextRequestInMs: progressStatus === "needs_attention" ? 0 : null,
		});

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
		await expect.element(screen.getByText(summary)).toBeInTheDocument();
		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();
		if (progressStatus === "needs_attention") {
			expect(screen.getByRole("button", { name: "Retry setup" }).query()).toBeNull();
			expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
		}
	});

	it("renders progress counts with an incomplete non-English catalog", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
				indexingStarted: true,
			},
			nextRequestInMs: null,
		});
		i18n.loadAndActivate({ locale: "de", messages: {} });

		try {
			const { screen } = await renderPage();

			await expect.element(screen.getByText("Content types ready: 1 of 2")).toBeVisible();
		} finally {
			i18n.loadAndActivate({ locale: "en", messages: {} });
		}
	});

	it("keeps finalization in the indexing state", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
				indexingStarted: true,
				finalizing: true,
			},
			nextRequestInMs: null,
		});

		const { screen } = await renderPage();

		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeVisible();
		await expect.element(screen.getByText("Content types ready: 1 of 2")).toBeVisible();
	});

	it("shows indexing while historical reconciliation starts", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: {
				status: "indexing",
				readyCollections: 0,
				totalCollections: 2,
				indexingStarted: false,
			},
			nextRequestInMs: null,
		});

		const { screen } = await renderPage();

		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeVisible();
	});

	it("treats an older progress response as indexing rather than startup", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: { status: "indexing", readyCollections: 0, totalCollections: 2 },
			nextRequestInMs: null,
		});

		const { screen } = await renderPage();

		await expect
			.element(screen.getByRole("heading", { name: "Indexing existing content" }))
			.toBeVisible();
	});

	it("shows Retry setup only for a stored activation failure", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("activating", { failed: true }));

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Needs attention" })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Retry setup" }));
		const dialog = screen.getByRole("dialog", { name: "Retry setup?" });
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole("button", { name: "Retry setup" })).toBeEnabled();
		expect(dialog.getByRole("checkbox").query()).toBeNull();
		expect(activationMocks.advanceProgress).not.toHaveBeenCalled();
	});

	it("restarts progress after retrying a failure discovered by the page loop", async () => {
		activationMocks.fetchStatus
			.mockResolvedValueOnce(status("active"))
			.mockResolvedValue(status("activating", { failed: true }));
		activationMocks.advanceProgress
			.mockRejectedValueOnce(new MediaUsageActivationRequestError("advance_failure", 500))
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});
		activationMocks.advance.mockResolvedValue({
			outcome: "activating",
			processedCollections: 1,
			activation: status("activating"),
		});
		const { screen } = await renderPage();
		await expect.element(screen.getByRole("button", { name: "Retry setup" })).toBeVisible();

		await userEvent.click(screen.getByRole("button", { name: "Retry setup" }));
		const dialog = screen.getByRole("dialog", { name: "Retry setup?" });
		const confirm = dialog.getByRole("button", { name: "Retry setup" });
		confirm.element().focus();
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2);
	});

	it("shows no mutation action while ordinary activation is progressing", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("activating"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("activating"),
			progress: null,
			nextRequestInMs: 30_000,
		});

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Setting up" })).toBeVisible();
		expect(screen.getByRole("button", { name: /setup/i }).query()).toBeNull();
	});

	it("keeps active setup visible when progress cannot be loaded", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockRejectedValue(
			new MediaUsageActivationRequestError("advance_failure", 500),
		);
		activationMocks.fetchProgress.mockRejectedValue(
			new MediaUsageActivationRequestError("read_failure", 500),
		);

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Needs attention" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /setup/i }).query()).toBeNull();
	});

	it("reconciles durable progress before offering a transient retry", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.fetchProgress.mockResolvedValue({
			status: "indexing",
			readyCollections: 1,
			totalCollections: 2,
			indexingStarted: true,
		});
		activationMocks.advanceProgress
			.mockRejectedValueOnce(new MediaUsageActivationRequestError("advance_failure", 500))
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
		expect(activationMocks.fetchProgress).toHaveBeenCalledTimes(2);
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2);
		expect(activationMocks.advance).not.toHaveBeenCalled();
	});

	it("accepts durable Ready after the final progress response is lost", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.fetchProgress.mockResolvedValue({
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
			indexingStarted: true,
		});
		activationMocks.advanceProgress.mockRejectedValue(
			new MediaUsageActivationRequestError("advance_failure", 500),
		);

		const { screen } = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
		expect(activationMocks.fetchProgress).toHaveBeenCalledOnce();
	});

	it("follows another owner after a busy response without another mutation", async () => {
		activationMocks.advance.mockRejectedValue(new MediaUsageActivationRequestError("busy", 409));
		activationMocks.fetchStatus
			.mockResolvedValueOnce(status("expanded"))
			.mockResolvedValue(status("activating"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("activating"),
			progress: null,
			nextRequestInMs: 30_000,
		});
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await submitConfirmation(screen);

		await expect.element(screen.getByRole("heading", { name: "Setting up" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Retry setup" }).query()).toBeNull();
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
		expect(activationMocks.advance).toHaveBeenCalledOnce();
	});

	it("moves focus to the recovered state after a slow busy status read", async () => {
		activationMocks.advance.mockRejectedValue(new MediaUsageActivationRequestError("busy", 409));
		let finishStatus!: (value: ReturnType<typeof status>) => void;
		activationMocks.fetchStatus
			.mockResolvedValueOnce(status("expanded"))
			.mockImplementation(() => new Promise((resolve) => (finishStatus = resolve)));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("activating"),
			progress: null,
			nextRequestInMs: 30_000,
		});
		const { screen } = await renderPage();
		await openConfirmation(screen);
		await submitConfirmation(screen);
		await expect.element(screen.getByRole("button", { name: "Refresh status" })).toBeVisible();

		finishStatus(status("activating"));
		const heading = screen.getByRole("heading", { name: "Setting up" });
		await expect.element(heading).toBeVisible();
		expect(document.activeElement).toBe(heading.element());
	});

	it("follows an immediate continuation without the old polling delay", async () => {
		vi.useFakeTimers();
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "indexing",
					readyCollections: 1,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: 0,
			})
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});
		const { screen } = await renderPage();

		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2));
		await expect.element(screen.getByRole("heading", { name: "Ready" })).toBeVisible();
	});

	it("waits for the server-provided delayed continuation", async () => {
		vi.useFakeTimers();
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "indexing",
					readyCollections: 1,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: 30_000,
			})
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});
		await renderPage();
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		await vi.advanceTimersByTimeAsync(20_000);
		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2);
	});

	it("cancels a delayed successor while hidden and resumes after a status read", async () => {
		vi.useFakeTimers();
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "indexing",
					readyCollections: 1,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: 30_000,
			})
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
					indexingStarted: true,
				},
				nextRequestInMs: null,
			});
		await renderPage();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();

		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(activationMocks.fetchStatus).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2));
	});

	it("does not resume from stale activation data when the return status read fails", async () => {
		vi.useFakeTimers();
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		activationMocks.fetchStatus
			.mockResolvedValueOnce(status("active"))
			.mockRejectedValue(new MediaUsageActivationRequestError("read_failure", 500));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: { status: "indexing", readyCollections: 1, totalCollections: 2 },
			nextRequestInMs: null,
		});
		const { screen } = await renderPage();
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		await expect.element(screen.getByRole("heading", { name: "Needs attention" })).toBeVisible();
		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();
	});

	it("does not overlap progress requests when visibility returns", async () => {
		vi.useFakeTimers();
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		let finishProgress!: (value: {
			activation: ReturnType<typeof status>;
			progress: { status: "indexing"; readyCollections: number; totalCollections: number };
			nextRequestInMs: 0;
		}) => void;
		activationMocks.advanceProgress
			.mockImplementationOnce(() => new Promise((resolve) => (finishProgress = resolve)))
			.mockResolvedValueOnce({
				activation: status("active"),
				progress: { status: "ready", readyCollections: 2, totalCollections: 2 },
				nextRequestInMs: null,
			});
		await renderPage();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();
		finishProgress({
			activation: status("active"),
			progress: { status: "indexing", readyCollections: 1, totalCollections: 2 },
			nextRequestInMs: 0,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledTimes(2));
	});

	it("cancels a delayed successor when the page unmounts", async () => {
		vi.useFakeTimers();
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		activationMocks.advanceProgress.mockResolvedValue({
			activation: status("active"),
			progress: { status: "indexing", readyCollections: 1, totalCollections: 2 },
			nextRequestInMs: 30_000,
		});
		const { screen } = await renderPage();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		await screen.unmount();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(activationMocks.advanceProgress).toHaveBeenCalledOnce();
	});

	it("keeps shared progress truthful when an in-flight step finishes after unmount", async () => {
		activationMocks.fetchStatus.mockResolvedValue(status("active"));
		let finishProgress!: (value: {
			activation: ReturnType<typeof status>;
			progress: { status: "ready"; readyCollections: number; totalCollections: number };
			nextRequestInMs: null;
		}) => void;
		activationMocks.advanceProgress.mockImplementation(
			() => new Promise((resolve) => (finishProgress = resolve)),
		);
		const { queryClient, screen } = await renderPage();
		await vi.waitFor(() => expect(activationMocks.advanceProgress).toHaveBeenCalledOnce());

		await screen.unmount();
		finishProgress({
			activation: status("active"),
			progress: { status: "ready", readyCollections: 2, totalCollections: 2 },
			nextRequestInMs: null,
		});

		await vi.waitFor(() =>
			expect(queryClient.getQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY)).toEqual(
				expect.objectContaining({ status: "ready" }),
			),
		);
	});
});
