#!/bin/sh
# Date/Timezone Diagnostic Script
# Run on VPS: bash test-dates.sh
# Zero dependencies — pure shell + system date command

SEP="────────────────────────────────────────────────────────────"

echo "$SEP"
echo "DATE/TIMEZONE DIAGNOSTIC"
echo "$SEP"

# 1. Environment
echo ""
echo "[1] ENVIRONMENT"
echo "  BOT_TIMEZONE env:    ${BOT_TIMEZONE:-(not set)}"
echo "  TZ env:              ${TZ:-(not set)}"
echo "  System timezone:     $(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null || echo 'unknown')"
echo "  Kernel:              $(uname -r)"
echo "  OS:                  $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || uname -s)"

# 2. Raw system time
echo ""
echo "[2] RAW SYSTEM TIME"
echo "  date:                $(date)"
echo "  date -u (UTC):       $(date -u)"
echo "  date +%Z:            $(date +%Z)"
echo "  date +%:z (offset):  $(date +%:z 2>/dev/null || date +%z)"
echo "  epoch:               $(date +%s)"

# 3. DR timezone comparison
DR_TZ="${BOT_TIMEZONE:-America/Santo_Domingo}"
echo ""
echo "[3] DR TIMEZONE COMPARISON (target: $DR_TZ)"

# Get time in DR timezone
if command -v timedatectl >/dev/null 2>&1; then
    echo "  timedatectl:"
    timedatectl | grep -E "Local time|Time zone|UTC" | sed 's/^/    /'
fi

DR_TIME=$(TZ="$DR_TZ" date "+%Y-%m-%d %H:%M:%S %Z (UTC%:z)" 2>/dev/null)
SYS_TIME=$(date "+%Y-%m-%d %H:%M:%S %Z (UTC%:z)" 2>/dev/null)
UTC_TIME=$(date -u "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null)

echo "  UTC time:            $UTC_TIME"
echo "  System local time:   $SYS_TIME"
echo "  DR time ($DR_TZ): $DR_TIME"

SYS_HOUR=$(date +%H)
DR_HOUR=$(TZ="$DR_TZ" date +%H)
UTC_HOUR=$(date -u +%H)

echo ""
echo "  System hour:         $SYS_HOUR"
echo "  DR hour:             $DR_HOUR"
echo "  UTC hour:            $UTC_HOUR"

DIFF=$((DR_HOUR - SYS_HOUR))
echo "  Sys vs DR diff:      ${DIFF} hours"

# 4. What the bot's dayjs would see
echo ""
echo "[4] WHAT THE BOT SEES"
echo "  The bot uses dayjs().tz('$DR_TZ') to get the current time."
echo "  dayjs() starts from system time, then converts to the target timezone."
echo ""
echo "  If system TZ = UTC and DR = UTC-4:"
echo "    System hour $SYS_HOUR -> DR hour should be $((SYS_HOUR - 4)) (or +20 if negative)"
echo "    Actual DR hour via TZ: $DR_HOUR"

# 5. Check for the +3h ahead bug
echo ""
echo "[5] CHECKING FOR +3 HOURS AHEAD BUG"

# The user reports dates are ~3 hours ahead.
# DR is UTC-4. If bot reports UTC instead of DR time, it would be +4h ahead.
# If bot reports UTC-1 somehow, it would be +3h ahead.
# Common cause: dayjs doesn't have timezone data, falls back to system TZ.

echo "  Expected DR offset:  UTC-4 (AST, no DST)"
SYS_OFFSET_MIN=$(date +%z | sed 's/\([+-]\)\([0-9][0-9]\)\([0-9][0-9]\)/\1(\2*60+\3)/' | bc 2>/dev/null || echo "unknown")
DR_OFFSET_MIN=$(TZ="$DR_TZ" date +%z | sed 's/\([+-]\)\([0-9][0-9]\)\([0-9][0-9]\)/\1(\2*60+\3)/' | bc 2>/dev/null || echo "unknown")

SYS_OFFSET_RAW=$(date +%z)
DR_OFFSET_RAW=$(TZ="$DR_TZ" date +%z)
echo "  System offset:       $SYS_OFFSET_RAW"
echo "  DR offset:           $DR_OFFSET_RAW"

echo ""
echo "  Possible explanations for +3h ahead:"
echo "    a) VPS is UTC+0, dayjs falls back to UTC -> shows +4h ahead"
echo "    b) VPS is UTC-1 (e.g. Azores), dayjs uses system TZ -> shows +3h ahead"
echo "    c) dayjs timezone plugin not working, uses local time as-is"
echo "    d) BOT_TIMEZONE is set to a wrong value"

# 6. Timezone data check
echo ""
echo "[6] TIMEZONE DATA AVAILABILITY"
if [ -f "/usr/share/zoneinfo/$DR_TZ" ]; then
    echo "  /usr/share/zoneinfo/$DR_TZ: EXISTS (good)"
else
    echo "  /usr/share/zoneinfo/$DR_TZ: MISSING (!!)"
    echo "  ⚠  This could cause dayjs to fail timezone conversion!"
fi

if [ -d "/usr/share/zoneinfo" ]; then
    TZ_COUNT=$(find /usr/share/zoneinfo -type f 2>/dev/null | wc -l)
    echo "  Timezone files found: $TZ_COUNT"
else
    echo "  /usr/share/zoneinfo: MISSING"
    echo "  ⚠  No system timezone data! dayjs may not be able to convert timezones."
fi

# Check if tzdata is installed (Debian/Ubuntu)
if command -v dpkg >/dev/null 2>&1; then
    TZDATA=$(dpkg -l tzdata 2>/dev/null | grep ^ii | awk '{print $3}')
    echo "  tzdata package:      ${TZDATA:-NOT INSTALLED}"
elif command -v rpm >/dev/null 2>&1; then
    TZDATA=$(rpm -q tzdata 2>/dev/null)
    echo "  tzdata package:      ${TZDATA:-NOT INSTALLED}"
fi

# 7. .env file check
echo ""
echo "[7] .ENV FILE CHECK"
if [ -f ".env" ]; then
    BOT_TZ_LINE=$(grep "BOT_TIMEZONE" .env 2>/dev/null)
    TZ_LINE=$(grep "^TZ=" .env 2>/dev/null)
    echo "  .env exists:         yes"
    echo "  BOT_TIMEZONE line:   ${BOT_TZ_LINE:-(not found)}"
    echo "  TZ line:             ${TZ_LINE:-(not found)}"
else
    echo "  .env exists:         no (not in current dir)"
    echo "  Try running from the bot's directory"
fi

# 8. Summary
echo ""
echo "$SEP"
echo "SUMMARY"
echo "$SEP"

ISSUES=0

if [ "$SYS_OFFSET_RAW" != "-0400" ]; then
    ISSUES=$((ISSUES + 1))
    echo "  $ISSUES. System timezone ($SYS_OFFSET_RAW) is NOT DR time (-0400)."
    echo "     The bot's dayjs().tz() should handle this, but any code using"
    echo "     raw new Date() will get the wrong local time."
fi

if [ ! -f "/usr/share/zoneinfo/$DR_TZ" ]; then
    ISSUES=$((ISSUES + 1))
    echo "  $ISSUES. Timezone data for $DR_TZ is missing!"
    echo "     Install tzdata: apt install tzdata (Debian/Ubuntu)"
    echo "     or: yum install tzdata (RHEL/CentOS)"
fi

if [ "$ISSUES" -eq 0 ]; then
    echo "  No obvious system-level timezone issues."
    echo "  The bug is likely in the dayjs code itself."
    echo "  Consider setting TZ=$DR_TZ in your .env or systemd service"
    echo "  to make new Date() match DR time as a workaround."
fi

echo ""
echo "QUICK FIX: Add TZ=$DR_TZ to your bot's environment"
echo "  e.g., in .env:   TZ=America/Santo_Domingo"
echo "  or systemd:      Environment=TZ=America/Santo_Domingo"
echo "  This makes ALL date functions use DR time by default."

echo ""
echo "$SEP"
echo "END DIAGNOSTIC"
echo "$SEP"
