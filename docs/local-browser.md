# Optional local browser

Installations can connect to a separately managed Chromium browser over CDP. The bot never installs, downloads or launches a browser. No extra package is required by the executable. Without renderer configuration or a Browserbase key, ordinary direct HTTP reading remains available.

## Select a renderer

```dotenv
BROWSER_PROVIDER=local
LOCAL_BROWSER_CDP_URL=http://127.0.0.1:9223
```

Restart the bot after changing `.env`. Only numeric loopback HTTP origins with an explicit port are accepted (`127.0.0.1` or `[::1]`). The bot discovers `/json/version`, rejects redirects, and accepts only a browser WebSocket on that same address and port. Bind the browser to loopback; never publish its debugging port. The integration is intended for a dedicated browser under the administrator's control, with no personal profile, credentials or other users' tabs.

Other choices are `BROWSER_PROVIDER=browserbase` (requires `BROWSERBASE_API_KEY`) and `BROWSER_PROVIDER=none` (static reading). When unset, a nonblank Browserbase key selects Browserbase; otherwise rendering is disabled. `ENABLE_BROWSER_READING=false` overrides renderer selection. `ENABLE_WEB_READING=false` disables research page lookups entirely.

Local mode also bypasses Browserbase Fetch for shared-link previews and static fallbacks, even if a Browserbase key is retained. It consumes no Browserbase browser-session or Fetch quota. Brave searches and model calls retain their own usage and limits; existing provider quota ledgers are preserved. Switching back to Browserbase resumes those guards.

## Example Linux service

Install Chromium separately using your operating system's package manager. Confirm the executable path. The following example is a **user** systemd unit named `mgsbot-browser.service`; adjust paths and port for the installation:

```ini
[Unit]
Description=Optional isolated research browser

[Service]
ExecStart=/usr/bin/chromium --headless --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir=%h/.local/share/mgsbot-browser --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback> about:blank
Restart=on-failure
RestartSec=5
MemoryMax=1536M
TasksMax=256
UMask=0077

[Install]
WantedBy=default.target
```

Keep Chromium's sandbox enabled and run as an ordinary user. The deliberately unreachable proxy prevents the browser from fetching resources outside application interception; port 9 must not host a proxy. The bot fetches allowed GET/HEAD resources through its own pinned public-address transport and supplies the responses to Chromium. A fresh incognito context per read repeats the deny-egress proxy setting, denies downloads and is explicitly disposed after success or failure, with disconnect disposal as a safety net. The bot never closes the shared browser process.

```bash
systemctl --user daemon-reload
systemctl --user enable --now mgsbot-browser.service
curl --fail http://127.0.0.1:9223/json/version
```

Use the same loopback address in the bot configuration. For containers, loopback must refer to the same network namespace; an arbitrary remote CDP address is intentionally unsupported. On macOS or Windows, administrators may run a compatible dedicated Chromium process with the same CDP/profile/proxy settings, using their platform's service manager. Those platforms do not require systemd and the bot binary has no platform-specific browser dependency.

## Limits and verification

Rendering uses the same bounded read-only DOM snapshot as Browserbase: public URL validation, pinned resource fetching, blocked non-GET/HEAD requests, images/media/fonts, WebSockets and downloads, at most 160 resources, and a 45-second operation deadline. Local mode allows at most two concurrent reads per bot process. Browser resource limits belong to the external service; tune them for your host. Each instance needs its own browser/profile/port or an administrator-managed capacity plan.

If the browser is unavailable, busy or cannot render the page, the bot falls back to explicitly labeled static text. It does not silently switch from local mode to billed Browserbase calls. Late-loading widgets, anti-bot pages and sites requiring login may remain unreadable. This integration reads public pages; it does not add clicks, forms, logins or arbitrary model-generated scripts.

Before enabling production, verify a JavaScript-generated public page returns `method: "browser-rendered page"`, private resource URLs are blocked, completed reads leave no incognito contexts, and stopping the browser still permits static fallback. Test the installation's complete research task separately: rendering does not guarantee the source publishes correct or current sports data.

Protocol references: [Chrome headless debugging](https://developer.chrome.com/docs/automation-and-testing/debug-headless), [isolated CDP browser contexts](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-createBrowserContext).
