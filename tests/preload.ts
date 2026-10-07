import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always replace inherited configuration: bun test must never mutate live memory.
const root = mkdtempSync(join(tmpdir(), "mgsbot-tests-"));
process.env.MEMORY_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

process.env.ENABLE_FOLLOW_UPS = "false";
process.env.ENABLE_CHECK_INS = "false";
process.env.SIMPLE_ASSISTANT_MODE = "false";
process.env.FULL_ACCESS_MODE = "false";
process.env.SHOW_TRANSCRIPTION = "false";
process.env.ENABLE_CHAT_LOG = "false";
process.env.ENABLE_GROUP_VOICE_CONTEXT = "true";
process.env.GROUP_PASSIVE_VOICE_MAX_SECONDS = "120";
process.env.GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS = "1200";
// Optional internet features must never spend inherited API credentials in tests.
process.env.ENABLE_WEB_SEARCH = "false";
delete process.env.TYPESAFE_API_KEY;
