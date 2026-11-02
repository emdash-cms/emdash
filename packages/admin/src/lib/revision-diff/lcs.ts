/**
 * Index pairs of a longest common subsequence of `a` and `b`, in order. Uses `a.length * b.length`
 * cells, so callers bound the input size. Among equally long answers it leaves items of `a`
 * unmatched first, which keeps a deletion ahead of the insertion that replaces it.
 */
export function lcsPairs(a: Int32Array, b: Int32Array): Array<[number, number]> {
	const rows = a.length;
	const columns = b.length + 1;
	// Suffix lengths: table[i * columns + j] is the LCS length of a[i..] and b[j..].
	const table = new Uint32Array((rows + 1) * columns);
	for (let i = rows - 1; i >= 0; i--) {
		const item = a[i];
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * columns + j] =
				item === b[j]
					? (table[(i + 1) * columns + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * columns + j] ?? 0, table[i * columns + j + 1] ?? 0);
		}
	}

	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < b.length) {
		if (a[i] === b[j]) {
			pairs.push([i, j]);
			i++;
			j++;
		} else if ((table[(i + 1) * columns + j] ?? 0) >= (table[i * columns + j + 1] ?? 0)) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}

/** Maps each distinct string to a small integer, so sequences compare as typed arrays. */
export function createInterner(): (values: readonly string[]) => Int32Array {
	const ids = new Map<string, number>();
	return (values) =>
		Int32Array.from(values, (value) => {
			let id = ids.get(value);
			if (id === undefined) {
				id = ids.size;
				ids.set(value, id);
			}
			return id;
		});
}
