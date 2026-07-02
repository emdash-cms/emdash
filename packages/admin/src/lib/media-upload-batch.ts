export interface UploadBatchProgress {
	current: number;
	total: number;
}

export interface UploadBatchFailure {
	file: File;
	error: unknown;
}

export interface UploadBatchResult<T> {
	uploaded: T[];
	failed: UploadBatchFailure[];
	total: number;
}

export async function runUploadBatch<T>(
	files: File[],
	uploadOne: (file: File) => Promise<T>,
	onProgress?: (progress: UploadBatchProgress) => void,
): Promise<UploadBatchResult<T>> {
	const uploaded: T[] = [];
	const failed: UploadBatchFailure[] = [];
	const total = files.length;
	let completed = 0;

	for (const file of files) {
		try {
			uploaded.push(await uploadOne(file));
		} catch (error) {
			failed.push({ file, error });
		} finally {
			completed += 1;
			onProgress?.({ current: completed, total });
		}
	}

	return { uploaded, failed, total };
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
	return dataTransfer.files.length > 0 || [...dataTransfer.types].includes("Files");
}

export function dataTransferFiles(dataTransfer: DataTransfer): File[] {
	return [...dataTransfer.files];
}
