import { existsSync } from "node:fs";

const POSSIBLE_PATHS = [
	"./memory/base.png",
	"./memory/base.jpg",
	"./memory/base.jpeg",
	"./memory/brendy-base.png",
	"./memory/brendy-base.jpg",
	"./memory/brendy-base.jpeg",
];

export function getBrendyBasePath(): string | null {
	return POSSIBLE_PATHS.find((p) => existsSync(p)) ?? null;
}
