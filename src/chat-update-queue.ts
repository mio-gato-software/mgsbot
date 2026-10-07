import { log } from "./logger.ts";

/** Waiting turns do not occupy execution slots; each chat keeps its own FIFO. */
export class ChatUpdateQueue {
	private readonly chats = new Map<string, Array<() => Promise<void>>>();
	private readonly activeChats = new Set<string>();
	private readonly capacityWaiters = new Set<() => void>();
	private readonly drainWaiters = new Set<() => void>();
	private pending = 0;

	constructor(
		private readonly concurrency: number,
		private readonly maxPending = 100,
		private readonly onError: (error: unknown) => Promise<unknown> = async (
			error,
		) => {
			log.error("[updates]", error);
		},
	) {
		if (
			!Number.isInteger(concurrency) ||
			concurrency < 1 ||
			!Number.isInteger(maxPending) ||
			maxPending < 1
		)
			throw new Error("Update queue limits must be positive integers");
	}

	size(): number {
		return this.pending;
	}

	async enqueue(chat: string, work: () => Promise<void>): Promise<void> {
		while (this.pending >= this.maxPending) {
			await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
		}
		this.pending++;
		const queue = this.chats.get(chat) ?? [];
		queue.push(work);
		this.chats.set(chat, queue);
		this.pump();
	}

	async drain(): Promise<void> {
		while (this.pending)
			await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
	}

	private pump(): void {
		for (const [chat, queue] of this.chats) {
			if (this.activeChats.size >= this.concurrency) return;
			if (this.activeChats.has(chat)) continue;
			const work = queue.shift();
			if (!work) {
				this.chats.delete(chat);
				continue;
			}
			this.activeChats.add(chat);
			void Promise.resolve()
				.then(work)
				.catch(this.onError)
				.catch((error) => log.error("[updates] Error handler failed:", error))
				.finally(() => {
					this.activeChats.delete(chat);
					this.pending--;
					// Rotate a busy chat behind other ready chats.
					this.chats.delete(chat);
					if (queue.length) this.chats.set(chat, queue);
					for (const resolve of this.capacityWaiters) resolve();
					this.capacityWaiters.clear();
					this.pump();
					if (!this.pending) {
						for (const resolve of this.drainWaiters) resolve();
						this.drainWaiters.clear();
					}
				});
		}
	}
}
