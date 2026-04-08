/**
 * Comment detail slide-over panel.
 *
 * Shows full comment body, author details, moderation metadata,
 * and status change buttons.
 */

import { Badge, Button } from "@cloudflare/kumo";
import { X, Check, Trash, Warning, UserCircle, EnvelopeSimple } from "@phosphor-icons/react";
import * as React from "react";

import type { AdminComment, CommentStatus } from "../../lib/api/comments.js";
import { cn } from "../../lib/utils.js";

export interface CommentDetailProps {
	comment: AdminComment;
	onClose: () => void;
	onStatusChange: (id: string, status: CommentStatus) => void;
	onDelete: (id: string) => void;
	isAdmin: boolean;
	isStatusPending: boolean;
}

export function CommentDetail({
	comment,
	onClose,
	onStatusChange,
	onDelete,
	isAdmin,
	isStatusPending,
}: CommentDetailProps) {
	// Close on Escape
	React.useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented) {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [onClose]);

	const date = new Date(comment.createdAt);

	return (
		<>
			{/* Backdrop */}
			<div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden="true" />

			{/* Panel */}
			<div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto bg-kumo-base border-l shadow-lg">
				{/* Header */}
				<div className="flex items-center justify-between border-b px-6 py-4">
					<h2 className="text-lg font-semibold">Comment Detail</h2>
					<Button variant="ghost" shape="square" onClick={onClose} aria-label="Close">
						<X className="h-5 w-5" />
					</Button>
				</div>

				{/* Content */}
				<div className="space-y-6 p-6">
					{/* Status */}
					<div className="flex items-center justify-between">
						<CommentStatusBadge status={comment.status} />
						<span className="text-sm text-kumo-subtle">
							{date.toLocaleDateString()} {date.toLocaleTimeString()}
						</span>
					</div>

					{/* Author info */}
					<div className="rounded-lg border p-4 space-y-3">
						<h3 className="text-sm font-semibold text-kumo-subtle uppercase tracking-wider">
							Author
						</h3>
						<div className="space-y-2">
							<div className="flex items-center gap-2">
								<UserCircle className="h-4 w-4 text-kumo-subtle" />
								<span className="font-medium">{comment.authorName}</span>
								{comment.authorUserId && <Badge variant="secondary">Registered user</Badge>}
							</div>
							<div className="flex items-center gap-2">
								<EnvelopeSimple className="h-4 w-4 text-kumo-subtle" />
								<span className="text-sm text-kumo-subtle">{comment.authorEmail}</span>
							</div>
						</div>
					</div>

					{/* Comment body */}
					<div className="rounded-lg border p-4 space-y-3">
						<h3 className="text-sm font-semibold text-kumo-subtle uppercase tracking-wider">
							Comment
						</h3>
						<p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>
					</div>

					{/* Content reference */}
					<div className="rounded-lg border p-4 space-y-2">
						<h3 className="text-sm font-semibold text-kumo-subtle uppercase tracking-wider">
							Content
						</h3>
						<p className="text-sm">
							<span className="text-kumo-subtle">Collection:</span>{" "}
							<span className="font-medium">{comment.collection}</span>
						</p>
						<p className="text-sm">
							<span className="text-kumo-subtle">Content ID:</span>{" "}
							<code className="bg-kumo-tint px-1.5 py-0.5 rounded text-xs">
								{comment.contentId}
							</code>
						</p>
						{comment.parentId && (
							<p className="text-sm">
								<span className="text-kumo-subtle">Reply to:</span>{" "}
								<code className="bg-kumo-tint px-1.5 py-0.5 rounded text-xs">
									{comment.parentId}
								</code>
							</p>
						)}
					</div>

					{/* Moderation metadata */}
					{comment.moderationMetadata && Object.keys(comment.moderationMetadata).length > 0 && (
						<div className="rounded-lg border p-4 space-y-3">
							<h3 className="text-sm font-semibold text-kumo-subtle uppercase tracking-wider">
								Moderation Signals
							</h3>
							<pre className="text-xs bg-kumo-tint rounded p-3 overflow-x-auto">
								{JSON.stringify(comment.moderationMetadata, null, 2)}
							</pre>
						</div>
					)}
				</div>

				{/* Footer actions */}
				<div className="border-t px-6 py-4 space-y-3">
					<div className="flex gap-2">
						{comment.status !== "approved" && (
							<Button
								icon={<Check />}
								onClick={() => onStatusChange(comment.id, "approved")}
								disabled={isStatusPending}
								className="flex-1"
							>
								Approve
							</Button>
						)}
						{comment.status !== "spam" && (
							<Button
								variant="outline"
								icon={<Warning />}
								onClick={() => onStatusChange(comment.id, "spam")}
								disabled={isStatusPending}
								className="flex-1"
							>
								Spam
							</Button>
						)}
						{comment.status !== "trash" && (
							<Button
								variant="outline"
								icon={<Trash />}
								onClick={() => onStatusChange(comment.id, "trash")}
								disabled={isStatusPending}
								className="flex-1"
							>
								Trash
							</Button>
						)}
					</div>
					{isAdmin && (
						<Button
							variant="destructive"
							icon={<Trash />}
							onClick={() => onDelete(comment.id)}
							disabled={isStatusPending}
							className="w-full"
						>
							Delete Permanently
						</Button>
					)}
				</div>
			</div>
		</>
	);
}

export function CommentStatusBadge({ status }: { status: CommentStatus }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
				status === "approved" &&
					"bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
				status === "pending" &&
					"bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
				status === "spam" && "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
				status === "trash" && "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
			)}
		>
			{status}
		</span>
	);
}
