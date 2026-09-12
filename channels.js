/* ============================================================
   channels.js — Sports + Football + Bangladesh.

   Both "Sports" and "Football" pull from the same iptv-org
   sports.m3u. The difference is only filtering:
     Sports    → raw file (every sport)
     Football  → broadcaster keyword match (channels likely to
                 carry football matches)
   There is no such thing as a football-only channel list, so
   "Football" here means "sports broadcasters that air football".
   ============================================================ */

const SPORTS_URL     = "https://iptv-org.github.io/iptv/categories/sports.m3u";
const BANGLADESH_URL = "https://iptv-org.github.io/iptv/countries/bd.m3u";

/* Your pre-filtered Gist (deep-checked, working streams only).
   Used as a DROP-IN replacement for SPORTS_URL so the app never
   has to deal with dead links. Set to "" to fall back to the
   live iptv-org URL. */
const MY_SPORTS_URL =
    "https://gist.githubusercontent.com/hakkarrr/2a96e28ae8f8155889298eaf7a71df7a/raw/gistfile1.txt";

/* Sports broadcasters that carry football. Matched against name +
   group-title. This is a BROAD list on purpose — the goal is
   "channels that show football", not "channels named football". */
const FOOTBALL_BROADCASTERS = [
    /* Dedicated football channels (rare, but exist) */
    "football", "futbol", "fútbol", "soccer",
    "laliga", "la liga", "serie a", "bundesliga", "ligue 1",
    "premier league", "champions league", "europa league",
    "real madrid", "barcelona tv", "barca tv", "fifa", "uefa",

    /* Big multi-sport broadcasters that air football */
    "sky sport", "sky calcio", "sky sports",
    "bein sport", "bein sports",
    "espn", "fox sport", "fox deportes", "cbs sport", "tnt sport",
    "dazn", "premier sport", "sportsnet", "tsn",
    "supersport", "astro supersport",
    "star sport", "star sports select",
    "canal+ sport", "canal sport", "sport tv", "eleven sport",
    "viaplay", "optus sport", "ziggo sport", "movistar",
    "rmc sport", "sportklub", "nova sport", "arena sport",
    "max sport", "digi sport", "prima sport", "sport1",
    "bt sport", "eurosport", "v sport", "tv2 sport",
    "match tv", "match!", "match futbol",
    "t sports", "a sports", "dd sport", "ptv sport", "ten sport",
    "willow", "tyc sport", "win sport", "l1 max",
    "n sports", "atg live", "m sports"
];

const CHANNEL_SOURCES = {

    /* ---- Sports: everything, unfiltered ---- */
    sports: {
        label: "Sports",
        url: MY_SPORTS_URL || SPORTS_URL,
        limit: 0
    },

    /* ---- Football: sports broadcasters likely to carry football ---- */
    football: {
        label: "Football",
        url: MY_SPORTS_URL || SPORTS_URL,
        limit: 0,
        bucket: "Football",
        match: FOOTBALL_BROADCASTERS
    },

    /* ---- Bangladesh ---- */
    bangladesh: {
        label: "Bangladesh",
        url: BANGLADESH_URL,
        limit: 0,
        bucket: "Bangladesh"
    },

    /* ---- Personal slots ---- */
    myCricket: {
        label: "My Cricket",
        url: "",
        limit: 0,
        bucket: "Cricket"
    },
    myBangladesh: {
        label: "My BD",
        url: "",
        limit: 0,
        bucket: "Bangladesh"
    }
};

const SOURCE_ORDER = [
    "football", "sports", "bangladesh",
    "myCricket", "myBangladesh"
];

const BOOT_SOURCES = ["football", "sports", "bangladesh"];

const STREAM_EXTENSIONS = [".m3u8", ".mpd", ".mp4", ".webm", ".ogg", ".ts", ".mkv"];

const DEFAULT_SOURCE = "football";

const PLAYLIST_TIMEOUT_MS = 20000;
const SCAN_CONCURRENCY    = 12;
const SCAN_TIMEOUT_MS     = 3000;

const SEARCH_ALL_TABS     = true;
const SEARCH_RESULT_LIMIT = 400;

const HIDE_CATEGORIES = [
    "News", "Kids", "Music", "Documentary",
    "Animation", "Cartoons", "Undefined", "Uncategorised"
];

const COLLAPSED_CATEGORIES = [
    { name: "Football", match: ["Football", "Soccer"] },
    { name: "Cricket",  match: ["Cricket"] },
    { name: "Sports",   match: ["Sports", "Outdoor", "Auto", "Series", "Culture"] }
];

const CHIP_PRIORITY = ["Football", "Sports", "Cricket", "Bangladesh"];