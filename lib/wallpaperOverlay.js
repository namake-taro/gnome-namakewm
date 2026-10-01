// Wallpaper Overlay for Multi Monitors Workspace Extension
// Displays per-workspace wallpapers as overlays on each monitor

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as BingWallpaper from './bingWallpaper.js';

export class WallpaperOverlayManager {
    constructor(settings) {
        this._settings = settings;
        this._overlays = new Map(); // monitorIndex -> St.Widget
        // cacheKey -> resolved image file path that has been verified to decode
        this._imageCache = new Map();        this._wallpaperGroups = []; // [{path, workspaces, scale, tile}, ...]
        this._lastMonitorWorkspaceMap = null; // Cache for settings change refresh
        this._enabled = false;

        // Permanent settings handlers (survive enable/disable cycles)
        this._settingsSignalIds = [];
        // Runtime signal handlers (only while enabled)
        this._monitorsChangedId = null;
        this._bingMonitor = null;
        this._bingDebounceId = 0;

        // Connect settings signals immediately (always watch for changes)
        this._connectSettingsSignals();
    }

    // Only emit when the extension's debug-mode setting is on. Overlays are
    // updated on every workspace switch, so unconditional logging floods the
    // journal (a 4-monitor switch produced dozens of lines per action).
    _debugLog(message) {
        if (this._settings.get_boolean('debug-mode'))
            console.log(`[NamakeWM-Wallpaper] ${message}`);
    }

    enable() {
        this._debugLog('Enabling WallpaperOverlayManager');
        this._enabled = true;
        this._loadSettings();
        this._debugLog(`Loaded ${this._wallpaperGroups.length} wallpaper groups`);
        this._refreshBingMonitor();
        this._createOverlays();
        this._connectRuntimeSignals();
        // If we have a cached map (re-enabled via settings), refresh immediately
        this._refreshAllOverlays();
        this._debugLog('WallpaperOverlayManager enabled');
    }

    disable() {
        this._debugLog('Disabling WallpaperOverlayManager');
        this._enabled = false;
        this._disconnectRuntimeSignals();
        this._destroyOverlays();
        this._clearImageCache();
    }

    // Called when extension is completely disabled
    destroy() {
        this._debugLog('Destroying WallpaperOverlayManager');
        this.disable();
        this._disconnectSettingsSignals();
    }

    // Update overlays when workspace map changes
    update(monitorWorkspaceMap) {
        if (!this._enabled) {
            console.warn('[NamakeWM-Wallpaper] update() called but not enabled');
            return;
        }

        // Save for settings change refresh
        this._lastMonitorWorkspaceMap = monitorWorkspaceMap;

        this._debugLog(`update() called with ${monitorWorkspaceMap.size} monitors`);
        for (const [monitorIndex, wsIndex] of monitorWorkspaceMap) {
            const group = this._getWallpaperGroupForWs(wsIndex);
            this._debugLog(`M${monitorIndex} WS${wsIndex} -> ${group?.path || 'system'}`);
            this._updateOverlay(monitorIndex, group);
        }
    }

    // Refresh all overlays using cached map (for settings change)
    _refreshAllOverlays() {
        if (!this._lastMonitorWorkspaceMap) {
            this._debugLog('No cached map, skipping refresh');
            return;
        }
        this._debugLog('Refreshing all overlays after settings change');
        this.update(this._lastMonitorWorkspaceMap);
    }

    _loadSettings() {
        try {
            const groupsJson = this._settings.get_string('wallpaper-groups');
            this._wallpaperGroups = JSON.parse(groupsJson);
            if (!Array.isArray(this._wallpaperGroups)) {
                this._wallpaperGroups = [];
            }
            // Ensure each group has scale and tile properties (default: scale=true, tile=false)
            for (const group of this._wallpaperGroups) {
                if (group.scale === undefined) group.scale = true;
                if (group.tile === undefined) group.tile = false;

                // A group may reference a Bing "wallpaper of the day" by day
                // offset instead of a fixed file. Resolve it to a real path so
                // the rest of this class can stay path-based.
                if (group.bing !== undefined && group.bing !== null) {
                    const resolved = BingWallpaper.resolveBingWallpaper(group.bing);
                    if (resolved) {
                        group.path = resolved.path;
                        if (!resolved.exact) {
                            this._debugLog(
                                `Bing day ${group.bing} has no download yet, using ${resolved.dateKey} instead`
                            );
                        }
                    } else {
                        this._debugLog(`No Bing image available for day ${group.bing}`);
                        group.path = '';
                    }
                }
            }
        } catch (e) {
            console.warn(`[NamakeWM-Wallpaper] Failed to parse wallpaper-groups: ${e.message}`);
            this._wallpaperGroups = [];
        }
    }

    // Settings signals - always active (survive enable/disable cycles)
    _connectSettingsSignals() {
        // Watch for enable/disable toggle
        const id1 = this._settings.connect('changed::enable-workspace-wallpapers', () => {
            const enabled = this._settings.get_boolean('enable-workspace-wallpapers');
            this._debugLog(`enable-workspace-wallpapers changed to ${enabled}`);
            if (enabled && !this._enabled) {
                this.enable();
            } else if (!enabled && this._enabled) {
                this.disable();
            }
        });
        this._settingsSignalIds.push(id1);

        // Watch for wallpaper group changes (includes scale/tile per group)
        const id2 = this._settings.connect('changed::wallpaper-groups', () => {
            this._debugLog('wallpaper-groups changed, refreshing');
            this._loadSettings();
            this._refreshBingMonitor();
            this._clearImageCache();
            this._refreshAllOverlays();
        });
        this._settingsSignalIds.push(id2);
    }

    _disconnectSettingsSignals() {
        for (const id of this._settingsSignalIds) {
            this._settings.disconnect(id);
        }
        this._settingsSignalIds = [];
        this._disconnectBingMonitor();
    }

    // A newly downloaded Bing wallpaper should show up on its own. The
    // BingWallpaper extension drops a new file into the folder daily, so watch
    // that folder rather than polling on a timer.
    //
    // Re-evaluated whenever the group list changes, so switching a group over to
    // Bing attaches the monitor and switching it back detaches it again.
    _refreshBingMonitor() {
        const usesBing = this._wallpaperGroups.some(
            (g) => g.bing !== undefined && g.bing !== null
        );

        if (!usesBing) {
            this._disconnectBingMonitor();
            return;
        }
        if (this._bingMonitor) return;

        const monitor = BingWallpaper.watchDownloadFolder();
        if (!monitor) return;

        monitor.connect('changed', () => {
            // Downloads arrive in bursts, wait for the folder to settle
            if (this._bingDebounceId) GLib.source_remove(this._bingDebounceId);
            this._bingDebounceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                2000,
                () => {
                    this._bingDebounceId = 0;
                    this._debugLog('Bing download folder changed, re-resolving');
                    this._loadSettings();
                    this._clearImageCache();
                    this._refreshAllOverlays();
                    return GLib.SOURCE_REMOVE;
                }
            );
        });
        this._bingMonitor = monitor;
        this._debugLog('Watching Bing download folder for new wallpapers');
    }

    _disconnectBingMonitor() {
        if (this._bingDebounceId) {
            GLib.source_remove(this._bingDebounceId);
            this._bingDebounceId = 0;
        }
        if (this._bingMonitor) {
            this._bingMonitor.cancel();
            this._bingMonitor = null;
        }
    }

    // Runtime signals - only while enabled
    _connectRuntimeSignals() {
        // Watch for monitor changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._rebuildOverlays();
            this._refreshAllOverlays();
        });
    }

    _disconnectRuntimeSignals() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
    }

    _getWallpaperGroupForWs(wsIndex) {
        // Find wallpaper group for this workspace
        for (const group of this._wallpaperGroups) {
            if (group.workspaces && group.workspaces.includes(wsIndex)) {
                return group;
            }
        }
        return null; // No custom wallpaper, show system wallpaper
    }

    _createOverlays() {
        const nMonitors = global.display.get_n_monitors();

        for (let i = 0; i < nMonitors; i++) {
            const overlay = this._createOverlayForMonitor(i);
            this._overlays.set(i, overlay);
        }
    }

    _createOverlayForMonitor(monitorIndex) {
        const geo = global.display.get_monitor_geometry(monitorIndex);

        // Use an St.Widget and let the compositor draw the wallpaper through a
        // CSS background. St.Widget has no repaint signal in mutter 48+, so a
        // custom draw handler would never run, and a CSS background is handled
        // entirely by the style system.
        const overlay = new St.Widget({
            x: geo.x,
            y: geo.y,
            width: geo.width,
            height: geo.height,
            visible: false,
            reactive: false,
        });

        // Add to background group above the system wallpaper but below other widgets like azclock
        const bgGroup = Main.layoutManager._backgroundGroup;
        const nChildren = bgGroup.get_n_children();

        // Find the position after all Meta.BackgroundActor children
        let insertIndex = 0;
        for (let i = 0; i < nChildren; i++) {
            const child = bgGroup.get_child_at_index(i);
            // BackgroundActor or similar background-related actors
            if (child.constructor.name.includes('Background')) {
                insertIndex = i + 1;
            }
        }

        this._debugLog(`Inserting overlay at index ${insertIndex} (total children: ${nChildren})`);
        bgGroup.insert_child_at_index(overlay, insertIndex);

        return overlay;
    }

    _destroyOverlays() {
        for (const [, overlay] of this._overlays) {
            if (overlay) {
                if (overlay.get_parent()) {
                    overlay.get_parent().remove_child(overlay);
                }
                overlay.destroy();
            }
        }
        this._overlays.clear();
    }

    _rebuildOverlays() {
        this._destroyOverlays();
        this._createOverlays();
    }

    _updateOverlay(monitorIndex, group) {
        const overlay = this._overlays.get(monitorIndex);
        if (!overlay) {
            this._debugLog(`No overlay for M${monitorIndex}`);
            return;
        }

        if (!group || !group.path) {
            // No custom wallpaper - hide overlay to show system wallpaper
            overlay.visible = false;
            overlay.set_style('background-image: none;');
            this._debugLog(`M${monitorIndex} hidden (no custom wallpaper)`);
            return;
        }

        const { path, scale, tile } = group;
        this._debugLog(`Setting wallpaper for M${monitorIndex}: ${path}`);
        this._debugLog(`Mode: scale=${scale}, tile=${tile}`);

        const imagePath = this._prepareImage(path);
        if (!imagePath) {
            console.warn(`[NamakeWM-Wallpaper] Failed to prepare image: ${path}`);
            overlay.visible = false;
            overlay.set_style('background-image: none;');
            return;
        }

        // Let the compositor scale and tile the image through CSS. This keeps
        // the whole render path inside the style system, so neither the
        // StImageContent preferred-size assert nor a St.Widget repaint
        // handler is involved. Both of those are broken in mutter 48+.
        const uri = Gio.File.new_for_path(imagePath).get_uri();
        let style = `background-image: url("${uri}");`;
        if (tile) {
            style += ' background-size: auto; background-repeat: repeat;';
        } else if (scale) {
            style += ' background-size: cover; background-repeat: no-repeat; background-position: center;';
        } else {
            style += ' background-size: auto; background-repeat: no-repeat; background-position: center;';
        }
        overlay.set_style(style);
        overlay.visible = true;
        this._debugLog(`M${monitorIndex} background set: ${uri}`);

        this._debugLog(`M${monitorIndex} overlay shown`);
    }

    _prepareImage(imagePath) {
        // With a CSS background the compositor does the scaling and tiling, so
        // this only has to make sure the file really is a readable image. The
        // decode is also what rejects a truncated file before it reaches the
        // compositor, where it would only show up as an empty background.
        if (this._imageCache.has(imagePath)) {
            this._debugLog(`Using cached image for ${imagePath}`);
            return this._imageCache.get(imagePath);
        }

        try {
            const file = Gio.File.new_for_path(imagePath);
            if (!file.query_exists(null)) {
                console.warn(`[NamakeWM-Wallpaper] File not found: ${imagePath}`);
                return null;
            }

            const probe = GdkPixbuf.Pixbuf.new_from_file(imagePath);
            if (!probe) {
                console.warn(`[NamakeWM-Wallpaper] Failed to load image: ${imagePath}`);
                return null;
            }
            this._debugLog(`Source image: ${probe.get_width()}x${probe.get_height()}`);

            this._imageCache.set(imagePath, imagePath);
            return imagePath;
        } catch (e) {
            console.error(`[NamakeWM-Wallpaper] Error preparing wallpaper: ${e.message}`);
            return null;
        }
    }


    _clearImageCache() {
        this._imageCache.clear();
    }
}
