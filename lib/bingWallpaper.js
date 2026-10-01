// Bing Wallpaper of the Day - resolution helper for NamakeWM
//
// Reuses the images that the BingWallpaper extension
// (bingwallpaper@ineffable-gmail.com) has already downloaded instead of
// fetching them a second time. That extension names its files
//
//     <YYYYMMDD>-<name>_<resolution>.jpg
//
// and keeps several days of history, so a day offset is just a matter of
// looking for a file whose name starts with the matching date.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BING_SCHEMA = 'org.gnome.shell.extensions.bingwallpaper';
const DEFAULT_FOLDER = '~/Pictures/BingWallpaper/';

// How many days back the list in the preferences should offer
const MAX_OFFSET = 8;

export const DAY_LABELS = {
    0: 'Today',
    1: 'Yesterday',
    2: '2 days ago',
    3: '3 days ago',
    4: '4 days ago',
    5: '5 days ago',
    6: '6 days ago',
    7: '7 days ago',
    8: '8 days ago',
};

export function maxBingOffset() {
    return MAX_OFFSET;
}

// Local date 'daysAgo' days back as YYYYMMDD.
//
// Deliberately uses JS Date and not GLib.DateTime.new_local(): the GLib
// constructor does not normalise out-of-range day values, so
// new_local(y, m, 1, ...) - 1 silently lands in the *next* month, and
// subtracting more than a month returns null outright.
export function dateKeyDaysAgo(daysAgo) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function dayLabel(daysAgo) {
    return DAY_LABELS[daysAgo] ?? `${daysAgo} days ago`;
}

// Where the BingWallpaper extension puts its downloads. Honour its own
// setting when the schema is reachable, otherwise fall back to the default
// location. A missing schema is not an error - the default usually matches.
export function getDownloadFolder() {
    try {
        const settings = new Gio.Settings({ schema_id: BING_SCHEMA });
        const configured = (settings.get_string('download-folder') ?? '').trim();
        if (configured !== '') {
            // The setting is normally the literal string "~/Pictures/BingWallpaper/",
            // so the tilde has to be expanded *before* joining. Passing it to
            // build_filenamev instead would yield ".../~/Pictures/..." and
            // silently find no images at all.
            if (configured === '~') {
                return GLib.get_home_dir();
            } else if (configured.startsWith('~/')) {
                return `${GLib.get_home_dir()}/${configured.slice(2)}`;
            } else if (configured.startsWith('/')) {
                return configured;
            }
            return GLib.build_filenamev([GLib.get_home_dir(), configured]);
        }
    } catch (e) {
        // Schema not visible from here - expected when the other extension is
        // not installed. Fall through to the default path.
    }
    return `${GLib.get_home_dir()}/Pictures/BingWallpaper/`;
}

// Every downloaded image, keyed by its YYYYMMDD prefix.
export function listAvailableImages(folder = getDownloadFolder()) {
    const result = new Map();
    let dir;

    try {
        const dirFile = Gio.File.new_for_path(folder);
        const enumerator = dirFile.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        dir = dirFile;
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
            const name = info.get_name();
            const m = /^(\d{8})-.*\.(jpe?g|png|webp)$/i.exec(name);
            if (!m) continue;
            // Earliest file wins for a given date, keeps this deterministic
            if (!result.has(m[1]))
                result.set(m[1], GLib.build_filenamev([dir.get_path(), name]));
        }
    } catch (e) {
        return result;
    }

    return result;
}

// Resolve a day offset to an image on disk.
// Exact match first. If that day has not been downloaded yet, fall back to the
// newest image that is not newer than the requested day - but only if it is
// within MAX_OFFSET days of it. That covers the odd missed download without
// silently substituting a wildly outdated picture.
export function resolveBingWallpaper(daysAgo, folder = getDownloadFolder()) {
    const images = listAvailableImages(folder);
    if (images.size === 0) return null;

    const target = dateKeyDaysAgo(daysAgo);
    const exact = images.get(target);
    if (exact) {
        return { path: exact, dateKey: target, exact: true, daysAgo };
    }

    const targetMs = Date.UTC(
        parseInt(target.slice(0, 4), 10),
        parseInt(target.slice(4, 6), 10) - 1,
        parseInt(target.slice(6, 8), 10)
    );

    let best = null;
    let bestKey = null;
    for (const [key, path] of images) {
        if (key > target) continue;
        if (bestKey === null || key > bestKey) {
            bestKey = key;
            best = path;
        }
    }
    if (!best) return null;

    const age = Math.round((targetMs - Date.UTC(
        parseInt(bestKey.slice(0, 4), 10),
        parseInt(bestKey.slice(4, 6), 10) - 1,
        parseInt(bestKey.slice(6, 8), 10)
    )) / 86400000);
    if (age > MAX_OFFSET) return null;

    return { path: best, dateKey: bestKey, exact: false, daysAgo, ageDays: age };
}

// Offsets that actually have an image, for the preferences dropdown.
export function availableOffsets(folder = getDownloadFolder()) {
    const images = listAvailableImages(folder);
    const out = [];
    for (let offset = 0; offset <= MAX_OFFSET; offset++) {
        if (resolveBingWallpaper(offset, folder)) out.push(offset);
    }
    return out;
}

export function isAvailable(folder = getDownloadFolder()) {
    return listAvailableImages(folder).size > 0;
}

// Monitor the download folder so a freshly downloaded day can be picked up
// without a reload. Returns the monitor; the caller connects and cancels it.
export function watchDownloadFolder() {
    try {
        const dir = Gio.File.new_for_path(getDownloadFolder());
        return dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        return null;
    }
}
