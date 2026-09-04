import { expect, test } from "bun:test";
import { BackgroundTasks } from "../src/background-tasks.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("shutdown drains nested work and stops periodic scheduling", async () => {
	const jobs = new BackgroundTasks();
	const work = Promise.withResolvers<void>();
	let completed = false;
	void jobs.run("parent", async () => {
		await work.promise;
		void jobs.run("child", async () => {
			await delay(5);
			completed = true;
		});
	});
	const closing = jobs.close();
	work.resolve();
	await closing;
	expect(completed).toBe(true);
	await expect(jobs.run("late", async () => {})).rejects.toThrow("closed");
});
test("a slow recurring job never overlaps itself", async () => {
	const jobs = new BackgroundTasks();
	const work = Promise.withResolvers<void>();
	let calls = 0;
	jobs.every(
		"slow",
		3,
		async () => {
			calls++;
			await work.promise;
		},
		true,
	);
	await delay(20);
	expect(calls).toBe(1);
	jobs.stopTimers();
	work.resolve();
	await jobs.close();
	await delay(10);
	expect(calls).toBe(1);
});
test("a failed background task does not prevent draining successful tasks", async () => {
	const jobs = new BackgroundTasks();
	let completed = false;
	void jobs.run("failure", async () => {
		throw new Error("injected failure");
	});
	void jobs.run("success", async () => {
		completed = true;
	});
	await jobs.close();
	expect(completed).toBe(true);
});

test("importing embeddings does not create a timer that keeps a process alive", () => {
	const modulePath = new URL("../src/embeddings.ts", import.meta.url).pathname;
	const result = Bun.spawnSync(
		[process.execPath, "-e", `await import(${JSON.stringify(modulePath)});`],
		{
			timeout: 3000,
			env: { PATH: process.env.PATH, MEMORY_DIR: process.env.MEMORY_DIR },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(result.exitCode).toBe(0);
});
