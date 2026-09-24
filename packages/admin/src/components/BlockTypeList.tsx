import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { BlockType } from "../lib/api/schema.js";

export interface BlockTypeListProps {
	blockTypes: readonly BlockType[];
	isLoading?: boolean;
}

export function BlockTypeList({ blockTypes, isLoading = false }: BlockTypeListProps) {
	const { t } = useLingui();
	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base">
			<div className="border-b border-kumo-line px-4 py-3">
				<h2 className="font-semibold">{t`Block types`}</h2>
				<p className="text-sm text-kumo-subtle">
					{t`Database-owned definitions available to blocks fields.`}
				</p>
			</div>
			{isLoading ? (
				<p className="p-4 text-sm text-kumo-subtle">{t`Loading block types…`}</p>
			) : blockTypes.length === 0 ? (
				<p className="p-4 text-sm text-kumo-subtle">{t`No block types defined`}</p>
			) : (
				<div className="divide-y divide-kumo-line">
					{blockTypes.map((blockType) => (
						<div key={blockType.slug} className="px-4 py-3">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{blockType.label}</span>
								<code className="text-xs text-kumo-subtle">{blockType.slug}</code>
								<Badge variant="secondary">{t`Active v${blockType.currentVersion}`}</Badge>
							</div>
							{blockType.description && (
								<p className="mt-1 text-sm text-kumo-subtle">{blockType.description}</p>
							)}
							<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-kumo-subtle">
								{blockType.versions.map((version) => (
									<span key={version.version}>
										{version.active
											? t`Version ${version.version} (active)`
											: t`Version ${version.version}`}{" "}
										· <code>{version.fingerprint}</code>
									</span>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
