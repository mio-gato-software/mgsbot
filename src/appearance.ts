import { existsSync } from "node:fs";

const POSSIBLE_PATHS = [
	"./memory/base.png",
	"./memory/base.jpg",
	"./memory/base.jpeg",
];

export function getBaseImagePath(): string | null {
	return POSSIBLE_PATHS.find((p) => existsSync(p)) ?? null;
}
