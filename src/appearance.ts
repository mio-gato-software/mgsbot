import { existsSync } from "node:fs";
import { memoryPath } from "./runtime-paths.ts";

const POSSIBLE_PATHS = [
	memoryPath("base.png"),
	memoryPath("base.jpg"),
	memoryPath("base.jpeg"),
];

export function getBaseImagePath(): string | null {
	return POSSIBLE_PATHS.find((p) => existsSync(p)) ?? null;
}
