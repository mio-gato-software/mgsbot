/** Serializes snapshot capture against asynchronous persistence operations. */
let tail: Promise<unknown> = Promise.resolve();
export async function withPersistenceLock<T>(
	work: () => Promise<T>,
): Promise<T> {
	const next = tail.then(work, work);
	tail = next.catch(() => {});
	return next;
}
