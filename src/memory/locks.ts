// Prevents interleaved load/modify/save operations across concurrent handlers
// (text, voice, photo arriving back-to-back). Each key has a single "tail"
// promise; new ops wait for it and then install themselves as the new tail.
const locks = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(key) ?? Promise.resolve();
	// Chain the new op; swallow predecessor failures so one broken op
	// doesn't poison the whole queue, but still run fn.
	const next = prev.then(
		() => fn(),
		() => fn(),
	);
	const tail = next.catch(() => {});
	locks.set(key, tail);
	try {
		return await next;
	} finally {
		// Release the lock if nothing else queued behind us.
		if (locks.get(key) === tail) {
			locks.delete(key);
		}
	}
}

export async function withChatLock<T>(
	chatId: number,
	fn: () => Promise<T>,
): Promise<T> {
	return withKeyLock(`chat:${chatId}`, fn);
}

export async function withEpisodeLock<T>(
	chatId: number,
	fn: () => Promise<T>,
): Promise<T> {
	return withKeyLock(`episodes:${chatId}`, fn);
}

export async function withRelationshipLock<T>(
	chatId: number,
	fn: () => Promise<T>,
): Promise<T> {
	return withKeyLock(`relationship:${chatId}`, fn);
}

export async function withChapterLock<T>(
	chatId: number,
	fn: () => Promise<T>,
): Promise<T> {
	return withKeyLock(`chapters:${chatId}`, fn);
}

export async function withSemanticLock<T>(fn: () => Promise<T>): Promise<T> {
	return withKeyLock("semantic", fn);
}
