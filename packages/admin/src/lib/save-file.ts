/**
 * Where a generated file goes when the user saves it: straight to disk
 * through the File System Access API where the browser has it, otherwise
 * into memory and then a regular download once complete.
 */

interface SaveFilePickerOptions {
	suggestedName: string;
	types: Array<{ description: string; accept: Record<string, string[]> }>;
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

function isSaveFilePicker(value: unknown): value is SaveFilePicker {
	return typeof value === "function";
}

function saveFilePicker(): SaveFilePicker | null {
	if (typeof window === "undefined") return null;
	const picker: unknown = Reflect.get(window, "showSaveFilePicker");
	return isSaveFilePicker(picker) ? picker.bind(window) : null;
}

/** Whether a saved file can be written to disk as it is produced. */
export function canStreamToDisk(): boolean {
	return saveFilePicker() !== null;
}

export interface SaveTarget {
	sink: WritableStream<Uint8Array>;
	/** Call once the sink has closed successfully. */
	finish: () => void;
}

/**
 * Open a destination for a file. Call it directly from the click handler:
 * the save picker needs the user's gesture. Returns null if the user
 * dismisses the picker.
 */
export async function openSaveTarget(options: {
	suggestedName: string;
	description: string;
	mediaType: string;
	extension: string;
}): Promise<SaveTarget | null> {
	const picker = saveFilePicker();
	if (picker) {
		let handle: FileSystemFileHandle;
		try {
			handle = await picker({
				suggestedName: options.suggestedName,
				types: [
					{
						description: options.description,
						accept: { [options.mediaType]: [options.extension] },
					},
				],
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return null;
			throw error;
		}
		return { sink: await handle.createWritable(), finish: () => undefined };
	}

	const chunks: Array<Uint8Array<ArrayBuffer>> = [];
	return {
		sink: new WritableStream<Uint8Array>({
			write(chunk) {
				chunks.push(chunk.slice());
			},
		}),
		finish: () => {
			const url = URL.createObjectURL(new Blob(chunks, { type: options.mediaType }));
			chunks.length = 0;
			const link = document.createElement("a");
			link.href = url;
			link.download = options.suggestedName;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		},
	};
}
