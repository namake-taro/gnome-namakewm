// Wallpaper Overlay for Multi Monitors Workspace Extension
// Displays per-workspace wallpapers as overlays on each monitor

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class WallpaperOverlayManager {
    constructor(settings) {
        this._settings = settings;
        this._overlays = new Map(); // monitorIndex -> Clutter.Actor
        this._imageCache = new Map(); // cacheKey -> Clutter.Image
        this._wallpaperGroups = []; // [{path, workspaces, scale, tile}, ...]
        this._lastMonitorWorkspaceMap = null; // Cache for settings change refresh
        this._enabled = false;

        // Permanent settings handlers (survive enable/disable cycles)
        this._settingsSignalIds = [];
        // Runtime signal handlers (only while enabled)
        this._monitorsChangedId = null;

        // Connect settings signals immediately (always watch for changes)
        this._connectSettingsSignals();
    }

    enable() {
        console.log('[NamakeWM-Wallpaper] Enabling WallpaperOverlayManager');
        this._enabled = true;
        this._loadSettings();
        console.log(`[NamakeWM-Wallpaper] Loaded ${this._wallpaperGroups.length} wallpaper groups`);
        this._createOverlays();
        this._connectRuntimeSignals();
        // If we have a cached map (re-enabled via settings), refresh immediately
        this._refreshAllOverlays();
        console.log('[NamakeWM-Wallpaper] WallpaperOverlayManager enabled');
    }

    disable() {
        console.log('[NamakeWM-Wallpaper] Disabling WallpaperOverlayManager');
        this._enabled = false;
        this._disconnectRuntimeSignals();
        this._destroyOverlays();
        this._clearImageCache();
    }

    // Called when extension is completely disabled
    destroy() {
        console.log('[NamakeWM-Wallpaper] Destroying WallpaperOverlayManager');
        this.disable();
        this._disconnectSettingsSignals();
    }

    // Update overlays when workspace map changes
    update(monitorWorkspaceMap) {
        if (!this._enabled) {
            console.log('[NamakeWM-Wallpaper] update() called but not enabled');
            return;
        }

        // Save for settings change refresh
        this._lastMonitorWorkspaceMap = monitorWorkspaceMap;

        console.log(`[NamakeWM-Wallpaper] update() called with ${monitorWorkspaceMap.size} monitors`);
        for (const [monitorIndex, wsIndex] of monitorWorkspaceMap) {
            const group = this._getWallpaperGroupForWs(wsIndex);
            console.log(`[NamakeWM-Wallpaper] M${monitorIndex} WS${wsIndex} -> ${group?.path || 'system'}`);
            this._updateOverlay(monitorIndex, group);
        }
    }

    // Refresh all overlays using cached map (for settings change)
    _refreshAllOverlays() {
        if (!this._lastMonitorWorkspaceMap) {
            console.log('[NamakeWM-Wallpaper] No cached map, skipping refresh');
            return;
        }
        console.log('[NamakeWM-Wallpaper] Refreshing all overlays after settings change');
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
            }
        } catch (e) {
            console.log(`[NamakeWM-Wallpaper] Failed to parse wallpaper-groups: ${e.message}`);
            this._wallpaperGroups = [];
        }
    }

    // Settings signals - always active (survive enable/disable cycles)
    _connectSettingsSignals() {
        // Watch for enable/disable toggle
        const id1 = this._settings.connect('changed::enable-workspace-wallpapers', () => {
            const enabled = this._settings.get_boolean('enable-workspace-wallpapers');
            console.log(`[NamakeWM-Wallpaper] enable-workspace-wallpapers changed to ${enabled}`);
            if (enabled && !this._enabled) {
                this.enable();
            } else if (!enabled && this._enabled) {
                this.disable();
            }
        });
        this._settingsSignalIds.push(id1);

        // Watch for wallpaper group changes (includes scale/tile per group)
        const id2 = this._settings.connect('changed::wallpaper-groups', () => {
            console.log('[NamakeWM-Wallpaper] wallpaper-groups changed, refreshing');
            this._loadSettings();
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

        // Use Clutter.Actor with Clutter.Image as content
        // content_gravity will be set based on display mode in _updateOverlay
        const overlay = new Clutter.Actor({
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

        console.log(`[NamakeWM-Wallpaper] Inserting overlay at index ${insertIndex} (total children: ${nChildren})`);
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
            console.log(`[NamakeWM-Wallpaper] No overlay for M${monitorIndex}`);
            return;
        }

        if (!group || !group.path) {
            // No custom wallpaper - hide overlay to show system wallpaper
            overlay.visible = false;
            overlay.set_content(null);
            console.log(`[NamakeWM-Wallpaper] M${monitorIndex} hidden (no custom wallpaper)`);
            return;
        }

        const { path, scale, tile } = group;
        console.log(`[NamakeWM-Wallpaper] Setting wallpaper for M${monitorIndex}: ${path}`);
        console.log(`[NamakeWM-Wallpaper] Mode: scale=${scale}, tile=${tile}`);

        // Prepare image with scaling/tiling applied
        const geo = global.display.get_monitor_geometry(monitorIndex);
        const image = this._prepareImage(path, geo.width, geo.height, scale, tile);
        if (!image) {
            console.log(`[NamakeWM-Wallpaper] Failed to prepare image: ${path}`);
            overlay.visible = false;
            overlay.set_content(null);
            return;
        }

        // Set content gravity based on mode
        // When tiling or scaling is applied, we create a screen-sized image, so use CENTER
        // This ensures the pre-processed image is displayed as-is
        overlay.set_content_gravity(Clutter.ContentGravity.CENTER);

        // Set the image as content and show
        overlay.set_content(image);
        overlay.visible = true;

        console.log(`[NamakeWM-Wallpaper] M${monitorIndex} overlay shown`);
    }

    _prepareImage(imagePath, screenWidth, screenHeight, scaleToFit, tile) {
        // Cache key includes path, screen size, and display mode
        const cacheKey = `${imagePath}:${screenWidth}x${screenHeight}:s${scaleToFit}:t${tile}`;
        if (this._imageCache.has(cacheKey)) {
            console.log(`[NamakeWM-Wallpaper] Using cached image for ${cacheKey}`);
            return this._imageCache.get(cacheKey);
        }

        try {
            // Check if file exists
            const file = Gio.File.new_for_path(imagePath);
            if (!file.query_exists(null)) {
                console.log(`[NamakeWM-Wallpaper] File not found: ${imagePath}`);
                return null;
            }

            console.log(`[NamakeWM-Wallpaper] Loading image: ${imagePath}`);

            // Load image with GdkPixbuf
            let srcPixbuf = GdkPixbuf.Pixbuf.new_from_file(imagePath);
            if (!srcPixbuf) {
                console.log(`[NamakeWM-Wallpaper] Failed to load pixbuf: ${imagePath}`);
                return null;
            }

            const srcWidth = srcPixbuf.get_width();
            const srcHeight = srcPixbuf.get_height();
            console.log(`[NamakeWM-Wallpaper] Source image: ${srcWidth}x${srcHeight}`);

            // Apply scaling if enabled
            let tilePixbuf = srcPixbuf;
            if (scaleToFit) {
                // Scale to fit screen while maintaining aspect ratio (cover mode)
                const scaleX = screenWidth / srcWidth;
                const scaleY = screenHeight / srcHeight;
                const scale = Math.max(scaleX, scaleY);

                const scaledWidth = Math.round(srcWidth * scale);
                const scaledHeight = Math.round(srcHeight * scale);

                tilePixbuf = srcPixbuf.scale_simple(
                    scaledWidth,
                    scaledHeight,
                    GdkPixbuf.InterpType.BILINEAR
                );
                console.log(`[NamakeWM-Wallpaper] Scaled to: ${scaledWidth}x${scaledHeight}`);
            }

            const tileWidth = tilePixbuf.get_width();
            const tileHeight = tilePixbuf.get_height();

            // Create the final screen-sized pixbuf
            let finalPixbuf;

            if (tile) {
                // Tiling mode: repeat image to fill screen, centered
                finalPixbuf = this._createTiledPixbuf(tilePixbuf, screenWidth, screenHeight);
            } else {
                // No tiling: single image centered on screen
                finalPixbuf = this._createCenteredPixbuf(tilePixbuf, screenWidth, screenHeight);
            }

            if (!finalPixbuf) {
                console.log(`[NamakeWM-Wallpaper] Failed to create final pixbuf`);
                return null;
            }

            // Create Clutter.Image from final pixbuf
            const image = new Clutter.Image();
            const pixelFormat = finalPixbuf.get_has_alpha()
                ? Cogl.PixelFormat.RGBA_8888
                : Cogl.PixelFormat.RGB_888;

            const success = image.set_data(
                finalPixbuf.get_pixels(),
                pixelFormat,
                finalPixbuf.get_width(),
                finalPixbuf.get_height(),
                finalPixbuf.get_rowstride()
            );

            if (!success) {
                console.log(`[NamakeWM-Wallpaper] Failed to set image data`);
                return null;
            }

            console.log(`[NamakeWM-Wallpaper] Clutter.Image created: ${finalPixbuf.get_width()}x${finalPixbuf.get_height()}`);

            // Cache the image
            this._imageCache.set(cacheKey, image);

            return image;
        } catch (e) {
            console.log(`[NamakeWM-Wallpaper] Error preparing wallpaper: ${e.message}`);
            console.log(`[NamakeWM-Wallpaper] Stack: ${e.stack}`);
            return null;
        }
    }

    _createCenteredPixbuf(srcPixbuf, screenWidth, screenHeight) {
        const srcWidth = srcPixbuf.get_width();
        const srcHeight = srcPixbuf.get_height();

        // Create a transparent canvas
        const canvas = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB,
            true, // has_alpha for transparency
            8,
            screenWidth,
            screenHeight
        );

        // Fill with transparent black
        canvas.fill(0x00000000);

        // Calculate center position
        const destX = Math.round((screenWidth - srcWidth) / 2);
        const destY = Math.round((screenHeight - srcHeight) / 2);

        // Calculate the visible area (clipping to screen bounds)
        const srcX = destX < 0 ? -destX : 0;
        const srcY = destY < 0 ? -destY : 0;
        const copyWidth = Math.min(srcWidth - srcX, screenWidth - Math.max(0, destX));
        const copyHeight = Math.min(srcHeight - srcY, screenHeight - Math.max(0, destY));

        if (copyWidth > 0 && copyHeight > 0) {
            srcPixbuf.copy_area(
                srcX, srcY,
                copyWidth, copyHeight,
                canvas,
                Math.max(0, destX), Math.max(0, destY)
            );
        }

        return canvas;
    }

    _createTiledPixbuf(srcPixbuf, screenWidth, screenHeight) {
        const srcWidth = srcPixbuf.get_width();
        const srcHeight = srcPixbuf.get_height();

        // Create a canvas for the final image
        const canvas = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB,
            srcPixbuf.get_has_alpha(),
            8,
            screenWidth,
            screenHeight
        );

        // Fill with black initially
        canvas.fill(0x000000FF);

        // Calculate center tile position (tile center aligns with screen center)
        const centerTileX = (screenWidth - srcWidth) / 2;
        const centerTileY = (screenHeight - srcHeight) / 2;

        // Find the leftmost/topmost tile position that covers the screen edge
        let startX = centerTileX;
        while (startX > 0) startX -= srcWidth;

        let startY = centerTileY;
        while (startY > 0) startY -= srcHeight;

        console.log(`[NamakeWM-Wallpaper] Tiling: tile=${srcWidth}x${srcHeight}, start=(${startX},${startY})`);

        // Tile the image
        for (let y = startY; y < screenHeight; y += srcHeight) {
            for (let x = startX; x < screenWidth; x += srcWidth) {
                // Calculate the portion of the tile that's visible
                const srcX = x < 0 ? -x : 0;
                const srcY = y < 0 ? -y : 0;
                const destX = Math.max(0, x);
                const destY = Math.max(0, y);
                const copyWidth = Math.min(srcWidth - srcX, screenWidth - destX);
                const copyHeight = Math.min(srcHeight - srcY, screenHeight - destY);

                if (copyWidth > 0 && copyHeight > 0) {
                    srcPixbuf.copy_area(
                        srcX, srcY,
                        copyWidth, copyHeight,
                        canvas,
                        destX, destY
                    );
                }
            }
        }

        return canvas;
    }

    _clearImageCache() {
        this._imageCache.clear();
    }
}
