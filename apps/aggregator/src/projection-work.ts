export interface ProjectionWorkState {
	dirtyEpoch: number;
	scheduledEpoch: number;
	acknowledgedEpoch: number;
	schedulingPending: boolean;
	rebuildPending: boolean;
}

export async function readProjectionWork(db: D1Database): Promise<ProjectionWorkState> {
	const row = await db
		.prepare(
			`SELECT dirty_epoch, scheduled_epoch, acknowledged_epoch
			 FROM listing_projection_work WHERE id = 1`,
		)
		.first<{ dirty_epoch: number; scheduled_epoch: number; acknowledged_epoch: number }>();
	if (!row) throw new Error("listing projection work row is missing");
	return {
		dirtyEpoch: row.dirty_epoch,
		scheduledEpoch: row.scheduled_epoch,
		acknowledgedEpoch: row.acknowledged_epoch,
		schedulingPending: row.dirty_epoch > row.scheduled_epoch,
		rebuildPending: row.dirty_epoch > row.acknowledged_epoch,
	};
}

export async function acknowledgeProjectionScheduling(
	db: D1Database,
	dirtyEpoch: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE listing_projection_work SET scheduled_epoch = ?
			 WHERE id = 1 AND dirty_epoch >= ? AND scheduled_epoch < ?`,
		)
		.bind(dirtyEpoch, dirtyEpoch, dirtyEpoch)
		.run();
	return result.meta.changes === 1;
}

export async function acknowledgeProjectionWork(
	db: D1Database,
	dirtyEpoch: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE listing_projection_work
			 SET acknowledged_epoch = ?
			 WHERE id = 1 AND dirty_epoch = ? AND acknowledged_epoch < ?`,
		)
		.bind(dirtyEpoch, dirtyEpoch, dirtyEpoch)
		.run();
	return result.meta.changes === 1;
}
