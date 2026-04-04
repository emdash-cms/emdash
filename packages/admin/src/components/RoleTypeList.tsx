import { Badge, Button, buttonVariants } from "@cloudflare/kumo";
import { Plus, Pencil, Trash, Lock } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { RoleDef } from "../lib/api/roles.js";
import { ConfirmDialog } from "./ConfirmDialog";

export interface RoleTypeListProps {
	roles: RoleDef[];
	isLoading?: boolean;
	onDelete?: (name: string) => void;
	deleteError?: unknown;
	isDeleting?: boolean;
}

/**
 * Role Type list view — shows all role definitions (built-in + custom).
 */
export function RoleTypeList({
	roles,
	isLoading,
	onDelete,
	deleteError,
	isDeleting,
}: RoleTypeListProps) {
	const [deleteTarget, setDeleteTarget] = React.useState<RoleDef | null>(null);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Role Types</h1>
					<p className="text-kumo-subtle text-sm">
						Define user roles, permissions, and custom metadata fields
					</p>
				</div>
				<Link to="/role-types/new" className={buttonVariants()}>
					<Plus className="mr-2 h-4 w-4" aria-hidden="true" />
					New Role
				</Link>
			</div>

			{/* Table */}
			<div className="rounded-md border overflow-x-auto">
				<table className="w-full">
					<thead>
						<tr className="border-b bg-kumo-tint/50">
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Name
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Level
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Type
							</th>
							<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
								Permissions
							</th>
							<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
								Actions
							</th>
						</tr>
					</thead>
					<tbody>
						{isLoading ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									Loading roles...
								</td>
							</tr>
						) : roles.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-4 py-8 text-center text-kumo-subtle">
									No role types found.
								</td>
							</tr>
						) : (
							roles.map((role) => (
								<RoleTypeRow
									key={role.id}
									role={role}
									onRequestDelete={setDeleteTarget}
								/>
							))
						)}
					</tbody>
				</table>
			</div>

			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => setDeleteTarget(null)}
				title="Delete Role?"
				description={
					deleteTarget
						? `Are you sure you want to delete "${deleteTarget.label}"? Users with this role will be reassigned to Subscriber.`
						: ""
				}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={isDeleting ?? false}
				error={deleteError ?? null}
				onConfirm={() => {
					if (deleteTarget) {
						onDelete?.(deleteTarget.name);
						setDeleteTarget(null);
					}
				}}
			/>
		</div>
	);
}

interface RoleTypeRowProps {
	role: RoleDef;
	onRequestDelete?: (role: RoleDef) => void;
}

function RoleTypeRow({ role, onRequestDelete }: RoleTypeRowProps) {
	const permCount = role.permissions?.length ?? 0;

	return (
		<tr className="border-b hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<div className="flex items-center gap-2">
					{role.color && (
						<span
							className="inline-block h-3 w-3 rounded-full shrink-0"
							style={{ backgroundColor: role.color }}
						/>
					)}
					<Link
						to="/role-types/$name"
						params={{ name: role.name }}
						className="font-medium hover:text-kumo-brand"
					>
						{role.label}
					</Link>
				</div>
				{role.description && (
					<p className="text-xs text-kumo-subtle mt-0.5">{role.description}</p>
				)}
			</td>
			<td className="px-4 py-3">
				<code className="text-sm bg-kumo-tint px-1.5 py-0.5 rounded">{role.level}</code>
			</td>
			<td className="px-4 py-3">
				{role.builtin ? (
					<Badge variant="secondary">
						<Lock className="h-3 w-3 mr-1" aria-hidden="true" />
						Built-in
					</Badge>
				) : (
					<Badge variant="secondary">Custom</Badge>
				)}
			</td>
			<td className="px-4 py-3">
				{role.builtin ? (
					<span className="text-sm text-kumo-subtle">Inherited</span>
				) : (
					<span className="text-sm">{permCount} permission{permCount !== 1 ? "s" : ""}</span>
				)}
			</td>
			<td className="px-4 py-3 text-right">
				<div className="flex items-center justify-end space-x-1">
					<Link
						to="/role-types/$name"
						params={{ name: role.name }}
						aria-label={`Edit ${role.label}`}
						className={buttonVariants({ variant: "ghost", shape: "square" })}
					>
						<Pencil className="h-4 w-4" aria-hidden="true" />
					</Link>
					{!role.builtin && (
						<Button
							variant="ghost"
							shape="square"
							aria-label={`Delete ${role.label}`}
							onClick={() => onRequestDelete?.(role)}
						>
							<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
						</Button>
					)}
				</div>
			</td>
		</tr>
	);
}
