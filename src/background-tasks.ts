import { log } from "./logger.ts";

/** Owns background work and timers so imports do not start jobs and shutdown can drain them. */
export class BackgroundTasks {
	private readonly pending = new Set<Promise<void>>();
	private readonly timers = new Set<ReturnType<typeof setInterval>>();
	private readonly runningJobs = new Set<string>();
	private closed = false;

	run(name: string, work: () => Promise<unknown>): Promise<void> {
		if (this.closed)
			return Promise.reject(new Error(`Background tasks closed: ${name}`));
		const task = Promise.resolve()
			.then(work)
			.then(
				() => {},
				(error) => {
					log.error(`[background:${name}]`, error);
				},
			)
			.finally(() => {
				this.pending.delete(task);
			});
		this.pending.add(task);
		return task;
	}

	every(
		name: string,
		intervalMs: number,
		work: () => Promise<unknown>,
		immediate = false,
	): void {
		if (this.closed) throw new Error("Background tasks closed");
		const tick = () => {
			if (this.runningJobs.has(name)) return;
			this.runningJobs.add(name);
			void this.run(name, work).finally(() => this.runningJobs.delete(name));
		};
		this.timers.add(setInterval(tick, intervalMs));
		if (immediate) tick();
	}

	stopTimers(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers.clear();
	}

	async drain(): Promise<void> {
		while (this.pending.size) await Promise.all([...this.pending]);
	}

	async close(): Promise<void> {
		this.stopTimers();
		await this.drain();
		this.closed = true;
	}
}

export const backgroundTasks = new BackgroundTasks();

export function trackBackground(name: string, promise: Promise<unknown>): void {
	void backgroundTasks.run(name, () => promise);
}
