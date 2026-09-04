export const CURRENT_SCHEMA_VERSION = 1;

export interface Versioned<T> {
	schemaVersion: number;
	data: T;
}

export function wrapVersioned<T>(data: T): Versioned<T> {
	return { schemaVersion: CURRENT_SCHEMA_VERSION, data };
}

function isVersioned(raw: unknown): raw is Versioned<unknown> {
	return (
		typeof raw === "object" &&
		raw !== null &&
		!Array.isArray(raw) &&
		typeof (raw as { schemaVersion?: unknown }).schemaVersion === "number" &&
		"data" in raw
	);
}

/**
 * Extract the payload from a parsed store file. Wrapped files return their
 * `data`; legacy files (bare arrays, or objects written before schemaVersion
 * existed) are returned unchanged.
 */
export function unwrapVersioned<T>(raw: unknown): T {
	if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) {
		const version = (raw as { schemaVersion: unknown }).schemaVersion;
		if (version !== CURRENT_SCHEMA_VERSION) {
			throw new Error(`Unsupported memory schema version: ${String(version)}`);
		}
	}
	// Legacy v0 payloads retain their shape; the next successful save stamps v1.
	return isVersioned(raw) ? (raw.data as T) : (raw as T);
}
