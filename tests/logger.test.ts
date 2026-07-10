import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { log } from "../src/logger.ts";

const originalLogLevel = process.env.LOG_LEVEL;
const originalNodeEnv = process.env.NODE_ENV;

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	logSpy = spyOn(console, "log").mockImplementation(() => {});
	warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	warnSpy.mockRestore();
	errorSpy.mockRestore();
	if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = originalLogLevel;
	process.env.NODE_ENV = originalNodeEnv;
});

describe("log level filtering", () => {
	test("LOG_LEVEL=debug passes everything through", () => {
		process.env.LOG_LEVEL = "debug";
		log.debug("[test] debug");
		log.info("[test] info");
		log.warn("[test] warn");
		log.error("[test] error");
		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	test("LOG_LEVEL=info suppresses debug only", () => {
		process.env.LOG_LEVEL = "info";
		log.debug("[test] debug");
		log.info("[test] info");
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith("[test] info");
	});

	test("LOG_LEVEL=warn suppresses debug and info", () => {
		process.env.LOG_LEVEL = "warn";
		log.debug("[test] debug");
		log.info("[test] info");
		log.warn("[test] warn");
		log.error("[test] error");
		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	test("LOG_LEVEL=error keeps only errors", () => {
		process.env.LOG_LEVEL = "error";
		log.warn("[test] warn");
		log.error("[test] error");
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	test("defaults to debug when NODE_ENV=development", () => {
		delete process.env.LOG_LEVEL;
		process.env.NODE_ENV = "development";
		log.debug("[test] debug");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	test("defaults to info outside development", () => {
		delete process.env.LOG_LEVEL;
		process.env.NODE_ENV = "production";
		log.debug("[test] debug");
		log.info("[test] info");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	test("invalid LOG_LEVEL falls back to the default", () => {
		process.env.LOG_LEVEL = "verbose";
		process.env.NODE_ENV = "production";
		log.debug("[test] debug");
		expect(logSpy).not.toHaveBeenCalled();
	});

	test("passes multiple args through unchanged", () => {
		process.env.LOG_LEVEL = "info";
		log.info("[scope] message", { a: 1 });
		expect(logSpy).toHaveBeenCalledWith("[scope] message", { a: 1 });
	});
});
