import { describe, expect, test } from "bun:test";
import {
	applyIdentityUpdate,
	findMentionedCanonicalNamesInStore,
	getAliasesForCanonicalInStore,
	type IdentityStore,
	resolveCanonicalNameInStore,
} from "../src/identities.ts";

function makeStore(): IdentityStore {
	return {
		"100": {
			userId: 100,
			canonicalName: "Lucía Ejemplo",
			aliases: ["lucia ejemplo"],
			username: "lucia",
			lastSeen: 1,
		},
		"200": {
			userId: 200,
			canonicalName: "María Ejemplo",
			aliases: ["maria ejemplo", "majo"],
			lastSeen: 1,
		},
	};
}

describe("resolveCanonicalNameInStore", () => {
	test("exact alias match (accent-insensitive)", () => {
		const store = makeStore();
		expect(resolveCanonicalNameInStore(store, "Lucía Ejemplo")).toBe(
			"Lucía Ejemplo",
		);
		expect(resolveCanonicalNameInStore(store, "MAJO")).toBe("María Ejemplo");
	});

	test("prefix match: short name resolves to full identity", () => {
		const store = makeStore();
		expect(resolveCanonicalNameInStore(store, "Lucía")).toBe("Lucía Ejemplo");
		expect(resolveCanonicalNameInStore(store, "lucia")).toBe("Lucía Ejemplo");
	});

	test("prefix match works in both directions", () => {
		const store = makeStore();
		// Query longer than the stored alias
		expect(resolveCanonicalNameInStore(store, "Majo la vecina")).toBe(
			"María Ejemplo",
		);
	});

	test("falls back to the raw name when nothing matches", () => {
		const store = makeStore();
		expect(resolveCanonicalNameInStore(store, "Desconocido")).toBe(
			"Desconocido",
		);
	});

	test("empty store returns raw name", () => {
		expect(resolveCanonicalNameInStore({}, "Juan")).toBe("Juan");
	});
});

describe("applyIdentityUpdate", () => {
	test("registers a new identity with normalized alias", () => {
		const store: IdentityStore = {};
		const canonical = applyIdentityUpdate(store, 300, "José Ejemplo", "jp", 50);
		expect(canonical).toBe("José Ejemplo");
		expect(store["300"]).toEqual({
			userId: 300,
			canonicalName: "José Ejemplo",
			aliases: ["jose ejemplo"],
			username: "jp",
			lastSeen: 50,
		});
	});

	test("name change keeps old name as alias", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Luz Ejemplo", undefined, 99);
		const identity = store["100"];
		expect(identity?.canonicalName).toBe("Luz Ejemplo");
		expect(identity?.aliases).toContain("lucia ejemplo");
		expect(identity?.aliases).toContain("luz ejemplo");
		expect(identity?.lastSeen).toBe(99);
	});

	test("repeated update with the same name does not duplicate aliases", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Lucía Ejemplo");
		applyIdentityUpdate(store, 100, "Lucía Ejemplo");
		expect(store["100"]?.aliases).toEqual(["lucia ejemplo"]);
	});

	test("update without username preserves the existing one", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Lucía Ejemplo", undefined);
		expect(store["100"]?.username).toBe("lucia");
	});
});

describe("getAliasesForCanonicalInStore", () => {
	test("returns all aliases for a known canonical name", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "María Ejemplo")).toEqual([
			"maria ejemplo",
			"majo",
		]);
	});

	test("matches via alias too", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "majo")).toEqual([
			"maria ejemplo",
			"majo",
		]);
	});

	test("unknown name returns its own normalized form", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "Pedro Ejemplo")).toEqual([
			"pedro ejemplo",
		]);
	});
});

describe("findMentionedCanonicalNamesInStore", () => {
	test("finds identities mentioned by alias in free text", () => {
		const store = makeStore();
		const mentioned = findMentionedCanonicalNamesInStore(
			store,
			"ayer salí con Majo al cine",
		);
		expect(mentioned).toEqual(["María Ejemplo"]);
	});

	test("finds mentions by username with @", () => {
		const store = makeStore();
		const mentioned = findMentionedCanonicalNamesInStore(
			store,
			"pregúntale a @lucia",
		);
		expect(mentioned).toEqual(["Lucía Ejemplo"]);
	});

	test("does not match substrings inside other words", () => {
		const store = makeStore();
		// "majosa" contains "majo" but is not a word-boundary match
		const mentioned = findMentionedCanonicalNamesInStore(
			store,
			"la comida estaba majosa",
		);
		expect(mentioned).toEqual([]);
	});

	test("returns each identity at most once", () => {
		const store = makeStore();
		const mentioned = findMentionedCanonicalNamesInStore(
			store,
			"majo y maria ejemplo son la misma persona",
		);
		expect(mentioned).toEqual(["María Ejemplo"]);
	});
});
