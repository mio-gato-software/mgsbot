import { configureTaskBehaviorsFile } from "../src/commitments/behavior-config.ts";

const file = process.argv[2];
if (!file) throw new Error("Usage: bun run behaviors:configure <config.json>");
await configureTaskBehaviorsFile(file);
console.log(
	"Conditional behaviors saved. Parent schedule, report and expiry preserved.",
);
