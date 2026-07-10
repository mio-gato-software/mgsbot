type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

function isLogLevel(value: string | undefined): value is LogLevel {
	return (
		value === "debug" ||
		value === "info" ||
		value === "warn" ||
		value === "error"
	);
}

/**
 * Active level, resolved per call so LOG_LEVEL set after module load
 * (e.g. via .env loading) still takes effect. Defaults to debug in
 * development (preserves the old `isDev` verbosity) and info otherwise.
 */
function threshold(): number {
	const raw = process.env.LOG_LEVEL?.toLowerCase();
	if (isLogLevel(raw)) return LEVELS[raw];
	return process.env.NODE_ENV === "development" ? LEVELS.debug : LEVELS.info;
}

/** Tiny leveled console logger. Callers keep their own `[scope]` prefixes. */
export const log = {
	debug: (...args: unknown[]): void => {
		if (threshold() <= LEVELS.debug) console.log(...args);
	},
	info: (...args: unknown[]): void => {
		if (threshold() <= LEVELS.info) console.log(...args);
	},
	warn: (...args: unknown[]): void => {
		if (threshold() <= LEVELS.warn) console.warn(...args);
	},
	error: (...args: unknown[]): void => {
		if (threshold() <= LEVELS.error) console.error(...args);
	},
};
