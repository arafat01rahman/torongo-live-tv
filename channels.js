/* ============================================================
   channels.js  —  Channel API / link layer
   ------------------------------------------------------------
   Everything that points at a remote playlist lives here, so the
   UI logic in app.js stays clean and you never edit markup to
   add or remove a tab.

   Every source is a real iptv-org category/country playlist:
     https://iptv-org.github.io/iptv/categories/<name>.m3u
     https://iptv-org.github.io/iptv/countries/<cc>.m3u
   They are regenerated daily upstream, so there is nothing to
   maintain by hand.

   Per-source options understood by app.js:
     label       tab text
     url         playlist URL
     limit       0 = no cap, N = cap rendered rows (keeps the DOM light)
     onlySports  keep only records whose group mentions "sport"
     match       keyword whitelist run against name + group
   ============================================================ */

const CHANNEL_SOURCES = {

    /* ---- Popular football ----
       The iptv-org "sports" category has no league metadata
       (group-title is just "Sports"), so the big competitions are
       reached by matching the broadcasters that actually carry
       them. Verified present in the live list: ESPN / ESPNU /
       beIN SPORTS XTRA / Premier Sports / DAZN / FIFA+ / SporTV. */
    football: {
        label: "Football",
        url: "https://iptv-org.github.io/iptv/categories/sports.m3u",
        limit: 0,
        match: [
            "espn", "bein", "premier sports", "dazn", "fifa",
            "sportv", "sky sport", "canal+ sport", "supersport",
            "football", "futbol", "f\u00fatbol", "soccer",
            "liga", "uefa", "champions", "copa", "serie a",
            "bundesliga", "eredivisie", "ligue 1", "match"
        ]
    },

    /* ---- Everything sporty ---- */
    sports: {
        label: "All Sports",
        url: "https://iptv-org.github.io/iptv/categories/sports.m3u",
        limit: 0
    },

    /* ---- Bangladesh ---- */
    bangladesh: {
        label: "Bangladesh",
        url: "https://iptv-org.github.io/iptv/countries/bd.m3u",
        limit: 0
    },

    /* ---- Cartoons ---- */
    cartoons: {
        label: "Cartoons",
        url: "https://iptv-org.github.io/iptv/categories/animation.m3u",
        limit: 0
    },

    kids: {
        label: "Kids",
        url: "https://iptv-org.github.io/iptv/categories/kids.m3u",
        limit: 200
    },

    movies: {
        label: "Movies",
        url: "https://iptv-org.github.io/iptv/categories/movies.m3u",
        limit: 250
    },

    news: {
        label: "News",
        url: "https://iptv-org.github.io/iptv/categories/news.m3u",
        limit: 200
    },

    music: {
        label: "Music",
        url: "https://iptv-org.github.io/iptv/categories/music.m3u",
        limit: 200
    },

    documentary: {
        label: "Docs",
        url: "https://iptv-org.github.io/iptv/categories/documentary.m3u",
        limit: 0
    },

    /* ---- Fallback firehose ---- */
    all: {
        label: "All",
        url: "https://iptv-org.github.io/iptv/index.m3u",
        limit: 600
    }
};

/* Tab order in the sidebar. Any key missing here is appended. */
const SOURCE_ORDER = [
    "football",
    "sports",
    "bangladesh",
    "cartoons",
    "kids",
    "movies",
    "news",
    "music",
    "documentary",
    "all"
];

/* Extensions we are willing to hand to the video element. */
const STREAM_EXTENSIONS = [".m3u8", ".mpd", ".mp4", ".webm", ".ogg", ".ts", ".mkv"];

/* Which tab opens on load (and is the fallback for a bad key). */
const DEFAULT_SOURCE = "all";

const PLAYLIST_TIMEOUT_MS = 20000;
