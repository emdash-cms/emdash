/**
 * Menu List component
 *
 * Displays all menus with ability to create, edit, and delete.
 */

import { Button, Input, LayerCard, LayerDialog, Toast } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { fetchMenus, createMenu, deleteMenu, type CreateMenuInput } from "../lib/api";
import { ApiResponseError, fetchManifest } from "../lib/api/client.js";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../lib/dialog-form.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { HelpLabel } from "./FieldHelpLabel.js";
import { LocaleSwitcher, useI18nConfig } from "./LocaleSwitcher.js";
import { MenuCard } from "./MenuCard.js";

const MENU_NAME_PATTERN = /^[a-z0-9-]+$/;

type CreateMenuField = "label" | "name";

function createMenuProblems(
	label: string,
	name: string,
): Partial<Record<CreateMenuField, MessageDescriptor>> {
	const problems: Partial<Record<CreateMenuField, MessageDescriptor>> = {};
	if (!label.trim()) problems.label = msg`Enter a label.`;
	const trimmedName = name.trim();
	if (!trimmedName) problems.name = msg`Enter a name.`;
	else if (!MENU_NAME_PATTERN.test(trimmedName)) {
		problems.name = msg`Use lowercase letters, numbers, and hyphens.`;
	}
	return problems;
}

function isConflict(error: unknown): boolean {
	return error instanceof ApiResponseError && error.code === "CONFLICT";
}

export function MenuList() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = Toast.useToastManager();
	const [isCreateOpen, setIsCreateOpen] = React.useState(false);
	const [deleteMenuName, setDeleteMenuName] = React.useState<string | null>(null);
	const createFormId = React.useId();
	const createFormRef = React.useRef<HTMLFormElement>(null);
	const [createLabel, setCreateLabel] = React.useState("");
	const [createName, setCreateName] = React.useState("");
	const [createSubmitted, setCreateSubmitted] = React.useState(false);
	const [takenName, setTakenName] = React.useState<string | null>(null);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const i18n = useI18nConfig(manifest);
	const [activeLocale, setActiveLocale] = React.useState<string | undefined>(undefined);
	React.useEffect(() => {
		if (i18n && !activeLocale) setActiveLocale(i18n.defaultLocale);
	}, [i18n, activeLocale]);

	const { data: menus, isLoading } = useQuery({
		queryKey: ["menus", activeLocale],
		queryFn: () => fetchMenus({ locale: activeLocale }),
	});

	const createMutation = useMutation({
		mutationFn: createMenu,
		onSuccess: (menu) => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			setIsCreateOpen(false);
			toastManager.add({
				title: t`Menu created`,
				description: t`Menu "${menu.label}" has been created.`,
			});
			void navigate({
				to: "/menus/$name",
				params: { name: menu.name },
				search: { locale: menu.locale },
			});
		},
		onError: (error, input) => {
			if (!isConflict(error)) return;
			revealErrors(createFormRef.current, () => {
				setCreateSubmitted(true);
				setTakenName(input.name);
			});
		},
	});
	const submitCreate = useSingleFlight((input: CreateMenuInput) =>
		createMutation.mutateAsync(input),
	);

	const deleteMutation = useMutation({
		mutationFn: (name: string) => deleteMenu(name, { locale: activeLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			setDeleteMenuName(null);
			toastManager.add({
				title: t`Menu deleted`,
				description: t`The menu has been deleted.`,
			});
		},
	});

	const handleCreateOpenChange = (open: boolean) => {
		setIsCreateOpen(open);
		if (!open) return;
		setCreateLabel("");
		setCreateName("");
		setCreateSubmitted(false);
		setTakenName(null);
		createMutation.reset();
	};

	const createProblems = createMenuProblems(createLabel, createName);
	if (takenName !== null && createName.trim() === takenName) {
		createProblems.name = msg`Another menu already uses this name. Enter a different one.`;
	}
	const createErrors = createSubmitted ? createProblems : {};

	const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (createMutation.isPending) return;
		if (Object.keys(createProblems).length > 0) {
			revealErrors(e.currentTarget, () => setCreateSubmitted(true));
			return;
		}
		submitCreate({ name: createName.trim(), label: createLabel.trim(), locale: activeLocale });
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-kumo-subtle">{t`Loading menus...`}</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<header className="flex flex-col gap-4 border-b border-kumo-line pb-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold leading-tight">{t`Menus`}</h1>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Manage navigation menus for your site`}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{i18n && activeLocale ? (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={setActiveLocale}
						/>
					) : null}
					<LayerDialog.Root
						open={isCreateOpen}
						{...guardUnsavedInput(createLabel !== "" || createName !== "", handleCreateOpenChange)}
						dismissDisabled={createMutation.isPending}
					>
						<LayerDialog.Trigger
							render={(props) => (
								<Button {...props} icon={<Plus aria-hidden="true" />}>
									{t`Create Menu`}
								</Button>
							)}
						/>
						<LayerDialog.Content>
							<LayerDialog.Title>{t`Create menu`}</LayerDialog.Title>
							<LayerDialog.Description>
								{t`Give this navigation a label and a site identifier.`}
							</LayerDialog.Description>
							<LayerDialog.Body>
								<form
									ref={createFormRef}
									id={createFormId}
									noValidate
									onSubmit={handleCreate}
									className="grid gap-5"
								>
									<Input
										label={
											<HelpLabel
												help={t`Shown in the admin. Some themes also show it on the site.`}
											>
												{t`Label`}
											</HelpLabel>
										}
										aria-label={t`Label`}
										name="label"
										required
										placeholder={t`Primary navigation`}
										value={createLabel}
										onChange={(e) => setCreateLabel(e.target.value)}
										error={createErrors.label && t(createErrors.label)}
										aria-invalid={createErrors.label ? true : undefined}
									/>
									<Input
										label={
											<HelpLabel
												help={t`Stable identifier for your site, such as primary or footer.`}
											>
												{t`Name`}
											</HelpLabel>
										}
										aria-label={t`Name`}
										name="name"
										dir="ltr"
										required
										placeholder={t`primary`}
										value={createName}
										onChange={(e) => setCreateName(e.target.value)}
										error={createErrors.name && t(createErrors.name)}
										aria-invalid={createErrors.name ? true : undefined}
									/>
									<DialogError
										message={
											isConflict(createMutation.error)
												? null
												: getMutationError(createMutation.error)
										}
									/>
								</form>
							</LayerDialog.Body>
							<LayerDialog.Actions dismissLabel={t`Cancel`}>
								<LayerDialog.Action
									type="submit"
									form={createFormId}
									disabled={createMutation.isPending}
								>
									{createMutation.isPending ? t`Creating...` : t`Create`}
								</LayerDialog.Action>
							</LayerDialog.Actions>
						</LayerDialog.Content>
					</LayerDialog.Root>
				</div>
			</header>

			{!menus || menus.length === 0 ? (
				<LayerCard className="flex flex-col items-center px-6 py-16 text-center">
					<span className="mb-5 flex size-14 items-center justify-center rounded-xl bg-kumo-tint text-kumo-brand">
						<ADMIN_NAV_ICONS.menus size={28} aria-hidden="true" />
					</span>
					<h2 className="text-lg font-semibold leading-6">{t`No menus yet`}</h2>
					<p className="mt-2 max-w-sm text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Create your first navigation menu to get started`}
					</p>
					<Button
						className="mt-5"
						icon={<Plus aria-hidden="true" />}
						onClick={() => handleCreateOpenChange(true)}
					>
						{t`Create Menu`}
					</Button>
				</LayerCard>
			) : (
				<ul className="grid gap-4 lg:grid-cols-2">
					{menus.map((menu) => (
						<li key={menu.id}>
							<MenuCard
								menu={menu}
								showLocale={!!i18n}
								onDelete={() => setDeleteMenuName(menu.name)}
							/>
						</li>
					))}
				</ul>
			)}

			<ConfirmDialog
				open={deleteMenuName !== null}
				onClose={() => {
					setDeleteMenuName(null);
					deleteMutation.reset();
				}}
				title={t`Delete menu`}
				description={t`Are you sure you want to delete this menu? This will also delete all menu items. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMenuName && deleteMutation.mutate(deleteMenuName)}
			/>
		</div>
	);
}
