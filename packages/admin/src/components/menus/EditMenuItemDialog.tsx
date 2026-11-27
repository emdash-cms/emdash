import { Input, LayerDialog, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { updateMenuItem, type MenuItem, type UpdateMenuItemInput } from "../../lib/api";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../../lib/dialog-form.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { HelpLabel } from "../FieldHelpLabel.js";
import { labelProblem, urlProblem } from "./menu-item-form.js";
import { getMenuItemKind, isHeadingUrl, useMenuItemTarget } from "./menu-item-target.js";
import { MenuItemKindIcon, ProblemBadge } from "./MenuItemRow.js";

interface EditValues {
	label: string;
	url: string;
	newTab: boolean;
	cssClasses: string;
}

function toEditValues(item: MenuItem | null): EditValues {
	return {
		label: item?.label ?? "",
		url: isHeadingUrl(item?.customUrl) ? "" : (item?.customUrl ?? ""),
		newTab: item?.target === "_blank",
		cssClasses: item?.cssClasses ?? "",
	};
}

function sameValues(a: EditValues, b: EditValues) {
	return (
		a.label === b.label && a.url === b.url && a.newTab === b.newTab && a.cssClasses === b.cssClasses
	);
}

/** Read-only summary of what a referenced item links to. */
function LinksTo({ item, locale }: { item: MenuItem; locale?: string }) {
	const { t } = useLingui();
	const target = useMenuItemTarget(item, locale);
	const primary = target.title ?? target.destination;
	const secondary = target.title && target.destination !== target.title ? target.destination : "";
	return (
		<div className="grid gap-1.5">
			<span className="text-base font-medium">{t`Links to`}</span>
			<div className="@container/menu-items flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 ring ring-kumo-line">
				<MenuItemKindIcon target={target} />
				<span className="min-w-0 truncate text-base">{primary || " "}</span>
				{secondary &&
					(target.destinationIsUrl ? (
						<bdi dir="ltr" className="min-w-0 flex-1 truncate text-base text-kumo-subtle">
							{secondary}
						</bdi>
					) : (
						<span className="min-w-0 flex-1 truncate text-base text-kumo-subtle">{secondary}</span>
					))}
				{target.problem && (
					<span className="ms-auto shrink-0">
						<ProblemBadge problem={target.problem} />
					</span>
				)}
			</div>
		</div>
	);
}

/** Mount with a new `key` each time it opens, so it starts from the item's saved values. */
export function EditMenuItemDialog({
	item,
	menuName,
	menuLocale,
	onClose,
}: {
	item: MenuItem | null;
	menuName: string;
	menuLocale?: string;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const formId = React.useId();
	const [values, setValues] = React.useState(() => toEditValues(item));
	const [submitted, setSubmitted] = React.useState(false);
	const lastItem = React.useRef(item);
	if (item) lastItem.current = item;

	const mutation = useMutation({
		mutationFn: ({ itemId, input }: { itemId: string; input: UpdateMenuItemInput }) =>
			updateMenuItem(menuName, itemId, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", menuName] });
			onClose();
			toastManager.add({
				title: t`Item updated`,
				description: t`Menu item has been updated.`,
			});
		},
	});
	const submit = useSingleFlight((args: { itemId: string; input: UpdateMenuItemInput }) =>
		mutation.mutateAsync(args),
	);

	const current = lastItem.current;
	const kind = current ? getMenuItemKind(current) : "link";
	const isLink = kind === "link";
	const isHeading = kind === "heading";
	const url = values.url.trim();
	const setsUrl = isLink || (isHeading && !isHeadingUrl(url));
	const problems = {
		label: labelProblem(values.label),
		url: setsUrl ? urlProblem(url) : undefined,
	};
	const errors: Partial<typeof problems> = submitted ? problems : {};
	const dirty = !!current && !sameValues(values, toEditValues(current));
	const setField = <K extends keyof EditValues>(field: K, value: EditValues[K]) =>
		setValues((previous) => ({ ...previous, [field]: value }));

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!current || mutation.isPending) return;
		if (problems.label || problems.url) {
			revealErrors(event.currentTarget, () => setSubmitted(true));
			return;
		}
		const initial = toEditValues(current);
		const cssClasses = values.cssClasses.trim();
		submit({
			itemId: current.id,
			input: {
				label: values.label,
				customUrl: setsUrl ? url : undefined,
				target: values.newTab === initial.newTab ? undefined : values.newTab ? "_blank" : "",
				cssClasses: cssClasses === initial.cssClasses ? undefined : cssClasses,
			},
		});
	};

	return (
		<LayerDialog.Root
			open={item !== null}
			{...guardUnsavedInput(dirty, (open) => {
				if (!open) onClose();
			})}
			dismissDisabled={mutation.isPending}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Edit menu item`}</LayerDialog.Title>
				<LayerDialog.Description>{t`Change how this item shows in the menu.`}</LayerDialog.Description>
				<LayerDialog.Body>
					{current && (
						<form id={formId} noValidate onSubmit={handleSubmit} className="grid gap-5">
							<Input
								label={t`Label`}
								name="label"
								required
								value={values.label}
								onChange={(event) => setField("label", event.target.value)}
								error={errors.label && t(errors.label)}
								aria-invalid={errors.label ? true : undefined}
							/>
							{isLink || isHeading ? (
								<Input
									dir="ltr"
									label={t`URL`}
									description={
										isHeading ? t`Add a URL to turn this heading into a link.` : undefined
									}
									name="url"
									type="text"
									required={isLink}
									value={values.url}
									onChange={(event) => setField("url", event.target.value)}
									error={errors.url && t(errors.url)}
									aria-invalid={errors.url ? true : undefined}
								/>
							) : (
								<LinksTo item={current} locale={menuLocale} />
							)}
							{!isHeading && (
								<Switch
									label={t`Open in new tab`}
									checked={values.newTab}
									onCheckedChange={(checked) => setField("newTab", checked)}
								/>
							)}
							<Input
								label={
									<HelpLabel
										help={t`Separate class names with spaces. Themes can use them to style the link.`}
									>
										{t`CSS classes`}
									</HelpLabel>
								}
								aria-label={t`CSS classes`}
								name="cssClasses"
								dir="ltr"
								value={values.cssClasses}
								onChange={(event) => setField("cssClasses", event.target.value)}
							/>
							<DialogError message={getMutationError(mutation.error)} />
						</form>
					)}
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={mutation.isPending}>
						{mutation.isPending ? t`Saving...` : t`Save`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
