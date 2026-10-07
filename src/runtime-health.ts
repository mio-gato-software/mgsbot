import { UPDATE_TIMEOUT_MS } from "./operation-deadline.ts";

export const HEARTBEAT_FILE = "/tmp/mgsbot-heartbeat";
export const UPDATE_CONCURRENCY = 4;
const HEALTH_FRESHNESS_MS = 120_000;

export interface RuntimeHealthSnapshot {
	heartbeatAt: number;
	lastPollAt: number;
	lastTurnCompletedAt: number;
	oldestTurnStartedAt: number | null;
	inFlightUpdates: number;
}

export class RuntimeHealth {
	private lastPollAt = Date.now();
	private lastTurnCompletedAt = 0;
	private readonly active = new Map<number, number>();
	private readonly pending = new Set<Promise<void>>();
	private stopping = false;

	stopAccepting(): void {
		this.stopping = true;
	}
	isStopping(): boolean {
		return this.stopping;
	}
	async track(work: () => Promise<void>): Promise<void> {
		const task = Promise.resolve().then(work);
		this.pending.add(task);
		try {
			await task;
		} finally {
			this.pending.delete(task);
		}
	}
	async drain(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}

	polled(now = Date.now()): void {
		this.lastPollAt = now;
	}
	started(id: number, now = Date.now()): void {
		this.active.set(id, now);
	}
	completed(id: number, now = Date.now()): void {
		this.active.delete(id);
		this.lastTurnCompletedAt = now;
	}
	snapshot(inFlightUpdates: number, now = Date.now()): RuntimeHealthSnapshot {
		return {
			heartbeatAt: now,
			lastPollAt: this.lastPollAt,
			lastTurnCompletedAt: this.lastTurnCompletedAt,
			oldestTurnStartedAt: this.active.size
				? Math.min(...this.active.values())
				: null,
			inFlightUpdates,
		};
	}
}

export function isRuntimeHealthy(
	state: RuntimeHealthSnapshot,
	now = Date.now(),
): boolean {
	if (
		!Number.isFinite(state.heartbeatAt) ||
		now - state.heartbeatAt > HEALTH_FRESHNESS_MS
	)
		return false;
	if (
		!Number.isFinite(state.lastPollAt) ||
		!Number.isFinite(state.inFlightUpdates)
	)
		return false;
	if (
		state.oldestTurnStartedAt !== null &&
		(!Number.isFinite(state.oldestTurnStartedAt) ||
			now - state.oldestTurnStartedAt > UPDATE_TIMEOUT_MS + 20_000)
	)
		return false;
	// Polling pauses under backpressure. Active work still has to meet its deadline.
	return (
		now - state.lastPollAt <= HEALTH_FRESHNESS_MS ||
		(state.inFlightUpdates >= UPDATE_CONCURRENCY &&
			state.oldestTurnStartedAt !== null)
	);
}
