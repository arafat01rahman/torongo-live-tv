/* ============================================================
   app.js — Vintage Vision IPTV player
   ------------------------------------------------------------
   1. fetches a playlist listed in channels.js
   2. parses the #EXTINF records into { name, url, logo, group }
   3. renders a filterable sidebar
   4. plays the selected stream through hls.js / native HLS
   ============================================================ */

(() => {
    "use strict";

    /* ---------------- DOM ---------------- */
    const el = {
        video: document.getElementById("video-player"),
        overlay: document.getElementById("overlay"),
        overlayTitle: document.getElementById("overlay-title"),
        overlayMsg: document.getElementById("overlay-msg"),
        spinner: document.getElementById("spinner"),
        statusLine: document.getElementById("status-line"),
        list: document.getElementById("channel-list"),
        tabs: document.getElementById("tabs"),
        search: document.getElementById("search-input"),
        count: document.getElementById("count-line"),
        reload: document.getElementById("reload-btn"),
        nowName: document.getElementById("now-name"),
        nowState: document.getElementById("now-state"),
        led: document.querySelector(".led"),
        volDown: document.getElementById("volume-down"),
        volUp: document.getElementById("volume-up"),
        mute: document.getElementById("mute-btn"),
        next: document.getElementById("next-btn"),
        themeBtn: document.getElementById("theme-btn"),
        searchScope: document.getElementById("search-scope")
    };

    if (!el.video) return; // nothing to do without markup

    /* ---------------- Constants ---------------- */
    const THEME_KEY = "streamly-theme";

    /* When a search is active we reach past the selected tab and sweep
       every source, so a channel is never "unfindable" just because you
       are parked on the wrong tab. */
    const SEARCH_ALL_SOURCES =
        typeof SEARCH_ALL_TABS === "boolean" ? SEARCH_ALL_TABS : true;

    const MAX_SEARCH_RESULTS =
        typeof SEARCH_RESULT_LIMIT === "number" ? SEARCH_RESULT_LIMIT : 250;

    /* ---------------- State ---------------- */
    const state = {
        source: typeof DEFAULT_SOURCE === "string" ? DEFAULT_SOURCE : "sports",
        channels: [],          // channels of the selected tab
        searchPool: [],        // channels of every tab, built lazily
        searchPoolBuilt: false,
        searching: false,      // a query is active right now
        filtered: [],
        activeIndex: -1,
        current: null,         // what is playing (may differ from filtered[])
        loading: false,
        muteState: false
    };

    let hls = null;

    /* ---------------- Helpers ---------------- */
    function status(text, isError = false) {
        el.statusLine.textContent = "\u25AE " + text.toUpperCase();
        el.statusLine.classList.toggle("err", !!isError);
    }

    function showOverlay(title, msg, busy = false) {
        el.overlayTitle.textContent = title;
        el.overlayMsg.textContent = msg || "";
        el.spinner.hidden = !busy;
        el.overlay.classList.remove("hidden");
    }

    function hideOverlay() {
        el.spinner.hidden = true;
        el.overlay.classList.add("hidden");
    }

    function setLed(on) {
        if (el.led) el.led.classList.toggle("on", !!on);
    }

    function setState(text) {
        el.nowState.textContent = text;
    }

    function attr(infoLine, name) {
        const m = infoLine.match(new RegExp(name + '="([^"]*)"'));
        return m ? m[1].trim() : "";
    }

    /* Decode HTML entities that some playlists use (e.g. "&amp;"). */
    function decode(text) {
        return String(text || "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
    }

    /* Strip attributes/EXTVLCOPT noise that sometimes leaks into the name. */
    function cleanName(raw) {
        let name = decode(raw).replace(/\s+/g, " ").trim();
        name = name.replace(/\s*\((?:\d{3,4}p)\)\s*$/i, ""); // drop "(720p)"
        return name || "Unknown Channel";
    }

    function looksLikeStream(line) {
        if (!line || line.startsWith("#")) return false;
        if (/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(line)) return true;
        // tolerate relative/extension-only links from custom playlists
        return STREAM_EXTENSIONS.some(ext => line.toLowerCase().split("?")[0].endsWith(ext));
    }

    function isSports(group) {
        return /(^|;)\s*sports?\s*(;|$)/i.test(group || "");
    }

    /* Compare two #EXTINF records so the cross-tab search can drop
       duplicates that appear in several playlists. */
    function sameChannel(a, b) {
        if (a.url && b.url) return a.url === b.url;
        return a.name === b.name && (a.group || "") === (b.group || "");
    }

    /* ---------------- Theme ----------------
       The <head> bootstrap already painted the right theme; this only
       handles the in-page toggle and keeps <html data-theme> + the
       button label in sync. */
    function currentTheme() {
        const set = document.documentElement.getAttribute("data-theme");
        return set === "light" ? "light" : "dark";
    }

    function applyTheme(theme, persist) {
        const next = theme === "light" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);

        if (persist) {
            try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private mode */ }
        }

        if (el.themeBtn) {
            const goingTo = next === "light" ? "dark" : "light";
            el.themeBtn.setAttribute("aria-label", "Switch to " + goingTo + " theme");
            el.themeBtn.title = "Switch to " + goingTo + " theme";
        }
    }

    function initTheme() {
        applyTheme(currentTheme(), false);
        if (!el.themeBtn) return;

        el.themeBtn.addEventListener("click", () => {
            applyTheme(currentTheme() === "light" ? "dark" : "light", true);
        });

        /* Follow the OS only while the user has never made a choice. */
        if (window.matchMedia) {
            const mq = window.matchMedia("(prefers-color-scheme: light)");
            const onSystemChange = (e) => {
                let stored = null;
                try { stored = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
                if (stored === "light" || stored === "dark") return; // explicit choice wins
                applyTheme(e.matches ? "light" : "dark", false);
            };
            if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
            else if (mq.addListener) mq.addListener(onSystemChange);
        }
    }

    /* Index of the first comma outside a "quoted" attribute value,
       or -1 when the line has no delimiter. */
    function firstUnquotedComma(line) {
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') inQuotes = !inQuotes;
            else if (c === "," && !inQuotes) return i;
        }
        return -1;
    }

    /* Keyword whitelist for a source (used by the "football" tab,
       since iptv-org has no league metadata to filter on). */
    function matchesKeywords(ch, keywords) {
        if (!keywords || !keywords.length) return true;
        const haystack = ((ch.name || "") + " " + (ch.group || "")).toLowerCase();
        return keywords.some(kw => haystack.includes(kw));
    }

    /* ---------------- M3U parser ----------------
       Handles: CRLF, attribute lines, #EXTVLCOPT and #EXTGRP
       directives sitting between #EXTINF and the URL.            */
    function parseM3U(text) {
        const lines = String(text).replace(/\r/g, "").split("\n");
        const channels = [];
        let pending = null;

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw) continue;

            if (raw.startsWith("#EXTINF:")) {
                /* The title starts after the first comma that is NOT
                   inside a quoted attribute. Some feeds carry
                   http-user-agent="Mozilla/5.0 (Windows NT 10.0; ...)"
                   which contains commas, so a plain indexOf(",")
                   would cut the line in the middle of the UA string. */
                const comma = firstUnquotedComma(raw);
                const info = comma !== -1 ? raw.slice(0, comma) : raw;
                const title = comma !== -1 ? raw.slice(comma + 1) : "";
                pending = {
                    name: cleanName(title),
                    logo: attr(info, "tvg-logo"),
                    group: attr(info, "group-title"),
                    url: ""
                };
                continue;
            }

            if (pending && raw.startsWith("#EXTGRP:")) {
                pending.group = raw.slice(8).trim();
                continue;
            }

            if (raw.startsWith("#")) continue; // other directives

            if (pending && looksLikeStream(raw)) {
                pending.url = raw;
                channels.push(pending);
                pending = null;
            }
        }

        return channels;
    }

    /* ---------------- Fetch ---------------- */
    function resolveSource() {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        return map[state.source] || map[DEFAULT_SOURCE] || Object.values(map)[0] || null;
    }

    async function loadSource(sourceKey) {
        if (state.loading) return;

        const source = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES)
            ? CHANNEL_SOURCES[sourceKey || state.source]
            : null;

        if (!source || !source.url) {
            showOverlay("NO PLAYLIST", "channels.js did not define a source for this tab.");
            status("playlist config missing", true);
            return;
        }

        state.loading = true;
        state.source = sourceKey || state.source;
        syncTabs();

        state.channels = [];
        renderList();
        state.activeIndex = -1;
        el.nowName.textContent = "NO CHANNEL";
        setLed(false);
        setState("LOADING");
        status("tuning " + (source.label || state.source) + "\u2026");
        showOverlay("TUNING\u2026", "Fetching " + (source.label || "playlist") + " from the aerial.", true);

        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            typeof PLAYLIST_TIMEOUT_MS === "number" ? PLAYLIST_TIMEOUT_MS : 20000
        );

        try {
            const res = await fetch(source.url, { signal: controller.signal, cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const textRes = await res.text();

            let parsed = parseM3U(textRes);

            if (source.onlySports) {
                const onlySports = parsed.filter(ch => isSports(ch.group));
                if (onlySports.length) parsed = onlySports; // keep category file honest
            }

            if (Array.isArray(source.match) && source.match.length) {
                const matched = parsed.filter(ch => matchesKeywords(ch, source.match));
                /* Only narrow the list if the whitelist actually found
                   something — an empty tab is worse than a broad one. */
                if (matched.length) parsed = matched;
            }

            if (source.limit > 0 && parsed.length > source.limit) {
                parsed = parsed.slice(0, source.limit);
            }

            /* Tag every channel with the tab it came from so the
               cross-tab search can badge its results. */
            const key = sourceKey || state.source;
            parsed.forEach(ch => { ch.sourceKey = key; });

            state.channels = parsed;
            state.searchPool = parsed.slice();
            state.searchPoolBuilt = false;
            applyFilter();

            if (!parsed.length) {
                showOverlay("NO CHANNELS", "The playlist loaded but contained no playable links.");
                status("playlist empty", true);
                return;
            }

            status(parsed.length + " channels on the dial");
            showOverlay("SIGNAL FOUND", parsed.length + " channels \u2014 pick one, or use NEXT.", false);

        } catch (err) {
            const aborted = err && err.name === "AbortError";
            console.error(err);
            status(aborted ? "playlist timed out" : "playlist failed: " + err.message, true);
            showOverlay(
                "OUT OF RANGE",
                aborted
                    ? "The playlist took too long to answer. Check your connection and RE-TUNE."
                    : "Could not reach the playlist (" + err.message + "). Check your connection and RE-TUNE."
            );
            renderList(); // show the error/empty message inside the list too
        } finally {
            clearTimeout(timer);
            state.loading = false;
            setState(state.channels.length ? "STANDBY" : "NO SIGNAL");
        }
    }

    /* ---------------- Cross-tab search ----------------
       Lazily downloads every playlist named in channels.js and merges
       them into one de-duplicated pool. It is built on the first
       keystroke and kept for the session, so the very first search
       waits for the slowest source and every search after that is
       instant. Failures are skipped: a dead source must never stop
       the others from being searchable. */
    function buildSearchPool() {
        if (state.searchPoolBuilt) return Promise.resolve();

        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        const keys = Object.keys(map);
        const seen = new Set();

        /* Start with whatever is already loaded so results can appear
           immediately, then append the rest as they arrive. */
        const add = (list) => {
            let added = 0;
            (list || []).forEach(ch => {
                const fingerprint = (ch.url || "") + "|" + ch.name;
                if (seen.has(fingerprint)) return;
                seen.add(fingerprint);
                state.searchPool.push(ch);
                added++;
            });
            return added;
        };

        add(state.channels);

        const jobs = keys.map(async (key) => {
            if (key === state.source && state.channels.length) return; // already added
            const source = map[key];
            if (!source || !source.url) return;

            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                typeof PLAYLIST_TIMEOUT_MS === "number" ? PLAYLIST_TIMEOUT_MS : 20000
            );

            try {
                const res = await fetch(source.url, { signal: controller.signal, cache: "no-store" });
                if (!res.ok) throw new Error("HTTP " + res.status);
                const parsed = parseM3U(await res.text());
                if (add(parsed) && state.searching) applyFilter(); // live-update open results
            } catch (err) {
                /* one unreachable tab should not break the search */
                if (!err || err.name !== "AbortError") {
                    console.warn("search pool skipped " + key + ":", err && err.message);
                }
            } finally {
                clearTimeout(timer);
            }
        });

        return Promise.all(jobs).then(() => { state.searchPoolBuilt = true; });
    }

    /* Keep an active query in step with the tab the user switches to. */
    function invalidateSearchPool() {
        state.searchPoolBuilt = false;
        state.searchPool = state.channels.slice();
        if (state.searching) buildSearchPool();
    }

    /* ---------------- Filtering + rendering ---------------- */
    function applyFilter() {
        const q = (el.search.value || "").trim().toLowerCase();

        if (!q) {
            state.searching = false;
            state.filtered = state.channels.slice();
            renderSearchScope();
            renderList();
            return;
        }

        state.filtered = (SEARCH_ALL_SOURCES ? state.searchPool : state.channels)
            .filter(ch =>
                ch.name.toLowerCase().includes(q) || (ch.group || "").toLowerCase().includes(q)
            );

        state.searching = true;
        renderSearchScope();
        renderList();

        /* Ran before the pool finished building: kick it off (or finish
           it) and re-run once more data has landed. */
        if (SEARCH_ALL_SOURCES && !state.searchPoolBuilt) {
            buildSearchPool().then(() => {
                if (state.searching && (el.search.value || "").trim()) applyFilter();
            });
        }
    }

    /* Tells the user a query spans every tab, and flags when it is
       still sweeping in the background. */
    function renderSearchScope() {
        if (!el.searchScope) return;
        if (!state.searching) {
            el.searchScope.hidden = true;
            el.searchScope.textContent = "";
            return;
        }

        const sourceCount = Object.keys(
            (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {}
        ).length;

        el.searchScope.hidden = false;
        el.searchScope.innerHTML = state.searchPoolBuilt
            ? "Searching all <b>" + sourceCount + "</b> tabs"
            : "Searching all <b>" + sourceCount + "</b> tabs&hellip;";
    }

    /* Short tab name a channel belongs to, used for the source badge
       during a cross-tab search. Falls back to the group title. */
    function sourceLabel(ch) {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        const key = ch.sourceKey;
        if (key && map[key]) return map[key].label || key;
        return ch.group || "";
    }

    function renderList() {
        const frag = document.createDocumentFragment();

        /* Cap the rendered rows: a cross-tab search over ~10 playlists
           can match thousands of records, and the sidebar only ever
           shows a screenful. */
        const overflow = state.searching && state.filtered.length > MAX_SEARCH_RESULTS;
        const shown = overflow ? state.filtered.slice(0, MAX_SEARCH_RESULTS) : state.filtered;

        if (!state.channels.length && !state.searching) {
            frag.appendChild(messageLi(
                state.loading ? "Tuning\u2026" : "No channels loaded. Press RE-TUNE.",
                !state.loading
            ));
        } else if (!shown.length) {
            frag.appendChild(messageLi(
                state.searching
                    ? "Nothing matches that search in any tab."
                    : "Nothing matches that search.",
                false
            ));
        } else {
            shown.forEach((ch, i) => {
                const li = document.createElement("li");
                li.className = "channel-item";
                /* Highlight by identity, not index: a search reorders the
                   list and the playing channel must keep its mark. */
                if (state.current && sameChannel(state.current, ch)) li.classList.add("active");
                li.title = ch.name + (ch.group ? " \u2014 " + ch.group : "");
                li.dataset.index = String(i);

                const num = document.createElement("span");
                num.className = "num";
                num.textContent = String(i + 1).padStart(3, "0");

                const label = document.createElement("span");
                label.className = "label";
                label.textContent = ch.name;

                li.appendChild(num);
                li.appendChild(label);

                /* Badge only costs layout during a cross-tab search. */
                const src = sourceLabel(ch);
                if (state.searching && src && SEARCH_ALL_SOURCES) {
                    const badge = document.createElement("span");
                    badge.className = "src";
                    badge.textContent = src;
                    li.appendChild(badge);
                }

                frag.appendChild(li);
            });

            if (overflow) {
                frag.appendChild(messageLi(
                    "Showing first " + MAX_SEARCH_RESULTS + " of " +
                    state.filtered.length + " matches \u2014 keep typing to narrow.",
                    false
                ));
            }
        }

        el.list.replaceChildren(frag);

        const total = state.channels.length;

        if (state.searching) {
            const found = state.filtered.length;
            el.count.textContent = found + (found === 1 ? " match" : " matches") +
                (SEARCH_ALL_SOURCES ? " in all tabs" : " / " + total + " channels");
        } else if (!total) {
            el.count.textContent = "0 channels";
        } else {
            el.count.textContent = total + " channels";
        }
    }

    function messageLi(text, isError) {
        const li = document.createElement("li");
        li.className = "msg" + (isError ? " err" : "");
        li.textContent = text;
        return li;
    }

    function pageStatus() {
        const ch = state.channels[state.activeIndex];
        if (ch) status("now playing: " + ch.name);
    }

    /* Build the tab strip from channels.js. Runs once, then
       syncTabs() only toggles .active. Falls back to a static
       markup button if CHANNEL_SOURCES is unavailable. */
    function buildTabs() {
        if (typeof CHANNEL_SOURCES !== "object" || !CHANNEL_SOURCES) return;

        const keys = Object.keys(CHANNEL_SOURCES);
        const order = (typeof SOURCE_ORDER !== "undefined" && Array.isArray(SOURCE_ORDER))
            ? SOURCE_ORDER.filter(k => keys.includes(k))
            : [];
        const extra = keys.filter(k => !order.includes(k));
        const ordered = order.concat(extra);

        if (!ordered.length) return;

        /* Keep state.source pointing at a real key. */
        if (!CHANNEL_SOURCES[state.source]) {
            state.source = CHANNEL_SOURCES[DEFAULT_SOURCE]
                ? DEFAULT_SOURCE
                : ordered[0];
        }

        const frag = document.createDocumentFragment();

        ordered.forEach(key => {
            const source = CHANNEL_SOURCES[key];
            if (!source || !source.url) return;

            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "tab";
            tab.dataset.source = key;
            tab.textContent = source.label || key;
            tab.title = source.label || key;
            frag.appendChild(tab);
        });

        el.tabs.replaceChildren(frag);
    }

    function syncTabs() {
        el.tabs.querySelectorAll(".tab").forEach(tab => {
            tab.classList.toggle("active", tab.dataset.source === state.source);
        });
    }

    /* ---------------- Playback ---------------- */
    function destroyPlayer() {
        if (hls) {
            try { hls.destroy(); } catch (_) { /* ignore */ }
            hls = null;
        }
        try {
            el.video.pause();
            el.video.removeAttribute("src");
            el.video.load();
        } catch (_) { /* ignore */ }
    }

    function playAt(index) {
        if (index < 0 || index >= state.filtered.length) return;

        const ch = state.filtered[index];
        state.activeIndex = index;

        el.list.querySelectorAll("li").forEach(li => {
            li.classList.toggle("active", Number(li.dataset.index) === index);
        });

        el.nowName.textContent = ch.name.toUpperCase();
        setState("TUNING");
        setLed(false);
        showOverlay("TUNING\u2026", ch.name, true);

        destroyPlayer();
        el.video.muted = state.muteState;
        el.video.volume = 0.8;

        if (window.Hls && window.Hls.isSupported()) {
            hls = new window.Hls({
                lowLatencyMode: true,
                enableWorker: true,
                manifestLoadingTimeOut: 12000,
                manifestLoadingMaxRetry: 2
            });
            hls.loadSource(ch.url);
            hls.attachMedia(el.video);

            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                el.video.play().catch(() => { /* autoplay guard */ });
            });

            hls.on(window.Hls.Events.ERROR, (_evt, data) => {
                if (!data || !data.fatal) return;
                console.warn("hls fatal error:", data.type, data.details);
                setState("DEAD STREAM");
                setLed(false);
                showOverlay(
                    "NO SIGNAL",
                    "\u201C" + ch.name + "\u201D (" + data.details + ") is not responding. Try the next channel."
                );
            });
        } else if (el.video.canPlayType("application/vnd.apple.mpegurl")) {
            el.video.src = ch.url;
            el.video.play().catch(() => { /* autoplay guard */ });
        } else {
            showOverlay("UNSUPPORTED", "This browser cannot play HLS streams and hls.js failed to load.");
            setState("NO ENGINE");
        }

        pageStatus();
    }

    function nextChannel() {
        if (!state.filtered.length) return;
        playAt((state.activeIndex + 1) % state.filtered.length);
    }

    /* ---------------- Video events ---------------- */
    el.video.addEventListener("playing", () => {
        hideOverlay();
        setLed(true);
        setState("LIVE");
        pageStatus();
    });

    el.video.addEventListener("waiting", () => setState("BUFFERING"));
    el.video.addEventListener("stalled", () => setState("STALLED"));

    el.video.addEventListener("error", () => {
        if (hls) return; // hls.js reports its own errors
        setState("DEAD STREAM");
        setLed(false);
        showOverlay("NO SIGNAL", "This stream refused to play. Use NEXT to hop to another channel.");
    });

    /* ---------------- UI wiring ---------------- */
    el.tabs.addEventListener("click", (e) => {
        const tab = e.target.closest(".tab");
        if (!tab || tab.dataset.source === state.source) return;
        el.search.value = "";
        loadSource(tab.dataset.source);
    });

    let searchTimer = null;
    el.search.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilter, 120);
    });

    el.list.addEventListener("click", (e) => {
        const li = e.target.closest("li.channel-item");
        if (!li) return;
        playAt(Number(li.dataset.index));
    });

    el.reload.addEventListener("click", () => loadSource(state.source));
    el.next.addEventListener("click", nextChannel);

    el.volUp.addEventListener("click", () => {
        el.video.volume = Math.min(1, el.video.volume + 0.1);
        state.muteState = false;
        el.video.muted = false;
    });

    el.volDown.addEventListener("click", () => {
        el.video.volume = Math.max(0, el.video.volume - 0.1);
    });

    el.mute.addEventListener("click", () => {
        state.muteState = !state.muteState;
        el.video.muted = state.muteState;
        el.mute.textContent = state.muteState ? "UNMUTE" : "CHIME (MUTE)";
    });

    document.addEventListener("keydown", (e) => {
        if (e.target === el.search) return;
        if (e.key === "ArrowDown") { e.preventDefault(); nextChannel(); }
        if (e.key === " " && e.target === document.body) { e.preventDefault(); nextChannel(); }
    });

    window.addEventListener("beforeunload", destroyPlayer);

    /* Optional failover list for a future "retry" feature. */
    window.VINTAGE_FALLBACKS = (typeof SPORTS_FALLBACKS === "undefined") ? [] : SPORTS_FALLBACKS;

    /* ---------------- Boot ---------------- */
    buildTabs();
    syncTabs();
    renderList();
    showOverlay("AWAITING SIGNAL", "Pick a channel from the dial on the left.", false);
    loadSource(state.source);
})();
