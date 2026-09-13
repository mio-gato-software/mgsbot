import {
	loadMemoryUsage,
	summarizeMemoryUsage,
} from "../src/memory/usage-metrics.ts";

const records = await loadMemoryUsage();
const summary = summarizeMemoryUsage(records);
if (process.argv.includes("--json"))
	console.log(JSON.stringify(summary, null, 2));
else {
	console.log(`Memory usage: ${records.length} records`);
	console.table(summary.groups);
	const { lookups, hits } = summary.embeddingCache;
	console.log(
		`Embedding cache: ${hits}/${lookups} hits (${lookups ? ((100 * hits) / lookups).toFixed(1) : 0}%)`,
	);
	console.log(
		`Memory prompt characters: average ${Math.round(summary.prompts.averageMemoryChars)}, maximum ${summary.prompts.maxMemoryChars}`,
	);
	console.log(
		"Token totals include only reported usage. Fallback chat providers and failed calls may have unknown usage; calls with known tokens are shown separately. Cached/reasoning counts are provider-reported subsets/components, not additional totals. SDK-internal retries may not be observable. Dollar cost depends on your provider rates.",
	);
}
