/* ============================================================
   TV Dekho — player + category grid + Add M3U + dead-link scan
   ------------------------------------------------------------
   Layout contract (see index.html):
     player → volume +/-, Next → category picker + search
     → channel grid of the selected category.
   Menu (sidebar) only holds: theme, category list, settings.

   Multi-source: BOOT_SOURCES in channels.js is fetched in parallel,
   merged, de-duplicated by (bucket, url), and rendered as one pool.
   Sources tagged with `bucket` (Football, Cricket, Bangladesh) have
   their channels pinned to a single chip so the whole list is one
   tap away. Channels with no group-title are dropped.

   "All channels" is NOT shown as a chip. It still exists internally
   as a fallback so an empty category can never leave the user with a
   dead grid.

   Playlists are cached in localStorage for 6 hours. Second-and-later
   app opens are near-instant; the Reload button forces a fresh fetch.
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
        search: document.getElementById("search-input"),
        searchClear: document.getElementById("search-clear"),
        searchScope: document.getElementById("search-scope"),
        count: document.getElementById("count-line"),
        reload: document.getElementById("reload-btn"),
        scan: document.getElementById("scan-btn"),
        nowName: document.getElementById("now-name"),
        nowState: document.getElementById("now-state"),
        led: document.querySelector(".led"),
        volDown: document.getElementById("volume-down"),
        volUp: document.getElementById("volume-up"),
        mute: document.getElementById("mute-btn"),
        next: document.getElementById("next-btn"),
        themeBtn: document.getElementById("theme-btn"),

        // category pickers
        categorySelect: document.getElementById("category-select"),
        categoryChips: document.getElementById("category-chips"),
        sideCategories: document.getElementById("side-categories"),
        catReset: document.getElementById("cat-reset-btn"),
        browseTitle: document.getElementById("browse-title"),
        topbarTitle: document.getElementById("topbar-title"),

        // drawer
        sidebar: document.getElementById("sidebar"),
        scrim: document.getElementById("scrim"),
        menuBtn: document.getElementById("menu-btn"),

        // grid
        channelGrid: document.getElementById("channel-grid"),

        // add m3u
        addBtn: document.getElementById("add-m3u-btn"),
        modal: document.getElementById("m3u-modal"),
        closeBtn: document.getElementById("m3u-close"),
        cancelBtn: document.getElementById("m3u-cancel"),
        form: document.getElementById("m3u-form"),
        fName: document.getElementById("m3u-name"),
        fUrl: document.getElementById("m3u-url"),
        fLimit: document.getElementById("m3u-limit"),
        fSports: document.getElementById("m3u-sports"),
        fMatch: document.getElementById("m3u-match"),
        fError: document.getElementById("m3u-error"),
        savedWrap: document.getElementById("saved-wrap"),
        savedList: document.getElementById("custom-list")
    };

    if (!el.video) return;

    /* ---------------- Constants ---------------- */
    const THEME_KEY  = "streamly-theme";
    const CUSTOM_KEY = "streamly-custom-sources";
    const CAT_KEY    = "streamly-category";

    const ALL_VALUE    = "__all__";
    const SEARCH_VALUE = "__search__";
    const UNGROUPED    = "Uncategorised";

    const MAX_RESULTS =
        typeof SEARCH_RESULT_LIMIT === "number" ? SEARCH_RESULT_LIMIT : 500;
    const SCAN_LIMIT =
        typeof SCAN_CONCURRENCY === "number" ? SCAN_CONCURRENCY : 12;
    const SCAN_TIMEOUT =
        typeof SCAN_TIMEOUT_MS === "number" ? SCAN_TIMEOUT_MS : 3000;

    /* Playlist text cache. sports.m3u is ~600 KB — re-fetching it on
       every open would make the app feel slow. Cache for 6 hours and
       refresh silently in the background. */
    const CACHE_PREFIX = "streamly-pl-cache-v1:";
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

    /* ---------------- State ---------------- */
    const state = {
        source:  typeof DEFAULT_SOURCE === "string" ? DEFAULT_SOURCE : ALL_VALUE,
        sources: [],

        pool: [],
        categoryChannels: [],
        searched: [],
        visible: [],

        categories: [],
        chipValues: [],
        categoryCounts: new Map(),

        leafKeys: new Map(),
        groupings: [],

        activeCategory: ALL_VALUE,

        search: "",
        activeIndex: -1,
        current: null,
        loading: false,
        muteState: false,
        deadUrls: new Set(),
        scanning: false,
        truncated: false
    };

    let hls = null;
    let searchTimer = null;

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

    function setLed(on) { if (el.led) el.led.classList.toggle("on", !!on); }
    function setState(text) { el.nowState.textContent = text; }

    function attr(infoLine, name) {
        const m = infoLine.match(new RegExp(name + '="([^"]*)"'));
        return m ? m[1].trim() : "";
    }

    function decode(text) {
        return String(text || "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
    }

    function cleanName(raw) {
        let name = decode(raw).replace(/\s+/g, " ").trim();
        name = name.replace(/\s*\((?:\d{3,4}p)\)\s*$/i, "");
        return name || "Unknown Channel";
    }

    function looksLikeStream(line) {
        if (!line || line.startsWith("#")) return false;
        if (/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(line)) return true;
        return STREAM_EXTENSIONS.some(ext => line.toLowerCase().split("?")[0].endsWith(ext));
    }

    function isSports(group) {
        return /(^|;)\s*sports?\s*(;|$)/i.test(group || "");
    }

    function sameChannel(a, b) {
        if (!a || !b) return false;
        if (a.url && b.url) return a.url === b.url;
        return a.name === b.name && (a.group || "") === (b.group || "");
    }

    function firstUnquotedComma(line) {
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') inQuotes = !inQuotes;
            else if (c === "," && !inQuotes) return i;
        }
        return -1;
    }

    function matchesKeywords(ch, keywords) {
        if (!keywords || !keywords.length) return true;
        const haystack = ((ch.name || "") + " " + (ch.group || "")).toLowerCase();
        return keywords.some(kw => haystack.includes(kw));
    }

    /* ---------------- Playlist cache ---------------- */
    function readPlaylistCache(url) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + url);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || typeof obj.text !== "string") return null;
            if (Date.now() - (obj.ts || 0) > CACHE_TTL_MS) return null;
            return obj.text;
        } catch (_) { return null; }
    }

    function writePlaylistCache(url, text) {
        try {
            localStorage.setItem(CACHE_PREFIX + url,
                JSON.stringify({ ts: Date.now(), text }));
        } catch (_) {
            /* Quota exceeded — drop the oldest half and retry once. */
            try {
                const keys = Object.keys(localStorage)
                    .filter(k => k.startsWith(CACHE_PREFIX));
                keys.slice(0, Math.ceil(keys.length / 2))
                    .forEach(k => localStorage.removeItem(k));
                localStorage.setItem(CACHE_PREFIX + url,
                    JSON.stringify({ ts: Date.now(), text }));
            } catch (_) { /* give up silently */ }
        }
    }

    /* ---------------- Config from channels.js ----------------
       channels.js is a classic <script>, so its top-level `const`s live
       in that script's lexical scope. These lookups resolve the binding
       through the global lexical environment. */
    const GLOBAL_SCOPE = (() => {
        if (typeof globalThis !== "undefined" && typeof globalThis === "object") {
            return globalThis;
        }
        return this;
    })();

    function readGlobal(name, fallback) {
        const expr = "(typeof " + name + " === \"undefined\") ? undefined : (" + name + ")";
        try {
            if (GLOBAL_SCOPE && typeof GLOBAL_SCOPE.eval === "function") {
                const value = GLOBAL_SCOPE.eval(expr);
                if (value !== undefined) return value;
            }
        } catch (_) { /* fall through */ }

        try {
            const value = GLOBAL_SCOPE && GLOBAL_SCOPE[name];
            return value === undefined ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    const SEARCH_EVERYTHING  = !!readGlobal("SEARCH_ALL_TABS", true);
    const COLLAPSED          = readGlobal("COLLAPSED_CATEGORIES", []);
    const HIDDEN_CATEGORIES  = readGlobal("HIDE_CATEGORIES", []);
    const BOOT_KEYS          = readGlobal("BOOT_SOURCES", []);
    const CHIP_PRIORITY_LIST = readGlobal("CHIP_PRIORITY", []);

    function hiddenCategoryNames() {
        const hide = Array.isArray(HIDDEN_CATEGORIES) ? HIDDEN_CATEGORIES : [];
        return new Set(hide.map(h => String(h).toLowerCase()));
    }

    /* Category spans a hierarchy inside group-title, e.g.
         "Sports;Football" -> { parent: "Sports", leaf: "Football" }
         "Sports"          -> { parent: "Sports", leaf: "Sports"   } */
    function classify(ch) {
        const raw = String(ch && ch.group ? ch.group : "").trim();
        if (!raw) return { parent: UNGROUPED, leaf: UNGROUPED };

        const segs = raw.split(";").map(s => s.trim()).filter(Boolean);
        if (!segs.length) return { parent: UNGROUPED, leaf: UNGROUPED };
        if (segs.length === 1) return { parent: segs[0], leaf: segs[0] };
        return { parent: segs[0], leaf: segs[segs.length - 1] };
    }

    /* Broad bucket for a leaf, from COLLAPSED_CATEGORIES. */
    function bucketFor(leaf) {
        const rules = Array.isArray(COLLAPSED) ? COLLAPSED : [];
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!rule || !rule.name || !rule.match) continue;
            const name = String(rule.name);
            const hit = rule.match.some(m =>
                String(m).toLowerCase() === String(leaf).toLowerCase());
            if (hit) return name;
        }
        return leaf;
    }

    /* Which channel keys a category chip stands for. */
    function keysForCategory(value) {
        if (value === ALL_VALUE || value === SEARCH_VALUE) return null;

        const keys = new Set([value]);
        const isChip = state.chipValues.indexOf(value) !== -1;

        state.leafKeys.forEach((info, key) => {
            if (isChip) {
                if (info.bucket === value) keys.add(key);
            } else {
                if (info.parent === value) keys.add(key);
            }
        });

        return keys;
    }

    function channelCategoryKey(ch) {
        return ch.leafKey || UNGROUPED;
    }

    function countOf(categoryName) {
        if (categoryName === ALL_VALUE) return state.pool.length;
        if (categoryName === SEARCH_VALUE) return state.searched.length;
        const counts = state.categoryCounts;
        return (counts && counts.get(categoryName)) || 0;
    }

    function channelsFor(categoryName) {
        if (categoryName === ALL_VALUE) return state.pool.slice();
        if (categoryName === SEARCH_VALUE) return state.searched.slice();

        const keys = keysForCategory(categoryName);
        if (!keys || !keys.size) return [];
        return state.pool.filter(ch => keys.has(channelCategoryKey(ch)));
    }

    /* Stamp every channel with its derived category once per load.
       A source's `bucket` (channels.js) overrides the per-group roll-up
       so a whole playlist can be pinned to one chip. */
    function indexCategories() {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        state.pool.forEach(ch => {
            const cls = classify(ch);
            const src = map[ch.sourceKey] || {};
            const forced = (src && src.bucket) || "";
            ch.category    = cls.parent;
            ch.leaf        = cls.leaf;
            ch.subCategory = cls.leaf;
            ch.leafKey     = forced || bucketFor(cls.leaf);
        });
    }

    function categoryOf(ch) {
        return (ch && ch.category) || UNGROUPED;
    }

    /* ---------------- Theme ---------------- */
    function currentTheme() {
        const set = document.documentElement.getAttribute("data-theme");
        return set === "light" ? "light" : "dark";
    }

    function applyTheme(theme, persist) {
        const next = theme === "light" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);

        const meta = document.getElementById("meta-theme-color");
        if (meta) meta.setAttribute("content", next === "light" ? "#f2f4f9" : "#0a0c10");

        if (persist) {
            try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private */ }
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

        if (window.matchMedia) {
            const mq = window.matchMedia("(prefers-color-scheme: light)");
            const onSystemChange = (e) => {
                let stored = null;
                try { stored = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
                if (stored === "light" || stored === "dark") return;
                applyTheme(e.matches ? "light" : "dark", false);
            };
            if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
            else if (mq.addListener) mq.addListener(onSystemChange);
        }
    }

    /* ---------------- Custom sources (Add M3U) ---------------- */
    function loadCustomSources() {
        try {
            const raw = localStorage.getItem(CUSTOM_KEY);
            if (!raw) return {};
            const data = JSON.parse(raw);
            return (data && typeof data === "object") ? data : {};
        } catch (_) {
            return {};
        }
    }

    function saveCustomSources(sources) {
        try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(sources)); } catch (_) { /* quota */ }
    }

    function refreshSources() {
        const custom = loadCustomSources();
        Object.keys(custom).forEach(k => {
            const s = custom[k];
            if (!s || !s.url) return;
            s.custom = true;
            CHANNEL_SOURCES[k] = s;
        });
    }

    function openM3uModal() {
        if (!el.modal || !el.form) return;
        el.modal.hidden = false;
        if (el.fError) el.fError.textContent = "";
        el.form.reset();
        if (el.fLimit) el.fLimit.value = "300";
        renderSavedList();
        setTimeout(() => { if (el.fName) el.fName.focus(); }, 30);
    }

    function closeM3uModal() {
        if (el.modal) el.modal.hidden = true;
    }

    function renderSavedList() {
        const custom = loadCustomSources();
        const keys = Object.keys(custom);
        if (!keys.length) {
            el.savedWrap.hidden = true;
            el.savedList.replaceChildren();
            return;
        }

        const frag = document.createDocumentFragment();
        keys.forEach(key => {
            const src = custom[key];
            const li = document.createElement("li");

            const name = document.createElement("span");
            name.textContent = src.label || key;

            const del = document.createElement("button");
            del.type = "button";
            del.className = "del-btn";
            del.textContent = "Remove";
            del.dataset.key = key;

            li.appendChild(name);
            li.appendChild(del);
            frag.appendChild(li);
        });

        el.savedList.replaceChildren(frag);
        el.savedWrap.hidden = false;
    }

    function removeCustomSource(key) {
        const custom = loadCustomSources();
        delete custom[key];
        saveCustomSources(custom);
        delete CHANNEL_SOURCES[key];

        renderSavedList();

        if (state.sources.indexOf(key) !== -1) {
            const next = state.sources.filter(k => k !== key);
            if (next.length) {
                loadPlaylists(next, { force: true });
            } else {
                const fallback = firstUsableSource();
                if (fallback) loadPlaylists([fallback], { force: true });
            }
        }
    }

    function handleM3uSubmit(e) {
        e.preventDefault();

        const name = (el.fName.value || "").trim();
        const url = (el.fUrl.value || "").trim();
        const limitRaw = parseInt(el.fLimit.value, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;

        if (!name) { el.fError.textContent = "Please give this playlist a name."; return; }
        if (!url) { el.fError.textContent = "Please paste a playlist URL."; return; }
        if (!/^https?:\/\//i.test(url)) { el.fError.textContent = "URL must start with http:// or https://"; return; }

        const match = (el.fMatch.value || "")
            .split(",")
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        const key = "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        const source = {
            label: name,
            url: url,
            limit: limit,
            custom: true,
            /* Custom playlists get their own chip unless a match filter
               is set, so their channels are one tap away. */
            bucket: match.length ? "" : name
        };
        if (el.fSports.checked) source.onlySports = true;
        if (match.length) source.match = match;

        const custom = loadCustomSources();
        custom[key] = source;
        saveCustomSources(custom);
        refreshSources();

        closeM3uModal();
        state.activeCategory = ALL_VALUE;
        loadPlaylists([key], { force: true });
    }

    /* ---------------- M3U parser ---------------- */
    function parseM3U(text) {
        const lines = String(text).replace(/\r/g, "").split("\n");
        const channels = [];
        let pending = null;

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw) continue;

            if (raw.startsWith("#EXTINF:")) {
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

            if (raw.startsWith("#")) continue;

            if (pending && looksLikeStream(raw)) {
                pending.url = raw;
                channels.push(pending);
                pending = null;
            }
        }

        return channels;
    }

    /* ---------------- Fetch a single playlist (cached) ---------------- */
    async function fetchPlaylist(sourceKey, opts) {
        const force = !!(opts && opts.force);
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        const source = map[sourceKey];
        if (!source || !source.url) return [];

        let textRes = force ? null : readPlaylistCache(source.url);

        if (textRes === null) {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                typeof PLAYLIST_TIMEOUT_MS === "number" ? PLAYLIST_TIMEOUT_MS : 20000
            );
            try {
                const res = await fetch(source.url, {
                    signal: controller.signal,
                    cache: "no-store"
                });
                if (!res.ok) throw new Error("HTTP " + res.status);
                textRes = await res.text();
                writePlaylistCache(source.url, textRes);
            } finally {
                clearTimeout(timer);
            }
        } else {
            /* Cache hit — refresh silently for next open. */
            fetch(source.url, { cache: "no-store" })
                .then(r => r.ok ? r.text() : null)
                .then(t => { if (t) writePlaylistCache(source.url, t); })
                .catch(() => { /* offline is fine, cache is fresh */ });
        }

        let parsed = parseM3U(textRes);

        if (source.onlySports) {
            const only = parsed.filter(ch => isSports(ch.group));
            if (only.length) parsed = only;
        }
        if (Array.isArray(source.match) && source.match.length) {
            const matched = parsed.filter(ch => matchesKeywords(ch, source.match));
            if (matched.length) parsed = matched;
        }
        if (source.limit > 0 && parsed.length > source.limit) {
            parsed = parsed.slice(0, source.limit);
        }

        parsed.forEach(ch => { ch.sourceKey = sourceKey; });
        return parsed;
    }

    /* ---------------- Load + merge multiple playlists ----------------
       Sources are fetched in parallel, merged, then de-duplicated by
       (bucket, url). Same URL under Football AND Sports is intentional
       — the user should find it in both. Only true duplicates inside
       one bucket collapse. Channels with no group-title are dropped. */
    async function loadPlaylists(sourceKeys, opts) {
        if (state.loading) return;

        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};

        let keys = Array.isArray(sourceKeys) ? sourceKeys.filter(Boolean) : [];
        if (!keys.length) keys = state.sources.length ? state.sources.slice() : [state.source];
        keys = keys.filter(k => map[k] && map[k].url);

        if (!keys.length) {
            showOverlay("NO PLAYLIST", "channels.js did not define any usable source.");
            status("playlist config missing", true);
            return;
        }

        state.loading = true;
        state.sources = keys.slice();
        state.source  = keys[0];

        state.pool = [];
        state.categoryChannels = [];
        state.searched = [];
        state.visible = [];
        state.categories = [];
        state.chipValues = [];
        state.leafKeys = new Map();
        state.groupings = [];
        state.categoryCounts = new Map();
        state.activeCategory = ALL_VALUE;
        state.activeIndex = -1;
        renderCategories();
        renderGrid();

        el.nowName.textContent = "NO CHANNEL";
        setLed(false);
        setState("LOADING");
        status("tuning " + keys.length + (keys.length === 1 ? " playlist\u2026" : " playlists\u2026"));
        showOverlay(
            "TUNING\u2026",
            "Fetching " + keys.length + (keys.length === 1 ? " playlist" : " playlists") +
                " from the aerial.",
            true
        );

        const results = await Promise.all(keys.map(async (k) => {
            try {
                return { key: k, list: await fetchPlaylist(k, opts), ok: true };
            } catch (err) {
                console.error("playlist failed:", k, err);
                return { key: k, list: [], ok: false, err };
            }
        }));

        let merged = [];
        let anyOk = false;
        let lastErr = null;
        results.forEach(r => {
            if (r.ok) anyOk = true;
            if (r.err) lastErr = r.err;
            merged = merged.concat(r.list);
        });

        /* Drop channels with no usable group-title. */
        merged = merged.filter(ch => {
            const g = (ch.group || "").trim();
            if (!g) return false;
            if (/^undefined$/i.test(g)) return false;
            return true;
        });

        /* Stamp categories first, then dedup on (bucket, url). */
        state.pool = merged;
        indexCategories();

        const seenKey = new Set();
        state.pool = state.pool.filter(ch => {
            if (!ch.url) return false;
            const key = (ch.leafKey || "") + "|" + ch.url;
            if (seenKey.has(key)) return false;
            seenKey.add(key);
            return true;
        });

        if (state.deadUrls.size) {
            const live = new Set(state.pool.map(c => c.url));
            state.deadUrls.forEach(u => { if (!live.has(u)) state.deadUrls.delete(u); });
        }

        state.loading = false;

        if (!state.pool.length) {
            buildCategories();
            renderCategories();
            renderGrid();
            updateCount();
            showOverlay(
                "NO CHANNELS",
                anyOk
                    ? "The playlists loaded but contained no playable links."
                    : "Could not reach any playlist. Check your connection and RE-TUNE."
            );
            status(anyOk ? "playlist empty" : "playlist failed", true);
            setState("NO SIGNAL");
            return;
        }

        buildCategories();
        restoreCategory();
        applyFilter();

        status(state.pool.length + " channels \u00B7 " + state.chipValues.length + " categories");
        showOverlay(
            "SIGNAL FOUND",
            state.pool.length + " channels \u2014 pick a category, then a channel.",
            false
        );
        setState("STANDBY");

        if (lastErr && !anyOk) console.error(lastErr);
    }

    /* Kept for flows that only touch one source. */
    function loadSource(sourceKey) {
        if (sourceKey) return loadPlaylists([sourceKey]);
        return loadPlaylists(state.sources.length ? state.sources.slice() : [state.source]);
    }

    /* ---------------- Categories ---------------- */
    function buildCategories() {
        const counts  = new Map();
        const leaves  = new Map();
        const parents = new Map();
        const hidden  = hiddenCategoryNames();

        state.pool.forEach(ch => {
            const key = channelCategoryKey(ch);
            counts.set(key, (counts.get(key) || 0) + 1);
            if (!leaves.has(key)) {
                leaves.set(key, { parent: ch.category || UNGROUPED, bucket: key });
            }
            const parent = ch.category || UNGROUPED;
            parents.set(parent, (parents.get(parent) || 0) + 1);
        });

        state.categoryCounts = counts;
        state.leafKeys = leaves;

        const groupings = [];
        parents.forEach((_n, parent) => {
            if (!leaves.has(parent) && !hidden.has(parent.toLowerCase())) {
                groupings.push(parent);
            }
        });
        groupings.sort((a, b) => {
            const ca = (parents.get(a) || 0);
            const cb = (parents.get(b) || 0);
            return cb - ca || a.localeCompare(b);
        });
        state.groupings = groupings;

        const chips = [];
        const seen = new Set();

        const addChip = (value) => {
            if (!value || value === ALL_VALUE || seen.has(value)) return;
            if (hidden.has(String(value).toLowerCase())) return;
            if (!counts.has(value)) return;
            seen.add(value);
            chips.push(value);
        };

        (Array.isArray(CHIP_PRIORITY_LIST) ? CHIP_PRIORITY_LIST : []).forEach(addChip);

        (Array.isArray(COLLAPSED) ? COLLAPSED : []).forEach(r => {
            if (r && r.name) addChip(r.name);
        });

        groupings.forEach(addChip);
        leaves.forEach((_info, key) => addChip(key));

        state.chipValues = chips;
        state.categories = chips;
    }

    function sourceLabelOf(key) {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        const src = map[key];
        return (src && src.label) || key || "";
    }

    /* "All" is not offered to the user — only real chips. */
    function categoryOptions() {
        return state.categories.slice();
    }

    function categoryLabel(value) {
        if (value === ALL_VALUE)    return "All channels";
        if (value === SEARCH_VALUE) return "Search results";
        return value;
    }

    function restoreCategory() {
        const names = state.categories;

        let stored = null;
        try { stored = localStorage.getItem(CAT_KEY); } catch (_) { /* ignore */ }

        if (stored && stored !== ALL_VALUE && names.includes(stored)) {
            state.activeCategory = stored;
        } else if (names.length) {
            /* First chip — never "All". */
            state.activeCategory = names[0];
        } else {
            state.activeCategory = ALL_VALUE;    /* empty pool fallback only */
        }

        state.categoryChannels = channelsFor(state.activeCategory);
    }

    function setCategory(value) {
        const target = value || ALL_VALUE;

        state.activeCategory = (target === ALL_VALUE || state.categories.includes(target))
            ? target
            : (state.categories[0] || ALL_VALUE);

        try { localStorage.setItem(CAT_KEY, state.activeCategory); } catch (_) { /* ignore */ }

        state.categoryChannels = channelsFor(state.activeCategory);
        state.activeIndex = -1;
        closeDrawer();
        renderCategories();
        renderGrid();
    }

    /* ---------------- Rendering: category pickers ---------------- */
    function renderCategories() {
        renderCategorySelect();
        renderCategoryChips();
        renderSideCategories();
        renderBrowseTitle();
    }

    function renderCategorySelect() {
        if (!el.categorySelect) return;

        const values = categoryOptions();
        const frag = document.createDocumentFragment();

        values.forEach(value => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = value + " (" + countOf(value) + ")";
            frag.appendChild(opt);
        });

        el.categorySelect.replaceChildren(frag);

        const active = state.activeCategory;
        if (active !== ALL_VALUE && !values.includes(active)) {
            const row = state.groupings.find(name =>
                state.leafKeys.get(active) && state.leafKeys.get(active).parent === name);
            el.categorySelect.value = values.includes(row)
                ? row
                : (values[0] || "");
        } else {
            el.categorySelect.value = active;
        }
    }

    function renderCategoryChips() {
        if (!el.categoryChips) return;

        const values = state.categories.slice();   /* no "All" chip */
        const frag = document.createDocumentFragment();

        values.forEach(value => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "cat-chip";
            chip.dataset.category = value;
            chip.setAttribute("role", "tab");
            const active = value === state.activeCategory;
            chip.classList.toggle("active", active);
            chip.classList.toggle("contains", !active && isRowActive(value));
            chip.setAttribute("aria-selected", active ? "true" : "false");
            chip.title = categoryLabel(value);

            const label = document.createElement("span");
            label.className = "cat-chip__label";
            label.textContent = categoryLabel(value);

            const badge = document.createElement("span");
            badge.className = "cat-chip__count";
            badge.textContent = String(countOf(value));

            chip.appendChild(label);
            chip.appendChild(badge);
            frag.appendChild(chip);
        });

        el.categoryChips.replaceChildren(frag);
    }

    function isRowActive(value) {
        if (value === state.activeCategory) return true;
        if (value === ALL_VALUE || value === SEARCH_VALUE) return false;

        const act = state.activeCategory;
        if (act === ALL_VALUE || act === SEARCH_VALUE) return false;

        const info = state.leafKeys.get(act);
        return !!(info && info.parent === value && value !== act);
    }

    function renderSideCategories() {
        if (!el.sideCategories) return;

        const values = state.categories.slice();   /* no "All" row */
        const frag = document.createDocumentFragment();

        values.forEach(value => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "side-cat";
            item.dataset.category = value;
            const active = value === state.activeCategory;
            item.classList.toggle("active", active);
            item.classList.toggle("contains", !active && isRowActive(value));

            const label = document.createElement("span");
            label.className = "side-cat__label";
            label.textContent = categoryLabel(value);

            const badge = document.createElement("span");
            badge.className = "side-cat__count";
            badge.textContent = String(countOf(value));

            item.appendChild(label);
            item.appendChild(badge);
            frag.appendChild(item);
        });

        if (!values.length) {
            const empty = document.createElement("p");
            empty.className = "side-cat--empty";
            empty.textContent = "No categories yet.";
            frag.appendChild(empty);
        }

        el.sideCategories.replaceChildren(frag);
    }

    function renderBrowseTitle() {
        if (!el.browseTitle) return;

        const q = state.search;
        const shown = state.visible.length;
        const total = state.categoryChannels.length;

        if (q) {
            el.browseTitle.textContent = shown + (shown === 1 ? " result" : " results") +
                " for \u201C" + q + "\u201D";
        } else if (state.activeCategory === ALL_VALUE) {
            el.browseTitle.textContent = "All channels \u00B7 " + total;
        } else {
            el.browseTitle.textContent = state.activeCategory + " \u00B7 " + total +
                (total === 1 ? " channel" : " channels");
        }

        if (el.topbarTitle) {
            el.topbarTitle.textContent = state.activeCategory === ALL_VALUE
                ? "Live Channels"
                : state.activeCategory;
        }

        if (el.searchScope) {
            el.searchScope.hidden = !q;
            if (q && state.searched.length) {
                el.searchScope.textContent =
                    "across all " + state.pool.length + " loaded channels";
            } else {
                el.searchScope.textContent = q
                    ? "in " + categoryLabel(state.activeCategory) +
                      " \u00B7 " + state.pool.length + " loaded"
                    : "";
            }
        }

        if (el.searchClear) el.searchClear.hidden = !q;
    }

    /* ---------------- Filtering ---------------- */
    function applyFilter() {
        const q = String(el.search.value || "").trim().toLowerCase();
        const queryChanged = q !== state.search;
        state.search = q;

        const base = state.activeCategory === ALL_VALUE
            ? state.pool
            : state.categoryChannels;

        const matchIn = (list) => list.filter(ch =>
            (ch.name || "").toLowerCase().includes(q) ||
            (ch.group || "").toLowerCase().includes(q)
        );

        state.searched = [];

        if (!q) {
            state.visible = base.slice();
        } else {
            state.visible = matchIn(base);

            if (!state.visible.length && SEARCH_EVERYTHING) {
                const everywhere = matchIn(state.pool);
                if (everywhere.length) {
                    state.visible = everywhere;
                    state.searched = everywhere;
                    state.activeCategory = SEARCH_VALUE;
                }
            }

            if (!state.categories.includes(state.activeCategory) &&
                state.activeCategory !== ALL_VALUE &&
                state.activeCategory !== SEARCH_VALUE) {
                if (!queryChanged) {
                    state.activeCategory = state.categories[0] || ALL_VALUE;
                }
            }
        }

        if (state.visible.length > MAX_RESULTS) {
            state.visible = state.visible.slice(0, MAX_RESULTS);
            state.truncated = true;
        } else {
            state.truncated = false;
        }

        state.categoryChannels = channelsFor(state.activeCategory);
        renderCategories();
        renderGrid();
        updateCount();
    }

    function updateCount() {
        if (!el.count) return;

        const total = state.pool.length;
        const deadCount = state.deadUrls.size;
        const shown = state.visible.length;

        if (state.search) {
            el.count.textContent = shown + (shown === 1 ? " match" : " matches") + " / " + total;
        } else if (!total) {
            el.count.textContent = "0 channels";
        } else if (shown !== total) {
            el.count.textContent = shown + " of " + total + " channels";
        } else if (deadCount) {
            el.count.textContent = total + " channels \u00B7 " + deadCount + " dead";
        } else {
            el.count.textContent = total + " channels";
        }
    }

    /* ---------------- Grid ---------------- */
    function gridMessage(title, sub) {
        const card = document.createElement("div");
        card.className = "grid-card grid-card--empty";

        const name = document.createElement("div");
        name.className = "grid-card__name";
        name.textContent = title;
        card.appendChild(name);

        if (sub) {
            const meta = document.createElement("div");
            meta.className = "grid-card__meta";
            const span = document.createElement("span");
            span.textContent = sub;
            meta.appendChild(span);
            card.appendChild(meta);
        }

        return card;
    }

    function renderGrid() {
        if (!el.channelGrid) return;

        const frag = document.createDocumentFragment();

        if (state.loading && !state.visible.length) {
            frag.appendChild(gridMessage("Tuning\u2026", "Fetching the playlists."));
        } else if (!state.visible.length) {
            if (state.search) {
                frag.appendChild(gridMessage(
                    "No matches",
                    "Nothing in " + categoryLabel(state.activeCategory) +
                        " matches \u201C" + state.search + "\u201D."
                ));
            } else if (!state.pool.length) {
                frag.appendChild(gridMessage("No channels", "Press Reload to tune again."));
            } else {
                frag.appendChild(gridMessage("Nothing here", "Pick another category."));
            }
        } else {
            state.visible.forEach((ch, i) => {
                const card = document.createElement("button");
                card.type = "button";
                card.className = "grid-card";
                if (state.current && sameChannel(state.current, ch)) card.classList.add("active");
                if (state.deadUrls.has(ch.url)) card.classList.add("dead");
                card.dataset.index = String(i);
                card.title = ch.name + (ch.group ? " \u2014 " + ch.group : "");

                const name = document.createElement("div");
                name.className = "grid-card__name";
                name.textContent = ch.name;

                const meta = document.createElement("div");
                meta.className = "grid-card__meta";

                const group = document.createElement("span");
                group.className = "grid-card__group";
                if (state.activeCategory === ALL_VALUE) {
                    group.textContent = ch.subCategory || categoryOf(ch);
                } else if (state.activeCategory === SEARCH_VALUE) {
                    group.textContent = (ch.subCategory || categoryOf(ch)) +
                        (ch.group ? " \u00B7 " + ch.group : "");
                } else if (isRowActive(state.activeCategory) && ch.subCategory &&
                           ch.subCategory !== state.activeCategory) {
                    group.textContent = ch.subCategory;
                } else {
                    group.textContent = "";
                }

                const num = document.createElement("span");
                num.className = "grid-card__num";
                num.textContent = String(i + 1).padStart(3, "0");

                meta.appendChild(group);
                meta.appendChild(num);
                card.appendChild(name);
                card.appendChild(meta);
                frag.appendChild(card);
            });

            if (state.truncated) {
                frag.appendChild(gridMessage(
                    "Showing first " + MAX_RESULTS,
                    "Use search to narrow the list."
                ));
            }
        }

        el.channelGrid.replaceChildren(frag);
    }

    /* ---------------- Dead-link scanner ---------------- */
    function probeStream(url, timeoutMs) {
        return new Promise((resolve) => {
            const controller = new AbortController();
            const timer = setTimeout(() => {
                try { controller.abort(); } catch (_) { /* ignore */ }
                resolve(false);
            }, timeoutMs);

            fetch(url, {
                method: "GET",
                mode: "no-cors",
                signal: controller.signal,
                cache: "no-store",
                redirect: "follow",
                credentials: "omit"
            }).then(() => {
                clearTimeout(timer);
                resolve(true);
            }).catch(() => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    }

    async function scanCurrentSource() {
        if (state.scanning) return;
        if (!state.pool.length) {
            status("nothing to scan", true);
            return;
        }

        state.scanning = true;
        el.scan.disabled = true;

        const queue = state.pool.slice();
        const total = queue.length;
        let done = 0;
        let dead = 0;

        setState("SCANNING");
        status("scanning 0 / " + total + " \u2026");

        const worker = async () => {
            while (queue.length) {
                const ch = queue.shift();
                if (!ch) break;
                const ok = await probeStream(ch.url, SCAN_TIMEOUT);
                done++;
                if (!ok) {
                    dead++;
                    state.deadUrls.add(ch.url);
                }
                if (done % 5 === 0 || done === total) {
                    status("scanning " + done + " / " + total + " \u00B7 " + dead + " dead");
                }
            }
        };

        const workers = Array.from({ length: Math.min(SCAN_LIMIT, total) }, worker);
        await Promise.all(workers);

        state.scanning = false;
        el.scan.disabled = false;
        setState(state.pool.length ? "STANDBY" : "NO SIGNAL");

        renderGrid();
        updateCount();

        if (dead) {
            status(dead + " dead of " + total + " \u2014 dimmed in the grid");
        } else {
            status(total + " streams look alive");
        }
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
        if (index < 0 || index >= state.visible.length) return;

        const ch = state.visible[index];
        state.activeIndex = index;
        state.current = ch;

        if (el.channelGrid) {
            el.channelGrid.querySelectorAll(".grid-card").forEach(card => {
                card.classList.toggle("active", Number(card.dataset.index) === index);
            });
        }

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
                    "\u201C" + ch.name + "\u201D (" + data.details +
                        ") is not responding. Try the next channel."
                );
                state.deadUrls.add(ch.url);
                markDeadUi();
            });
        } else if (el.video.canPlayType("application/vnd.apple.mpegurl")) {
            el.video.src = ch.url;
            el.video.play().catch(() => { /* autoplay guard */ });
        } else {
            showOverlay("UNSUPPORTED",
                "This browser cannot play HLS streams and hls.js failed to load.");
            setState("NO ENGINE");
        }

        status("now playing: " + ch.name);
    }

    function markDeadUi() {
        if (el.channelGrid) {
            const card = el.channelGrid.querySelector(
                '.grid-card[data-index="' + state.activeIndex + '"]');
            if (card) card.classList.add("dead");
        }
        updateCount();
    }

    function nextChannel() {
        if (!state.visible.length) return;
        playAt((state.activeIndex + 1) % state.visible.length);
    }

    /* ---------------- Drawer (mobile) ---------------- */
    function openDrawer() {
        if (!el.sidebar) return;
        el.sidebar.classList.add("open");
        if (el.scrim) el.scrim.hidden = false;
        document.body.classList.add("drawer-open");
    }

    function closeDrawer() {
        if (!el.sidebar) return;
        el.sidebar.classList.remove("open");
        if (el.scrim) el.scrim.hidden = true;
        document.body.classList.remove("drawer-open");
    }

    /* ---------------- Video events ---------------- */
    el.video.addEventListener("playing", () => {
        hideOverlay();
        setLed(true);
        setState("LIVE");
    });

    el.video.addEventListener("waiting", () => setState("BUFFERING"));
    el.video.addEventListener("stalled", () => setState("STALLED"));

    el.video.addEventListener("error", () => {
        if (hls) return;
        setState("DEAD STREAM");
        setLed(false);
        showOverlay("NO SIGNAL",
            "This stream refused to play. Use NEXT to hop to another channel.");
    });

    /* ---------------- UI wiring ---------------- */
    if (el.categorySelect) {
        el.categorySelect.addEventListener("change", () => {
            el.search.value = "";
            state.search = "";
            setCategory(el.categorySelect.value);
            applyFilter();
        });
    }

    if (el.categoryChips) {
        el.categoryChips.addEventListener("click", (e) => {
            const chip = e.target.closest(".cat-chip");
            if (!chip) return;
            el.search.value = "";
            state.search = "";
            setCategory(chip.dataset.category);
            applyFilter();
        });
    }

    if (el.sideCategories) {
        el.sideCategories.addEventListener("click", (e) => {
            const item = e.target.closest(".side-cat");
            if (!item) return;
            el.search.value = "";
            state.search = "";
            setCategory(item.dataset.category);
            applyFilter();
        });
    }

    if (el.catReset) {
        el.catReset.addEventListener("click", () => {
            el.search.value = "";
            state.search = "";
            const first = state.categories[0] || ALL_VALUE;
            setCategory(first);
            applyFilter();
        });
    }

    if (el.search) {
        el.search.addEventListener("input", () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(applyFilter, 120);
        });
    }

    if (el.searchClear) {
        el.searchClear.addEventListener("click", () => {
            clearTimeout(searchTimer);
            el.search.value = "";
            state.search = "";
            applyFilter();
            el.search.focus();
        });
    }

    if (el.channelGrid) {
        el.channelGrid.addEventListener("click", (e) => {
            const card = e.target.closest(".grid-card");
            if (!card || card.classList.contains("grid-card--empty")) return;
            playAt(Number(card.dataset.index));
        });
    }

    /* Core transport controls. Reload forces a fresh network fetch so a
       changed playlist lands immediately, bypassing the cache. */
    const controls = [
        [el.reload, () => loadPlaylists(state.sources, { force: true })],
        [el.scan, scanCurrentSource],
        [el.next, nextChannel],
        [el.volUp, () => {
            el.video.volume = Math.min(1, el.video.volume + 0.1);
            state.muteState = false;
            el.video.muted = false;
        }],
        [el.volDown, () => {
            el.video.volume = Math.max(0, el.video.volume - 0.1);
        }],
        [el.mute, () => {
            state.muteState = !state.muteState;
            el.video.muted = state.muteState;
            el.mute.textContent = state.muteState ? "UNMUTE" : "MUTE";
        }]
    ];
    controls.forEach(([node, fn]) => { if (node) node.addEventListener("click", fn); });

    document.addEventListener("keydown", (e) => {
        if (e.target === el.search) return;
        if (e.key === "ArrowDown") { e.preventDefault(); nextChannel(); }
        if (e.key === " " && e.target === document.body) { e.preventDefault(); nextChannel(); }
        if (e.key === "Escape") { closeM3uModal(); closeDrawer(); }
    });

    window.addEventListener("beforeunload", destroyPlayer);

    if (el.menuBtn) el.menuBtn.addEventListener("click", openDrawer);
    if (el.scrim) el.scrim.addEventListener("click", closeDrawer);

    if (el.addBtn) el.addBtn.addEventListener("click", openM3uModal);
    if (el.closeBtn) el.closeBtn.addEventListener("click", closeM3uModal);
    if (el.cancelBtn) el.cancelBtn.addEventListener("click", closeM3uModal);
    if (el.form) el.form.addEventListener("submit", handleM3uSubmit);

    if (el.savedList) {
        el.savedList.addEventListener("click", (e) => {
            const btn = e.target.closest("button.del-btn");
            if (!btn) return;
            removeCustomSource(btn.dataset.key);
        });
    }

    if (el.modal) {
        el.modal.addEventListener("click", (e) => {
            if (e.target === el.modal) closeM3uModal();
        });
    }

    /* ---------------- Boot ----------------
       BOOT_SOURCES from channels.js, else the first usable source. Every
       entry must have a URL. */
    function firstUsableSource() {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        const order = (typeof SOURCE_ORDER !== "undefined" && Array.isArray(SOURCE_ORDER))
            ? SOURCE_ORDER : [];
        const keys = order.concat(Object.keys(map).filter(k => order.indexOf(k) === -1));

        for (let i = 0; i < keys.length; i++) {
            const src = map[keys[i]];
            if (src && src.url) return keys[i];
        }
        return state.source;
    }

    refreshSources();

    const bootList = (Array.isArray(BOOT_KEYS) && BOOT_KEYS.length
        ? BOOT_KEYS.slice()
        : [firstUsableSource()]
    ).filter(k => {
        const map = (typeof CHANNEL_SOURCES === "object" && CHANNEL_SOURCES) || {};
        return map[k] && map[k].url;
    });

    if (!bootList.length) {
        const fallback = firstUsableSource();
        if (fallback) bootList.push(fallback);
    }

    state.sources = bootList;
    state.source  = bootList[0] ||
        (typeof DEFAULT_SOURCE === "string" ? DEFAULT_SOURCE : ALL_VALUE);

    renderCategories();
    renderGrid();
    showOverlay("AWAITING SIGNAL", "Pick a category, then a channel from the grid.", false);
    initTheme();

    if (bootList.length) {
        loadPlaylists(bootList);
    } else {
        showOverlay("NO PLAYLIST", "channels.js did not define any usable source.");
        status("playlist config missing", true);
    }
})();