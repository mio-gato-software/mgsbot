/**
 * Date/Timezone Diagnostic Script
 * Run directly on VPS: bun run test-dates.ts
 *
 * Tests all date/timezone functions to identify discrepancies.
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

import {
	BOT_TZ,
	botNow,
	formatDateTime,
	formatTime,
	getBotDay,
	getBotHour,
	getBotMinute,
	getDateString,
} from "./src/bot-time.ts";
import {
	generateRandomWeeklyTargetTime,
	getTodayDate,
	getWeekStart,
} from "./src/image-scheduler.ts";

const SEP = "─".repeat(60);

console.log(SEP);
console.log("DATE/TIMEZONE DIAGNOSTIC");
console.log(SEP);

// 1. Environment
console.log("\n[1] ENVIRONMENT");
console.log(
	`  BOT_TIMEZONE env:    ${process.env.BOT_TIMEZONE ?? "(not set)"}`,
);
console.log(`  BOT_TZ resolved:     ${BOT_TZ}`);
console.log(`  TZ env:              ${process.env.TZ ?? "(not set)"}`);
console.log(`  Bun version:         ${Bun.version}`);
console.log(
	`  OS timezone:         ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
);

// 2. Raw system time
console.log("\n[2] RAW SYSTEM TIME");
const now = new Date();
console.log(`  new Date():          ${now.toString()}`);
console.log(`  Date.toISOString():  ${now.toISOString()}`);
console.log(`  Date.getTime():      ${now.getTime()}`);
console.log(`  Date UTC:            ${now.toUTCString()}`);
console.log(
	`  Date local hours:    ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`,
);
console.log(
	`  Date.getTimezoneOffset(): ${now.getTimezoneOffset()} min (${-now.getTimezoneOffset() / 60} hours from UTC)`,
);

// 3. dayjs raw
console.log("\n[3] DAYJS RAW");
const djNow = dayjs();
const djUtc = dayjs.utc();
const djTzBug = dayjs().tz(BOT_TZ);
const djTzFix = dayjs.utc().tz(BOT_TZ);
console.log(
	`  dayjs():                ${djNow.format("YYYY-MM-DD HH:mm:ss Z")}`,
);
console.log(
	`  dayjs.utc():            ${djUtc.format("YYYY-MM-DD HH:mm:ss Z")}`,
);
console.log(
	`  dayjs().tz() [OLD BUG]: ${djTzBug.format("YYYY-MM-DD HH:mm:ss Z")}`,
);
console.log(
	`  dayjs.utc().tz() [FIX]: ${djTzFix.format("YYYY-MM-DD HH:mm:ss Z")}`,
);
console.log(`  dayjs TZ offset:        ${djTzFix.utcOffset()} min`);

// 4. bot-time.ts functions
console.log("\n[4] bot-time.ts FUNCTIONS");
const botNowVal = botNow();
console.log(
	`  botNow():            ${botNowVal.format("YYYY-MM-DD HH:mm:ss Z")}`,
);
console.log(`  botNow().hour():     ${botNowVal.hour()}`);
console.log(`  botNow().minute():   ${botNowVal.minute()}`);
console.log(`  botNow().day():      ${botNowVal.day()} (0=Sun)`);
console.log(`  getBotHour():        ${getBotHour()}`);
console.log(`  getBotMinute():      ${getBotMinute()}`);
console.log(`  getBotDay():         ${getBotDay()}`);
console.log(`  getDateString():     ${getDateString()}`);
console.log(`  formatDateTime():    ${formatDateTime()}`);
console.log(`  formatTime():        ${formatTime()}`);

// 5. Sleep schedule check
console.log("\n[5] SLEEP SCHEDULE CHECK");
const hour = getBotHour();
const minute = getBotMinute();
const isSleeping = hour < 6 || (hour === 23 && minute >= 30);
console.log(
	`  Current bot hour:    ${hour}:${String(minute).padStart(2, "0")}`,
);
console.log(`  Sleep range:         23:30 - 06:00`);
console.log(`  Is sleeping:         ${isSleeping}`);
console.log(
	`  ENABLE_SLEEP_SCHEDULE: ${process.env.ENABLE_SLEEP_SCHEDULE ?? "(not set, default true)"}`,
);

// 6. Image scheduler dates
console.log("\n[6] IMAGE SCHEDULER DATES");
console.log(`  getTodayDate():      ${getTodayDate()}`);
console.log(`  getWeekStart():      ${getWeekStart()}`);
const target = generateRandomWeeklyTargetTime();
console.log(`  random weekly target: ${target}`);
console.log(`    parsed as Date:    ${new Date(target).toString()}`);
console.log(
	`    parsed as bot tz:  ${dayjs(target).tz(BOT_TZ).format("YYYY-MM-DD HH:mm:ss Z")}`,
);

// 7. Comparison: new Date() vs bot timezone
console.log("\n[7] POTENTIAL ISSUES");
const sysHour = now.getHours();
const botHourVal = getBotHour();
const hourDiff = botHourVal - sysHour;
console.log(`  System local hour:   ${sysHour}`);
console.log(`  Bot timezone hour:   ${botHourVal}`);
console.log(
	`  Difference:          ${hourDiff > 0 ? "+" : ""}${hourDiff} hours`,
);
if (hourDiff !== 0) {
	console.log(
		`  ⚠  System timezone differs from bot timezone by ${Math.abs(hourDiff)} hour(s)`,
	);
	console.log(
		`     This can cause issues in code that uses new Date() directly`,
	);
	console.log(`     instead of botNow() / getBotHour() / etc.`);
}

// Check if image-scheduler's generateRandomWeeklyTargetTime uses local time
const dateStr = getTodayDate();
const [y, m, d] = dateStr.split("-").map(Number);
const localDate = new Date(y, m - 1, d);
console.log(`\n  Image scheduler date construction test:`);
console.log(`    Bot date string:   ${dateStr}`);
console.log(`    new Date(y,m-1,d): ${localDate.toString()}`);
console.log(
	`    This Date's hours: ${localDate.getHours()} (should be 0 in local TZ)`,
);

// Check: targetDate.toISOString() in generateRandomWeeklyTargetTime
// uses UTC, but target comparison in shouldGenerateImageNow uses new Date()
const fakeTarget = new Date(y, m - 1, d, 10, 30, 0, 0); // 10:30 AM local
console.log(`\n  ISO vs local comparison test:`);
console.log(`    Local 10:30 AM:    ${fakeTarget.toString()}`);
console.log(`    .toISOString():    ${fakeTarget.toISOString()}`);
console.log(`    ⚠  Note: toISOString() converts to UTC. If VPS is in UTC,`);
console.log(`       a target of "10:30 bot time" stored as ISO will actually`);
console.log(
	`       be "${dayjs.tz(`${dateStr} 10:30`, BOT_TZ).toISOString()}" in UTC`,
);

// 8. Follow-ups time window
console.log("\n[8] FOLLOW-UPS TIME WINDOW");
const botH = getBotHour();
const isReasonableHour =
	botH >= 8 && (botH < 21 || (botH === 21 && getBotMinute() <= 30));
console.log(`  Reasonable hours:    8:00 AM - 9:30 PM bot time`);
console.log(`  Current bot time:    ${formatTime()}`);
console.log(`  Is reasonable hour:  ${isReasonableHour}`);

// 9. Summary of potential bugs
console.log(`\n${SEP}`);
console.log("SUMMARY OF POTENTIAL ISSUES");
console.log(SEP);

const issues: string[] = [];

if (hourDiff !== 0) {
	issues.push(
		`VPS system timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}) ` +
			`differs from BOT_TIMEZONE (${BOT_TZ}) by ${Math.abs(hourDiff)}h. ` +
			`Code using new Date() directly will get wrong times.`,
	);
}

if (!process.env.BOT_TIMEZONE) {
	issues.push(
		"BOT_TIMEZONE is not set — falling back to America/Santo_Domingo. " +
			"Set it explicitly in .env to be safe.",
	);
}

if (process.env.TZ && process.env.TZ !== BOT_TZ) {
	issues.push(
		`TZ env var (${process.env.TZ}) conflicts with BOT_TIMEZONE (${BOT_TZ}). ` +
			`This can cause new Date() and dayjs().tz() to disagree.`,
	);
}

if (issues.length === 0) {
	console.log("  ✓ No obvious timezone issues detected.");
} else {
	for (const [i, issue] of issues.entries()) {
		console.log(`  ${i + 1}. ${issue}`);
	}
}

console.log(`\n${SEP}`);
console.log("END DIAGNOSTIC");
console.log(SEP);
