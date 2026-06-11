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
			canonicalName: "Eliaquín Encarnación",
			aliases: ["eliaquin encarnacion"],
			username: "eliaquin",
			lastSeen: 1,
		},
		"200": {
			userId: 200,
			canonicalName: "María José",
			aliases: ["maria jose", "majo"],
			lastSeen: 1,
		},
	};
}

describe("resolveCanonicalNameInStore", () => {
	test("exact alias match (accent-insensitive)", () => {
		const store = makeStore();
		expect(resolveCanonicalNameInStore(store, "Eliaquín Encarnación")).toBe(
			"Eliaquín Encarnación",
		);
		expect(resolveCanonicalNameInStore(store, "MAJO")).toBe("María José");
	});

	test("prefix match: short name resolves to full identity", () => {
		const store = makeStore();
		expect(resolveCanonicalNameInStore(store, "Eliaquín")).toBe(
			"Eliaquín Encarnación",
		);
		expect(resolveCanonicalNameInStore(store, "eliaquin")).toBe(
			"Eliaquín Encarnación",
		);
	});

	test("prefix match works in both directions", () => {
		const store = makeStore();
		// Query longer than the stored alias
		expect(resolveCanonicalNameInStore(store, "Majo la vecina")).toBe(
			"María José",
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
		const canonical = applyIdentityUpdate(store, 300, "José Pérez", "jp", 50);
		expect(canonical).toBe("José Pérez");
		expect(store["300"]).toEqual({
			userId: 300,
			canonicalName: "José Pérez",
			aliases: ["jose perez"],
			username: "jp",
			lastSeen: 50,
		});
	});

	test("name change keeps old name as alias", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Elia Encarnación", undefined, 99);
		const identity = store["100"];
		expect(identity?.canonicalName).toBe("Elia Encarnación");
		expect(identity?.aliases).toContain("eliaquin encarnacion");
		expect(identity?.aliases).toContain("elia encarnacion");
		expect(identity?.lastSeen).toBe(99);
	});

	test("repeated update with the same name does not duplicate aliases", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Eliaquín Encarnación");
		applyIdentityUpdate(store, 100, "Eliaquín Encarnación");
		expect(store["100"]?.aliases).toEqual(["eliaquin encarnacion"]);
	});

	test("update without username preserves the existing one", () => {
		const store = makeStore();
		applyIdentityUpdate(store, 100, "Eliaquín Encarnación", undefined);
		expect(store["100"]?.username).toBe("eliaquin");
	});
});

describe("getAliasesForCanonicalInStore", () => {
	test("returns all aliases for a known canonical name", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "María José")).toEqual([
			"maria jose",
			"majo",
		]);
	});

	test("matches via alias too", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "majo")).toEqual([
			"maria jose",
			"majo",
		]);
	});

	test("unknown name returns its own normalized form", () => {
		const store = makeStore();
		expect(getAliasesForCanonicalInStore(store, "Pedro Gómez")).toEqual([
			"pedro gomez",
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
		expect(mentioned).toEqual(["María José"]);
	});

	test("finds mentions by username with @", () => {
		const store = makeStore();
		const mentioned = findMentionedCanonicalNamesInStore(
			store,
			"pregúntale a @eliaquin",
		);
		expect(mentioned).toEqual(["Eliaquín Encarnación"]);
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
			"majo y maria jose son la misma persona",
		);
		expect(mentioned).toEqual(["María José"]);
	});
});
