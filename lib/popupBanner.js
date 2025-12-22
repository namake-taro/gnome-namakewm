// Popup Banner for Multi Monitors Workspace Extension
// Shows a brief notification when workspace or display changes

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class PopupBanner {
    constructor(settings) {
        this._settings = settings;
        this._banner = null;
        this._hideTimeoutId = null;
        this._fadeTimeoutId = null;

        // Track last shown state to avoid duplicate banners
        this._lastMonitor = -1;
        this._lastWsIndex = -1;

        // Settings change handler
        this._settingsChangedId = this._settings.connect('changed::show-popup-banner', () => {
            if (!this._settings.get_boolean('show-popup-banner')) {
                this._hideBanner();
            }
        });
    }

    _isEnabled() {
        return this._settings.get_boolean('show-popup-banner');
    }

    _createBanner() {
        if (this._banner) {
            this._removeBanner();
        }

        this._banner = new St.BoxLayout({
            style_class: 'mmw-popup-banner',
            style: `
                background-color: rgba(0, 0, 0, 0.75);
                border-radius: 12px;
                padding: 12px 24px;
            `,
            vertical: false,
            reactive: false,
        });

        // Display icon and number
        const displayIcon = new St.Label({
            text: '\uD83D\uDDA5\uFE0F',  // 🖥️
            style: 'font-size: 24px; margin-right: 8px;',
        });
        this._displayLabel = new St.Label({
            text: '1',
            style: 'font-size: 28px; font-weight: bold; color: white; margin-right: 20px;',
        });

        // Workspace icon and number
        const wsIcon = new St.Label({
            text: '\uD83D\uDCCB',  // 📋
            style: 'font-size: 24px; margin-right: 8px;',
        });
        this._wsLabel = new St.Label({
            text: '1',
            style: 'font-size: 28px; font-weight: bold; color: white;',
        });

        this._banner.add_child(displayIcon);
        this._banner.add_child(this._displayLabel);
        this._banner.add_child(wsIcon);
        this._banner.add_child(this._wsLabel);

        Main.uiGroup.add_child(this._banner);
    }

    _removeBanner() {
        if (this._banner) {
            if (this._banner.get_parent()) {
                this._banner.get_parent().remove_child(this._banner);
            }
            this._banner.destroy();
            this._banner = null;
            this._displayLabel = null;
            this._wsLabel = null;
        }
    }

    _clearTimeouts() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = null;
        }
        if (this._fadeTimeoutId) {
            GLib.source_remove(this._fadeTimeoutId);
            this._fadeTimeoutId = null;
        }
    }

    _hideBanner() {
        this._clearTimeouts();
        this._removeBanner();
    }

    _positionBanner(monitorIndex) {
        if (!this._banner) return;

        const geo = global.display.get_monitor_geometry(monitorIndex);
        if (!geo) return;

        // Get banner size after it's been added to stage
        const bannerWidth = this._banner.width;
        const bannerHeight = this._banner.height;

        // Center horizontally, 1/3 from top
        const x = geo.x + Math.floor((geo.width - bannerWidth) / 2);
        const y = geo.y + Math.floor(geo.height / 3);

        this._banner.set_position(x, y);
    }

    // Show the banner for the given monitor and workspace
    show(monitorIndex, wsIndex) {
        if (!this._isEnabled()) return;

        // Avoid showing duplicate banners for the same state
        if (monitorIndex === this._lastMonitor && wsIndex === this._lastWsIndex) {
            return;
        }

        this._lastMonitor = monitorIndex;
        this._lastWsIndex = wsIndex;

        // Clear any existing timeouts
        this._clearTimeouts();

        // Create or update banner
        this._createBanner();

        // Update labels (display is 1-indexed for user display)
        this._displayLabel.text = String(monitorIndex + 1);
        this._wsLabel.text = String(wsIndex + 1);

        // Show with full opacity
        this._banner.opacity = 255;

        // Position after a small delay to ensure size is calculated
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._positionBanner(monitorIndex);
            return GLib.SOURCE_REMOVE;
        });

        // Start fade out after 500ms
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._hideTimeoutId = null;

            if (this._banner) {
                // Fade out animation
                this._banner.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._removeBanner();
                        this._lastMonitor = -1;
                        this._lastWsIndex = -1;
                    },
                });
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    // Force show (bypass duplicate check)
    forceShow(monitorIndex, wsIndex) {
        this._lastMonitor = -1;
        this._lastWsIndex = -1;
        this.show(monitorIndex, wsIndex);
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._clearTimeouts();
        this._removeBanner();
    }
}
