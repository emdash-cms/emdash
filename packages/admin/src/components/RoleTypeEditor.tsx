import { Button, Checkbox, Input, Label, cn } from "@cloudflare/kumo";
import { ArrowLeft, Plus, Pencil, Trash } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { CreateFieldInput, SchemaField } from "../lib/api";
import type {
	RoleDef,
	RoleFieldDef,
	CreateRoleInput,
	UpdateRoleInput,
} from "../lib/api/roles.js";
import { ALL_PERMISSIONS as PERMISSION_GROUPS } from "../lib/api/roles.js";
import { FieldEditor } from "./FieldEditor";

// Regex patterns for name generation
const NAME_INVALID_CHARS_PATTERN = /[^a-z0-9]+/g;
const NAME_LEADING_TRAILING_PATTERN = /^_|_$/g;

export interface RoleTypeEditorProps {
	role?: RoleDef;
	isNew?: boolean;
	isSaving?: boolean;
	onSave: (input: CreateRoleInput | UpdateRoleInput) => void;
}

// ============================================================================
// Converters between RoleFieldDef and SchemaField / CreateFieldInput
// ============================================================================

function fieldDefToSchemaField(def: RoleFieldDef, index: number): SchemaField {
	return {
		id: `field-${index}`,
		name: def.name,
		label: def.label,
		type: def.type,
		required: def.required ?? false,
		sortOrder: index,
		options: def.options ?? undefined,
		widget: def.widget ?? undefined,
		validation: def.validation ?? undefined,
		defaultValue: def.defaultValue ?? undefined,
	};
}

function schemaFieldToFieldDef(field: SchemaField | CreateFieldInput): RoleFieldDef {
	const def: RoleFieldDef = {
		name: field.name,
		label: field.label,
		type: field.type as RoleFieldDef["type"],
	};
	if (field.required) def.required = true;
	if (field.options && field.options.length > 0) def.options = field.options;
	if (field.widget) def.widget = field.widget;
	if (field.validation) def.validation = field.validation;
	if (field.defaultValue !== undefined) def.defaultValue = field.defaultValue;
	return def;
}

/**
 * Role Type editor — create or edit a custom role definition.
 */
export function RoleTypeEditor({
	role,
	isNew,
	isSaving,
	onSave,
}: RoleTypeEditorProps) {
	const isEdit = !isNew && !!role;
	const isBuiltin = role?.builtin ?? false;

	// Form state
	const [label, setLabel] = React.useState(role?.label ?? "");
	const [name, setName] = React.useState(role?.name ?? "");
	const [level, setLevel] = React.useState(role?.level?.toString() ?? "");
	const [description, setDescription] = React.useState(role?.description ?? "");
	const [color, setColor] = React.useState(role?.color ?? "#6b7280");
	const [permissions, setPermissions] = React.useState<Set<string>>(
		new Set(role?.permissions ?? []),
	);
	const [fields, setFields] = React.useState<SchemaField[]>(
		(role?.fields ?? []).map((f, i) => fieldDefToSchemaField(f as RoleFieldDef, i)),
	);

	// Field editor dialog state
	const [editingField, setEditingField] = React.useState<SchemaField | null>(null);
	const [isFieldDialogOpen, setIsFieldDialogOpen] = React.useState(false);

	// Auto-generate name from label (only in create mode)
	const [nameManuallySet, setNameManuallySet] = React.useState(isEdit);
	React.useEffect(() => {
		if (!nameManuallySet && !isEdit) {
			const auto = label
				.toLowerCase()
				.replace(NAME_INVALID_CHARS_PATTERN, "_")
				.replace(NAME_LEADING_TRAILING_PATTERN, "");
			setName(auto);
		}
	}, [label, nameManuallySet, isEdit]);

	// Permission toggle
	const togglePermission = (perm: string) => {
		setPermissions((prev) => {
			const next = new Set(prev);
			if (next.has(perm)) {
				next.delete(perm);
			} else {
				next.add(perm);
			}
			return next;
		});
	};

	// Toggle all permissions in a group
	const toggleGroup = (groupPerms: readonly { value: string; label: string }[]) => {
		setPermissions((prev) => {
			const next = new Set(prev);
			const allSelected = groupPerms.every((p) => next.has(p.value));
			for (const p of groupPerms) {
				if (allSelected) {
					next.delete(p.value);
				} else {
					next.add(p.value);
				}
			}
			return next;
		});
	};

	// Field management
	const handleAddField = () => {
		setEditingField(null);
		setIsFieldDialogOpen(true);
	};

	const handleEditField = (field: SchemaField) => {
		setEditingField(field);
		setIsFieldDialogOpen(true);
	};

	const handleRemoveField = (fieldName: string) => {
		setFields((prev) => prev.filter((f) => f.name !== fieldName));
	};

	const handleFieldSave = (input: CreateFieldInput) => {
		if (editingField) {
			setFields((prev) =>
				prev.map((f) =>
					f.name === editingField.name
						? fieldDefToSchemaField(schemaFieldToFieldDef({ ...input }), f.sortOrder)
						: f,
				),
			);
		} else {
			setFields((prev) => [
				...prev,
				fieldDefToSchemaField(schemaFieldToFieldDef(input), prev.length),
			]);
		}
		setIsFieldDialogOpen(false);
		setEditingField(null);
	};

	// Submit
	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();

		const fieldDefs = fields.map((f) => schemaFieldToFieldDef(f));

		if (isNew) {
			const input: CreateRoleInput = {
				name,
				label,
				level: parseInt(level, 10),
				permissions: Array.from(permissions),
				fields: fieldDefs.length > 0 ? fieldDefs : undefined,
				color: color || undefined,
				description: description || undefined,
			};
			onSave(input);
		} else {
			const input: UpdateRoleInput = {
				label: label || undefined,
				permissions: !isBuiltin ? Array.from(permissions) : undefined,
				fields: fieldDefs.length > 0 ? fieldDefs : undefined,
				color: color || undefined,
				description: description || undefined,
			};
			onSave(input);
		}
	};

	return (
		<div className="space-y-6">
			{/* Back link + heading */}
			<div className="flex items-center gap-3">
				<Link
					to="/role-types"
					className="inline-flex items-center gap-1 text-kumo-subtle hover:text-kumo-default"
				>
					<ArrowLeft className="h-4 w-4" aria-hidden="true" />
					Back
				</Link>
				<h1 className="text-2xl font-bold">
					{isNew ? "New Role" : `Edit: ${role?.label ?? name}`}
				</h1>
				{isBuiltin && (
					<span className="text-xs bg-kumo-tint px-2 py-0.5 rounded-full text-kumo-subtle">
						Built-in
					</span>
				)}
			</div>

			<form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
				{/* Basic info */}
				<div className="rounded-lg border p-6 space-y-4">
					<h2 className="text-lg font-semibold">Basic Information</h2>

					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Label"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="e.g. Content Reviewer"
							required
							disabled={isBuiltin}
						/>
						<Input
							label="Name (slug)"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setNameManuallySet(true);
							}}
							placeholder="e.g. content_reviewer"
							required
							disabled={isEdit}
						/>
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Level (1-99)"
							type="number"
							min={1}
							max={99}
							value={level}
							onChange={(e) => setLevel(e.target.value)}
							placeholder="e.g. 25"
							required
							disabled={isEdit}
						/>
						<div className="space-y-1.5">
							<Label>Color</Label>
							<div className="flex items-center gap-2">
								<input
									type="color"
									value={color}
									onChange={(e) => setColor(e.target.value)}
									className="h-9 w-9 rounded border cursor-pointer"
								/>
								<Input
									value={color}
									onChange={(e) => setColor(e.target.value)}
									placeholder="#6b7280"
									className="flex-1"
								/>
							</div>
						</div>
					</div>

					<Input
						label="Description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Brief description of this role"
					/>
				</div>

				{/* Permissions */}
				{!isBuiltin && (
					<div className="rounded-lg border p-6 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-lg font-semibold">Permissions</h2>
							<span className="text-sm text-kumo-subtle">
								{permissions.size} selected
							</span>
						</div>

						<div className="space-y-6">
							{PERMISSION_GROUPS.map((group) => {
								const allSelected = group.permissions.every((p) =>
									permissions.has(p.value),
								);
								const someSelected =
									!allSelected &&
									group.permissions.some((p) => permissions.has(p.value));

								return (
									<div key={group.group} className="space-y-2">
										<div className="flex items-center gap-2">
											<Checkbox
												checked={allSelected}
												indeterminate={someSelected}
												onCheckedChange={() =>
													toggleGroup(group.permissions)
												}
											/>
											<Label className="font-medium text-sm">
												{group.group}
											</Label>
										</div>
										<div className="ml-6 grid gap-1.5 sm:grid-cols-2">
											{group.permissions.map((perm) => (
												<div
													key={perm.value}
													className="flex items-center gap-2"
												>
													<Checkbox
														checked={permissions.has(perm.value)}
														onCheckedChange={() =>
															togglePermission(perm.value)
														}
													/>
													<Label className="text-sm font-normal">
														{perm.label}
													</Label>
												</div>
											))}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* Custom fields (metadata) */}
				<div className="rounded-lg border p-6 space-y-4">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-lg font-semibold">User Metadata Fields</h2>
							<p className="text-sm text-kumo-subtle">
								Additional fields stored in the user's data JSON
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							icon={<Plus />}
							onClick={handleAddField}
						>
							Add Field
						</Button>
					</div>

					{fields.length === 0 ? (
						<p className="text-sm text-kumo-subtle py-4 text-center">
							No custom fields defined.
						</p>
					) : (
						<div className="rounded-md border overflow-x-auto">
							<table className="w-full">
								<thead>
									<tr className="border-b bg-kumo-tint/50">
										<th
											scope="col"
											className="px-3 py-2 text-left text-xs font-medium"
										>
											Name
										</th>
										<th
											scope="col"
											className="px-3 py-2 text-left text-xs font-medium"
										>
											Type
										</th>
										<th
											scope="col"
											className="px-3 py-2 text-left text-xs font-medium"
										>
											Required
										</th>
										<th
											scope="col"
											className="px-3 py-2 text-right text-xs font-medium"
										>
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{fields.map((field) => (
										<tr key={field.name} className="border-b">
											<td className="px-3 py-2 text-sm">
												<div>
													<div className="font-medium">{field.label}</div>
													<code className="text-xs text-kumo-subtle">
														{field.name}
													</code>
												</div>
											</td>
											<td className="px-3 py-2 text-sm">{field.type}</td>
											<td className="px-3 py-2 text-sm">
												{field.required ? "Yes" : "No"}
											</td>
											<td className="px-3 py-2 text-right">
												<div className="flex items-center justify-end gap-1">
													<Button
														type="button"
														variant="ghost"
														shape="square"
														size="sm"
														onClick={() => handleEditField(field)}
													>
														<Pencil className="h-3.5 w-3.5" />
													</Button>
													<Button
														type="button"
														variant="ghost"
														shape="square"
														size="sm"
														onClick={() =>
															handleRemoveField(field.name)
														}
													>
														<Trash className="h-3.5 w-3.5 text-kumo-danger" />
													</Button>
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>

				{/* Save */}
				<div className="flex justify-end gap-2">
					<Link to="/role-types">
						<Button type="button" variant="outline">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={isSaving}>
						{isSaving ? "Saving..." : isNew ? "Create Role" : "Save Changes"}
					</Button>
				</div>
			</form>

			{/* Field editor dialog */}
			<FieldEditor
				open={isFieldDialogOpen}
				onOpenChange={(open) => {
					setIsFieldDialogOpen(open);
					if (!open) setEditingField(null);
				}}
				field={editingField ?? undefined}
				onSave={handleFieldSave}
			/>
		</div>
	);
}
