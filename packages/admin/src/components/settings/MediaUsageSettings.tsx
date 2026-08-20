import { Badge, Banner, Button, Checkbox, Loader } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useCurrentUser } from "../../lib/api/current-user.js";
import {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MediaUsageActivationRequestError,
	advanceMediaUsageActivation,
	fetchMediaUsageActivationStatus,
	fetchMediaUsageProgress,
	type MediaUsageActivationStatus,
	type MediaUsageProgress,
} from "../../lib/api/media-usage-activation.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const ROLE_ADMIN = 50;
const EMPTY_CONFIRMATIONS = { maintenance: false, writers: false, irreversible: false };

type Confirmation = keyof typeof EMPTY_CONFIRMATIONS;
type Notice = "busy" | "refreshed" | "unconfirmed" | "version" | "validation" | "denied" | null;

export function MediaUsageSettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const { data: currentUser, isLoading: userLoading } = useCurrentUser();
	const isAdmin = !!currentUser && currentUser.role >= ROLE_ADMIN;
	const [confirmations, setConfirmations] = React.useState(EMPTY_CONFIRMATIONS);
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [notice, setNotice] = React.useState<Notice>(null);
	const awayGenerationRef = React.useRef(0);
	const returnGenerationRef = React.useRef(0);
	const refreshSequenceRef = React.useRef(0);
	const submittingRef = React.useRef(false);
	const focusActiveRef = React.useRef(false);
	const activeHeadingRef = React.useRef<HTMLHeadingElement>(null);

	const activationQuery = useQuery({
		queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY,
		queryFn: fetchMediaUsageActivationStatus,
		enabled: isAdmin,
		retry: false,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const progressQuery = useQuery({
		queryKey: ["media-usage-progress"],
		queryFn: fetchMediaUsageProgress,
		enabled: isAdmin && activationQuery.data?.state === "active",
		retry: false,
		refetchInterval: 60_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

	const resetConfirmations = React.useCallback(() => {
		setConfirmations(EMPTY_CONFIRMATIONS);
		setDialogOpen(false);
	}, []);
	React.useEffect(() => {
		if (activationQuery.data?.state === "active" || activationQuery.data?.lastErrorCode) {
			resetConfirmations();
		}
	}, [activationQuery.data?.lastErrorCode, activationQuery.data?.state, resetConfirmations]);

	const refreshStatus = React.useCallback(
		async (reason: "manual" | "ownership" | "ambiguous") => {
			if (submittingRef.current) return;
			const awayGeneration = awayGenerationRef.current;
			const refreshSequence = ++refreshSequenceRef.current;
			if (reason === "ownership" || reason === "ambiguous") setNotice("unconfirmed");
			if (reason !== "manual") resetConfirmations();
			const result = await activationQuery.refetch();
			if (
				awayGeneration !== awayGenerationRef.current ||
				refreshSequence !== refreshSequenceRef.current
			) {
				return;
			}
			if (!result.isSuccess) {
				if (reason === "ownership" || reason === "ambiguous") setNotice("unconfirmed");
				return;
			}
			setNotice((current) =>
				current === "validation" || current === "version"
					? current
					: reason === "manual"
						? null
						: "refreshed",
			);
			if (result.data.state !== "active") focusActiveRef.current = false;
		},
		[activationQuery, resetConfirmations],
	);

	React.useEffect(() => {
		if (!isAdmin) return;
		const markAway = () => {
			awayGenerationRef.current++;
			resetConfirmations();
		};
		const returnToPage = () => {
			const generation = awayGenerationRef.current;
			if (returnGenerationRef.current === generation) return;
			returnGenerationRef.current = generation;
			void refreshStatus("manual");
		};
		const visibilityChanged = () => {
			if (document.visibilityState === "hidden") markAway();
			else returnToPage();
		};
		window.addEventListener("pagehide", markAway);
		window.addEventListener("pageshow", returnToPage);
		document.addEventListener("visibilitychange", visibilityChanged);
		return () => {
			window.removeEventListener("pagehide", markAway);
			window.removeEventListener("pageshow", returnToPage);
			document.removeEventListener("visibilitychange", visibilityChanged);
		};
	}, [isAdmin, refreshStatus, resetConfirmations]);

	const advanceMutation = useMutation({
		mutationFn: async () => {
			await queryClient.cancelQueries({ queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY });
			return advanceMediaUsageActivation({ writersDrained: true, maintenanceReady: true });
		},
		retry: false,
		onSuccess: (result) => {
			queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, result.activation);
			setNotice(null);
			setDialogOpen(false);
			if (result.activation.state !== "active") focusActiveRef.current = false;
			if (result.activation.state === "active" || result.activation.lastErrorCode) {
				resetConfirmations();
			}
		},
		onError: (caught) => {
			submittingRef.current = false;
			void handleAdvanceError(caught);
		},
		onSettled: () => {
			submittingRef.current = false;
		},
	});

	const handleAdvanceError = async (caught: unknown) => {
		const error =
			caught instanceof MediaUsageActivationRequestError
				? caught
				: new MediaUsageActivationRequestError("unknown", null);
		if (error.kind === "busy") {
			setDialogOpen(false);
			setNotice("busy");
			return;
		}
		resetConfirmations();
		if (error.kind === "denied") return setNotice("denied");
		if (error.kind === "version_mismatch") return setNotice("version");
		if (error.kind === "validation") return setNotice("validation");
		await refreshStatus(error.kind === "ownership_conflict" ? "ownership" : "ambiguous");
	};

	const activation = activationQuery.data;
	const active = activation?.state === "active";
	React.useEffect(() => {
		if (!active || !focusActiveRef.current) return;
		focusActiveRef.current = false;
		activeHeadingRef.current?.focus();
	}, [active]);

	const title = t`Media Usage`;
	const description = t`Track where media is used across your content.`;
	const queryDenied = isActivationError(activationQuery.error, "denied");
	const queryVersion = isActivationError(activationQuery.error, "version_mismatch");
	if (userLoading) return <LoadingPage title={title} description={description} />;
	if (!isAdmin || queryDenied || notice === "denied") {
		return (
			<MessagePage
				title={t`Access denied`}
				description={t`You need Admin permissions to manage Media Usage.`}
				message={t`Ask an administrator to complete this setup.`}
			/>
		);
	}
	if (queryVersion || notice === "version") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Keep editing paused and deploy a compatible EmDash version before continuing.`}
			/>
		);
	}
	if (notice === "validation") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Reload after updating EmDash before trying again.`}
			/>
		);
	}
	if (notice === "unconfirmed") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Activation cannot be confirmed. Keep editing paused and refresh the status.`}
				action={
					<Button size="sm" variant="secondary" onClick={() => void refreshStatus("manual")}>
						{t`Refresh status`}
					</Button>
				}
			/>
		);
	}
	if (activationQuery.isError || activationQuery.isRefetchError) {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Couldn’t load Media Usage settings.`}
				action={
					<Button size="sm" variant="secondary" onClick={() => void refreshStatus("manual")}>
						{t`Try again`}
					</Button>
				}
			/>
		);
	}
	if (activationQuery.isPending || activationQuery.isFetching || !activation) {
		return <LoadingPage title={title} description={description} />;
	}

	const allConfirmed = Object.values(confirmations).every(Boolean);
	const storedFailure = activation.lastErrorCode !== null;
	const blocked = notice === "busy" || advanceMutation.isPending;
	const actionLabel = storedFailure
		? t`Retry setup`
		: activation.state === "expanded"
			? t`Enable Media Usage`
			: t`Continue setup`;
	const liveMessage = active
		? progressQuery.isError
			? t`Indexing progress is unavailable.`
			: progressQuery.isPending
				? t`Checking indexing progress.`
				: progressQuery.data?.status === "ready"
					? t`Media Usage is ready.`
					: progressQuery.data?.status === "needs_attention"
						? t`Media Usage needs attention.`
						: t`Existing content is indexing.`
		: activation.state === "activating"
			? t`Setup is in progress.`
			: t`Media Usage is off.`;
	const progressAlert = progressQuery.isError || progressQuery.data?.status === "needs_attention";
	const submit = () => {
		if (submittingRef.current) return;
		submittingRef.current = true;
		focusActiveRef.current = true;
		advanceMutation.mutate();
	};
	const startOrContinue = () => {
		if (allConfirmed && activation.state === "activating" && !storedFailure) {
			submit();
		} else {
			setDialogOpen(true);
		}
	};

	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection
				title={t`Automatic indexing`}
				actions={
					active && progressQuery.isError ? (
						<Button size="sm" variant="secondary" onClick={() => void progressQuery.refetch()}>
							{t`Try again`}
						</Button>
					) : undefined
				}
			>
				<StatusRow
					activation={activation}
					progress={progressQuery.isError ? undefined : progressQuery.data}
					progressError={progressQuery.isError}
					activeHeadingRef={activeHeadingRef}
				/>
				{!active && (storedFailure || notice) ? (
					<SettingRow>
						<SetupNotice notice={notice} storedFailure={storedFailure} onRefresh={refreshStatus} />
					</SettingRow>
				) : null}
				{!active ? (
					<SettingRow className="flex justify-end">
						<Button
							className="w-full sm:w-auto"
							disabled={blocked}
							icon={advanceMutation.isPending ? <Loader size="sm" /> : undefined}
							onClick={startOrContinue}
						>
							{advanceMutation.isPending ? t`Setting up…` : actionLabel}
						</Button>
					</SettingRow>
				) : null}
			</SettingsSection>

			<ConfirmationDialog
				open={dialogOpen}
				activation={activation}
				confirmations={confirmations}
				pending={advanceMutation.isPending}
				onOpenChange={(open) => {
					setDialogOpen(open);
					if (!open) setConfirmations(EMPTY_CONFIRMATIONS);
				}}
				onChange={(key, checked) => setConfirmations((current) => ({ ...current, [key]: checked }))}
				onConfirm={submit}
			/>
			<span className="sr-only" role={progressAlert ? "alert" : "status"} aria-atomic="true">
				{liveMessage}
			</span>
		</SettingsFrame>
	);
}

function StatusRow({
	activation,
	progress,
	progressError,
	activeHeadingRef,
}: {
	activation: MediaUsageActivationStatus;
	progress: MediaUsageProgress | undefined;
	progressError: boolean;
	activeHeadingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
	const { t } = useLingui();
	const active = activation.state === "active";
	const settingUp = activation.state === "activating";
	let heading = t`Automatic indexing is off`;
	let detail = t`Enable Media Usage to index existing content and keep references up to date.`;
	let badge = t`Off`;
	let variant: "neutral" | "warning" | "success" | "error" = "neutral";
	if (settingUp) {
		heading = t`Setup is in progress`;
		detail = t`Keep editing paused until setup is complete.`;
		badge = t`Setting up`;
		variant = "warning";
	}
	if (active) {
		if (progressError) {
			heading = t`Indexing progress unavailable`;
			detail = t`New changes are still tracked automatically.`;
			badge = t`Unavailable`;
			variant = "error";
		}
		heading = progressError
			? heading
			: !progress
				? t`Checking indexing progress`
				: progress.status === "ready"
					? t`Media Usage is ready`
					: progress?.status === "needs_attention"
						? t`Media Usage needs attention`
						: t`Indexing existing content`;
		detail = progressError
			? detail
			: progress
				? plural(progress.totalCollections, {
						one: `${progress.readyCollections} of # content type ready`,
						other: `${progress.readyCollections} of # content types ready`,
					})
				: t`Checking indexing progress…`;
		badge = progressError
			? badge
			: !progress
				? t`Checking`
				: progress.status === "ready"
					? t`Ready`
					: progress.status === "needs_attention"
						? t`Needs attention`
						: t`Indexing`;
		variant = progressError
			? variant
			: progress?.status === "ready"
				? "success"
				: progress?.status === "needs_attention"
					? "error"
					: "warning";
	}
	return (
		<SettingRow>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h3
						ref={active ? activeHeadingRef : undefined}
						tabIndex={active ? -1 : undefined}
						className="text-sm font-medium leading-5"
					>
						{heading}
					</h3>
					<p className="mt-0.5 max-w-2xl text-sm leading-5 text-kumo-subtle">{detail}</p>
				</div>
				<Badge variant={variant} className="shrink-0">
					{badge}
				</Badge>
			</div>
		</SettingRow>
	);
}

function ConfirmationDialog({
	open,
	activation,
	confirmations,
	pending,
	onOpenChange,
	onChange,
	onConfirm,
}: {
	open: boolean;
	activation: MediaUsageActivationStatus;
	confirmations: typeof EMPTY_CONFIRMATIONS;
	pending: boolean;
	onOpenChange: (open: boolean) => void;
	onChange: (key: Confirmation, checked: boolean) => void;
	onConfirm: () => void;
}) {
	const { t } = useLingui();
	const rows: Array<{ key: Confirmation; title: string; description: string }> = [
		{
			key: "maintenance",
			title: t`Background tasks are running.`,
			description: t`Use the Media Usage Cron on Cloudflare or keep a Node process running.`,
		},
		{
			key: "writers",
			title: t`Editing and direct database writes are paused.`,
			description: t`Keep them paused until setup is complete.`,
		},
		{
			key: "irreversible",
			title: t`I understand setup can’t be cancelled or reset.`,
			description: t`This is a one-way change.`,
		},
	];
	const confirmed = Object.values(confirmations).every(Boolean);
	return (
		<ConfirmDialog
			open={open}
			onClose={() => onOpenChange(false)}
			title={t`Enable Media Usage`}
			description={t`Existing content will be indexed automatically after setup is complete.`}
			confirmLabel={
				activation.state === "expanded" ? t`Enable and start indexing` : t`Continue setup`
			}
			pendingLabel={t`Enabling…`}
			variant="primary"
			isPending={pending}
			disabled={!confirmed}
			error={null}
			onConfirm={onConfirm}
		>
			<fieldset className="mt-5 grid gap-4" aria-busy={pending || undefined}>
				<legend className="sr-only">{t`Before you continue`}</legend>
				{rows.map((row) => (
					<Checkbox
						key={row.key}
						checked={confirmations[row.key]}
						onCheckedChange={(checked) => onChange(row.key, checked)}
						label={
							<span className="grid gap-0.5">
								<span className="text-sm font-medium leading-5">{row.title}</span>
								<span className="text-sm leading-5 text-kumo-subtle">{row.description}</span>
							</span>
						}
					/>
				))}
			</fieldset>
		</ConfirmDialog>
	);
}

function SetupNotice({
	notice,
	storedFailure,
	onRefresh,
}: {
	notice: Notice;
	storedFailure: boolean;
	onRefresh: (reason: "manual") => Promise<void>;
}) {
	const { t } = useLingui();
	if (notice === "busy") {
		return (
			<Banner
				variant="alert"
				title={t`Another setup request is still running.`}
				description={t`Keep editing paused and refresh before continuing.`}
				action={
					<Button
						size="sm"
						variant="secondary"
						onClick={() => void onRefresh("manual")}
					>{t`Refresh status`}</Button>
				}
			/>
		);
	}
	if (storedFailure) {
		return (
			<Banner
				variant="error"
				role="alert"
				title={t`This setup step didn’t finish.`}
				description={t`Keep editing paused, fix the server issue, then retry setup.`}
			/>
		);
	}
	return (
		<Banner
			variant="alert"
			title={t`Setup status was refreshed.`}
			description={t`The status was refreshed. Check the requirements before continuing.`}
		/>
	);
}

function LoadingPage({ title, description }: { title: string; description: string }) {
	const { t } = useLingui();
	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection title={t`Automatic indexing`}>
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading Media Usage settings…`}
					</div>
				</SettingRow>
			</SettingsSection>
		</SettingsFrame>
	);
}

function MessagePage({
	title,
	description,
	message,
	action,
}: {
	title: string;
	description: string;
	message: string;
	action?: React.ReactNode;
}) {
	const { t } = useLingui();
	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection title={t`Automatic indexing`}>
				<SettingRow>
					<Banner variant="error" role="alert" title={message} action={action} />
				</SettingRow>
			</SettingsSection>
		</SettingsFrame>
	);
}

function isActivationError(error: unknown, kind: MediaUsageActivationRequestError["kind"]) {
	return error instanceof MediaUsageActivationRequestError && error.kind === kind;
}
