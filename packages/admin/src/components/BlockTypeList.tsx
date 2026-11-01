import { Badge } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { BlockType } from "../lib/api/schema.js";
import { cn } from "../lib/utils.js";
import {
	DataTable,
	DataTableMessage,
	RowMeta,
	cellCodeClassName,
	tertiaryColumn,
} from "./DataTable.js";

export interface BlockTypeListProps {
	blockTypes: readonly BlockType[];
	isLoading?: boolean;
}

export function BlockTypeList({ blockTypes, isLoading = false }: BlockTypeListProps) {
	const { t } = useLingui();
	const headingId = React.useId();
	return (
		<section className="space-y-4">
			<div>
				<h2 id={headingId} className="font-semibold">
					{t`Block types`}
				</h2>
				<p className="text-sm text-kumo-subtle">
					{t`Database-owned definitions available to blocks fields.`}
				</p>
			</div>
			<DataTable aria-labelledby={headingId}>
				<thead>
					<tr>
						<th scope="col">{t`Name`}</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Slug`}
						</th>
						<th scope="col" className="w-0">
							{t`Version`}
						</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Block type versions`}
						</th>
					</tr>
				</thead>
				<tbody>
					{isLoading ? (
						<DataTableMessage colSpan={4}>{t`Loading block types…`}</DataTableMessage>
					) : blockTypes.length === 0 ? (
						<DataTableMessage colSpan={4}>{t`No block types defined`}</DataTableMessage>
					) : (
						blockTypes.map((blockType) => {
							const slug = (
								<code dir="ltr" className={cn(cellCodeClassName, "text-xs text-kumo-subtle")}>
									{blockType.slug}
								</code>
							);
							return (
								<tr key={blockType.slug}>
									<td>
										<div className="font-medium @max-2xl:wrap-anywhere">{blockType.label}</div>
										{blockType.description && (
											<p className="text-sm text-kumo-subtle">{blockType.description}</p>
										)}
										<RowMeta priority="tertiary">
											{slug}
											<span aria-hidden="true">·</span>
											<span className="text-xs">
												{plural(blockType.versions.length, {
													one: "# version",
													other: "# versions",
												})}
											</span>
										</RowMeta>
									</td>
									<td {...tertiaryColumn}>{slug}</td>
									<td>
										<Badge variant="secondary">{t`Active v${blockType.currentVersion}`}</Badge>
									</td>
									<td {...tertiaryColumn}>
										<ul className="max-w-80 space-y-1 text-xs text-kumo-subtle">
											{blockType.versions.map((version) => (
												<li key={version.version}>
													{version.active
														? t`Version ${version.version} (active)`
														: t`Version ${version.version}`}{" "}
													·{" "}
													<code dir="ltr" className="wrap-anywhere">
														{version.fingerprint}
													</code>
												</li>
											))}
										</ul>
									</td>
								</tr>
							);
						})
					)}
				</tbody>
			</DataTable>
		</section>
	);
}
