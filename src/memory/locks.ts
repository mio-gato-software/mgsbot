// Prevents interleaved load/modify/save of the same chat's sensory buffer
// across concurrent handlers (text, voice, photo arriving back-to-back).
// Each chatId has a single "tail" promise; new ops wait for it and then
// install themselves as the new tail.
const chatLocks = new Map<number, Promise<unknown>>();

export async function withChatLock<T>(
	chatId: number,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = chatLocks.get(chatId) ?? Promise.resolve();
	// Chain the new op; swallow predecessor failures so one broken op
	// doesn't poison the whole queue, but still run fn.
	const next = prev.then(
		() => fn(),
		() => fn(),
	);
	const tail = next.catch(() => {});
	chatLocks.set(chatId, tail);
	try {
		return await next;
	} finally {
		// Release the lock if nothing else queued behind us.
		if (chatLocks.get(chatId) === tail) {
			chatLocks.delete(chatId);
		}
	}
}
