import { $ } from "bun";

const bump = process.argv[2] as "patch" | "minor" | "major" | undefined;

if (!bump || !["patch", "minor", "major"].includes(bump)) {
	console.error("Uso: bun run release <patch|minor|major>");
	process.exit(1);
}

const latest = (
	await $`git describe --tags --abbrev=0 2>/dev/null`.text()
).trim();

if (!latest) {
	console.error("No se encontraron tags existentes.");
	process.exit(1);
}

const [major, minor, patch] = latest.replace("v", "").split(".").map(Number);

const next =
	bump === "major"
		? `v${major + 1}.0.0`
		: bump === "minor"
			? `v${major}.${minor + 1}.0`
			: `v${major}.${minor}.${patch + 1}`;

console.log(`${latest} → ${next}`);

await $`git tag ${next}`;
await $`git push origin ${next}`;

console.log(`Release ${next} creado.`);
