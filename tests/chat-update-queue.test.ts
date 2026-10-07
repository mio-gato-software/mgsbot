import { expect, test } from "bun:test";
import { ChatUpdateQueue } from "../src/chat-update-queue.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("queue backpressure bounds accepted updates and drain includes newly admitted work", async () => {
	const queue = new ChatUpdateQueue(1, 1);
	const first = deferred();
	const second = deferred();
	const startedSecond = deferred();
	await queue.enqueue("first", () => first.promise);
	let admitted = false;
	const admission = queue
		.enqueue("second", async () => {
			startedSecond.resolve();
			await second.promise;
		})
		.then(() => {
			admitted = true;
		});
	await Promise.resolve();
	expect(admitted).toBe(false);
	expect(queue.size()).toBe(1);
	let drained = false;
	const draining = queue.drain().then(() => {
		drained = true;
	});
	first.resolve();
	await admission;
	await startedSecond.promise;
	expect(queue.size()).toBe(1);
	expect(drained).toBe(false);
	second.resolve();
	await draining;
	expect(queue.size()).toBe(0);
});

test("a failed update releases the chat and execution slot for queued work", async () => {
	const errors: unknown[] = [];
	const queue = new ChatUpdateQueue(1, 10, async (error) => {
		errors.push(error);
	});
	const events: string[] = [];
	await queue.enqueue("chat", async () => {
		events.push("failed");
		throw new Error("provider failed");
	});
	await queue.enqueue("chat", async () => {
		events.push("next");
	});
	await queue.drain();
	expect(events).toEqual(["failed", "next"]);
	expect(errors).toHaveLength(1);
});
