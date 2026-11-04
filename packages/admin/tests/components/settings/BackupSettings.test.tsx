import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type {
	BackupArchive,
	BackupOverview,
	BackupSettings,
} from "../../../src/lib/api/backups.js";
import { render } from "../../utils/render.js";

const mockFetchBackupOverview = vi.fn<() => Promise<BackupOverview>>();
const mockUpdateBackupSettings = vi.fn<(settings: BackupSettings) => Promise<BackupSettings>>();
const mockCreateBackupArchive = vi.fn<() => Promise<BackupArchive>>();
const mockDeleteBackupArchive = vi.fn<(name: string) => Promise<void>>();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../../src/lib/api/backups.js", async () => {
	const actual = await vi.importActual("../../../src/lib/api/backups.js");
	return {
		...actual,
		fetchBackupOverview: () => mockFetchBackupOverview(),
		updateBackupSettings: (settings: BackupSettings) => mockUpdateBackupSettings(settings),
		createBackupArchive: () => mockCreateBackupArchive(),
		deleteBackupArchive: (name: string) => mockDeleteBackupArchive(name),
	};
});

const { BackupSettings } = await import("../../../src/components/settings/BackupSettings.js");

const archive: BackupArchive = {
	name: "backup-2026-08-04.zip",
	size: 2048,
	lastModified: "2026-08-04T10:30:00.000Z",
};

const defaultOverview: BackupOverview = {
	settings: { enabled: true, retention: 7 },
	archives: [],
	storageAvailable: true,
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderBackupSettings() {
	return render(<BackupSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchBackupOverview.mockResolvedValue(defaultOverview);
	mockUpdateBackupSettings.mockImplementation(async (settings) => settings);
	mockCreateBackupArchive.mockResolvedValue(archive);
	mockDeleteBackupArchive.mockResolvedValue(undefined);
});

describe("BackupSettings", () => {
	it("shows the shared frame while backup settings load", async () => {
		mockFetchBackupOverview.mockReturnValue(new Promise(() => undefined));
		const screen = await renderBackupSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Backups", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("shows an inline load failure without backup actions", async () => {
		mockFetchBackupOverview.mockRejectedValue(new Error("Backup service unavailable"));
		const screen = await renderBackupSettings();

		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Failed to load backup settings");
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Backup service unavailable");
		expect(screen.getByRole("button", { name: "Back up now" }).query()).toBeNull();
	});

	it("keeps the save action disabled until the automatic backup config changes", async () => {
		const screen = await renderBackupSettings();

		await expect.element(screen.getByLabelText("Backups to keep")).toHaveValue(7);
		const savedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(savedButtons).toHaveLength(1);
		for (const button of savedButtons) await expect.element(button).toBeDisabled();

		await screen.getByLabelText("Backups to keep").fill("45");
		const saveButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(saveButtons).toHaveLength(1);
		for (const button of saveButtons) await expect.element(button).toBeEnabled();

		await userEvent.click(saveButtons[0]);
		await vi.waitFor(() => {
			expect(mockUpdateBackupSettings).toHaveBeenCalledWith({ enabled: true, retention: 30 });
		});
		await expect.element(screen.getByText("Backup settings saved")).toBeInTheDocument();

		const resavedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(resavedButtons).toHaveLength(1);
		for (const button of resavedButtons) await expect.element(button).toBeDisabled();
	});

	it("explains unavailable storage and hides storage actions", async () => {
		mockFetchBackupOverview.mockResolvedValue({
			...defaultOverview,
			storageAvailable: false,
		});
		const screen = await renderBackupSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Automatic Backups", level: 2 }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Automatic backups need a storage backend");
		expect(screen.getByRole("button", { name: "Back up now" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("creates an immediate backup without saving config changes", async () => {
		const screen = await renderBackupSettings();
		await screen.getByLabelText("Backups to keep").fill("12");

		await userEvent.click(screen.getByRole("button", { name: "Back up now" }));
		await vi.waitFor(() => expect(mockCreateBackupArchive).toHaveBeenCalledOnce());
		expect(mockUpdateBackupSettings).not.toHaveBeenCalled();
		await expect
			.element(screen.getByText("Backup created: backup-2026-08-04.zip"))
			.toBeInTheDocument();
	});

	it("shows the stored-backup empty state and renders archive actions", async () => {
		const emptyScreen = await renderBackupSettings();
		await expect.element(emptyScreen.getByText("No items yet")).toBeInTheDocument();

		mockFetchBackupOverview.mockResolvedValue({ ...defaultOverview, archives: [archive] });
		const listScreen = await renderBackupSettings();
		await expect.element(listScreen.getByText(archive.name)).toBeInTheDocument();
		await expect
			.element(listScreen.getByRole("link", { name: `Download ${archive.name}` }))
			.toHaveAttribute(
				"href",
				`/_emdash/api/settings/backups/archives/${encodeURIComponent(archive.name)}`,
			);
		await expect
			.element(listScreen.getByRole("button", { name: `Delete ${archive.name}` }))
			.toBeInTheDocument();
	});

	it("requires confirmation and keeps delete errors in the dialog", async () => {
		mockFetchBackupOverview.mockResolvedValue({ ...defaultOverview, archives: [archive] });
		mockDeleteBackupArchive.mockRejectedValue(new Error("Archive could not be deleted"));
		const screen = await renderBackupSettings();

		await userEvent.click(screen.getByRole("button", { name: `Delete ${archive.name}` }));
		await expect
			.element(screen.getByRole("heading", { name: "Delete backup?" }))
			.toBeInTheDocument();
		expect(mockDeleteBackupArchive).not.toHaveBeenCalled();

		screen.getByRole("button", { name: "Delete", exact: true }).element().click();
		await vi.waitFor(() => {
			expect(mockDeleteBackupArchive).toHaveBeenCalledWith(archive.name);
		});
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Archive could not be deleted");
		await expect
			.element(screen.getByRole("heading", { name: "Delete backup?" }))
			.toBeInTheDocument();
	});
});
