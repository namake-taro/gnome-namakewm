// Workspace Indicator for Multi Monitors Workspace Extension
// Displays workspace numbers for each monitor in top bar

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// Styles - single row (1-2 monitors horizontally)
const BOX_SIZE_SINGLE = 28;
const FONT_SIZE_SINGLE = '18px';
// Styles - multi row (grid layout)
const BOX_SIZE_MULTI = 16;
const FONT_SIZE_MULTI = '11px';

const FONT_WEIGHT = 'bold';
const NORMAL_BG = 'rgba(0, 0, 0, 0.8)';
const NORMAL_FG = '#ffffff';
const NORMAL_BORDER = '1px solid #ffffff';
const HIGHLIGHT_BG = '#ff4444';
const HIGHLIGHT_FG = '#000000';
const HIGHLIGHT_BORDER = '1px solid #ff4444';
const BORDER_RADIUS = '4px';
const MARGIN = '1px';
const MARGIN_SINGLE = '2px';

// Convert internal wsIndex (0-9) to display key (1-9, 0)
// This matches Alt+1~9,0 keybindings
function wsIndexToDisplayKey(wsIndex) {
    return ((wsIndex + 1) % 10).toString();
}

// Group monitors by rows based on y coordinate
// Returns array of rows, each row is array of monitor info sorted by x
function groupMonitorsByRows(monitors) {
    // Sort by y first, then x
    const sorted = [...monitors].sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
    });

    // Group by similar y values (threshold for "same row")
    const rows = [];
    let currentRow = [];
    let lastY = null;
    const Y_THRESHOLD = 100; // Monitors within 100px y are same row

    for (const mon of sorted) {
        if (lastY === null || Math.abs(mon.y - lastY) <= Y_THRESHOLD) {
            currentRow.push(mon);
        } else {
            if (currentRow.length > 0) rows.push(currentRow);
            currentRow = [mon];
        }
        lastY = mon.y;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    // Sort each row by x
    for (const row of rows) {
        row.sort((a, b) => a.x - b.x);
    }

    return rows;
}

// Extension UUID
const EXTENSION_UUID = 'gnome-namakewm@namake-taro.github.io';

// Panel button containing monitor workspace indicators
export const WorkspaceIndicatorButton = GObject.registerClass(
class WorkspaceIndicatorButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Multi Monitor Workspace Indicator');

        // Container for monitor boxes (horizontal layout)
        this._container = new St.BoxLayout({
            style_class: 'panel-button',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._container);

        // Open preferences on click
        this.connect('button-press-event', () => {
            this._openPreferences();
            return Clutter.EVENT_STOP;
        });

        // Map: monitorIndex -> { box, label }
        this._monitorWidgets = new Map();

        // Sorted monitor indices (left to right by x coordinate)
        this._sortedMonitors = [];

        // Current monitor (where pointer is)
        this._currentMonitor = -1;

        // Multi-row layout flag
        this._isMultiRow = false;

        // Motion event tracking
        this._motionEventId = null;
    }

    // Build the indicator boxes based on monitor configuration
    buildIndicators(monitorWorkspaceMap) {
        // Clear existing widgets
        this._container.remove_all_children();
        this._monitorWidgets.clear();

        const nMonitors = global.display.get_n_monitors();

        // Get monitor geometries
        const monitors = [];
        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            monitors.push({ index: i, x: geo.x, y: geo.y });
        }

        // Group monitors by rows
        const rows = groupMonitorsByRows(monitors);
        this._isMultiRow = rows.length > 1;

        // Store sorted monitor indices
        this._sortedMonitors = [];
        for (const row of rows) {
            for (const mon of row) {
                this._sortedMonitors.push(mon.index);
            }
        }

        // Change container orientation for multi-row
        if (this._isMultiRow) {
            this._container.set_vertical(true);
        } else {
            this._container.set_vertical(false);
        }

        // Create layout based on rows
        for (const row of rows) {
            let rowContainer;
            if (this._isMultiRow) {
                // Create horizontal container for this row
                rowContainer = new St.BoxLayout({
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._container.add_child(rowContainer);
            } else {
                rowContainer = this._container;
            }

            for (const mon of row) {
                const wsIndex = monitorWorkspaceMap.get(mon.index) ?? 0;

                const box = new St.Bin({
                    style: this._getBoxStyle(false),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const label = new St.Label({
                    text: wsIndexToDisplayKey(wsIndex),
                    style: this._getLabelStyle(false),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                box.set_child(label);
                rowContainer.add_child(box);

                this._monitorWidgets.set(mon.index, { box, label });
            }
        }

        // Start tracking pointer
        this._startPointerTracking();

        // Initial highlight update
        this._updateHighlight();
    }

    _getBoxStyle(highlighted) {
        const bg = highlighted ? HIGHLIGHT_BG : NORMAL_BG;
        const border = highlighted ? HIGHLIGHT_BORDER : NORMAL_BORDER;
        const boxSize = this._isMultiRow ? BOX_SIZE_MULTI : BOX_SIZE_SINGLE;
        const margin = this._isMultiRow ? MARGIN : MARGIN_SINGLE;
        return `background-color: ${bg}; ` +
               `border: ${border}; ` +
               `border-radius: ${BORDER_RADIUS}; ` +
               `margin: ${margin}; ` +
               `min-width: ${boxSize}px; ` +
               `min-height: ${boxSize}px;`;
    }

    _getLabelStyle(highlighted) {
        const fg = highlighted ? HIGHLIGHT_FG : NORMAL_FG;
        const fontSize = this._isMultiRow ? FONT_SIZE_MULTI : FONT_SIZE_SINGLE;
        return `color: ${fg}; ` +
               `font-size: ${fontSize}; ` +
               `font-weight: ${FONT_WEIGHT}; ` +
               `text-align: center;`;
    }

    // Update workspace number for a specific monitor
    updateWorkspace(monitorIndex, wsIndex) {
        const widgets = this._monitorWidgets.get(monitorIndex);
        if (widgets) {
            widgets.label.set_text(wsIndexToDisplayKey(wsIndex));
        }
    }

    // Update all workspaces from map
    updateAllWorkspaces(monitorWorkspaceMap) {
        for (const [monitorIndex, wsIndex] of monitorWorkspaceMap) {
            this.updateWorkspace(monitorIndex, wsIndex);
        }
    }

    // Start tracking pointer position
    _startPointerTracking() {
        if (this._eventIds) {
            return; // Already tracking
        }

        this._eventIds = [];

        // Multiple events for reliable pointer tracking
        const events = [
            'motion-event',
            'enter-event',
            'leave-event',
            'button-press-event',
            'button-release-event',
            'scroll-event',
        ];

        for (const eventName of events) {
            const id = global.stage.connect(eventName, () => {
                this._updateHighlight();
                return Clutter.EVENT_PROPAGATE;
            });
            this._eventIds.push(id);
        }

        // Track focus window changes (keyboard navigation, Alt+Tab, etc.)
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            this._updateHighlight();
        });
    }

    // Stop tracking pointer position
    _stopPointerTracking() {
        if (this._eventIds) {
            for (const id of this._eventIds) {
                global.stage.disconnect(id);
            }
            this._eventIds = null;
        }

        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }
    }

    // Update highlight based on pointer position
    _updateHighlight() {
        const [pointerX, pointerY] = global.get_pointer();
        const nMonitors = global.display.get_n_monitors();
        let newCurrentMonitor = -1;

        // Find which monitor the pointer is on
        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            if (pointerX >= geo.x && pointerX < geo.x + geo.width &&
                pointerY >= geo.y && pointerY < geo.y + geo.height) {
                newCurrentMonitor = i;
                break;
            }
        }

        // Only update if monitor changed
        if (newCurrentMonitor !== this._currentMonitor) {
            // Remove highlight from previous
            if (this._currentMonitor >= 0) {
                const prevWidgets = this._monitorWidgets.get(this._currentMonitor);
                if (prevWidgets) {
                    prevWidgets.box.set_style(this._getBoxStyle(false));
                    prevWidgets.label.set_style(this._getLabelStyle(false));
                }
            }

            // Add highlight to new
            if (newCurrentMonitor >= 0) {
                const newWidgets = this._monitorWidgets.get(newCurrentMonitor);
                if (newWidgets) {
                    newWidgets.box.set_style(this._getBoxStyle(true));
                    newWidgets.label.set_style(this._getLabelStyle(true));
                }
            }

            this._currentMonitor = newCurrentMonitor;
        }
    }

    // Open extension preferences
    _openPreferences() {
        try {
            Main.extensionManager.openExtensionPrefs(EXTENSION_UUID, '', {});
        } catch (e) {
            console.error(`[MMW-Indicator] Failed to open preferences: ${e.message}`);
        }
    }

    destroy() {
        this._stopPointerTracking();
        super.destroy();
    }
});

// Manager class
export class WorkspaceIndicatorManager {
    constructor() {
        this._button = null;
    }

    // Create and add indicator to panel
    create(monitorWorkspaceMap) {
        this._button = new WorkspaceIndicatorButton();
        this._button.buildIndicators(monitorWorkspaceMap);

        // Add to panel (left side, position 1 = after Activities)
        Main.panel.addToStatusArea('mmw-workspace-indicator', this._button, 1, 'left');

        console.log('[MMW-Indicator] Created workspace indicator button');
    }

    // Update workspace numbers
    update(monitorWorkspaceMap) {
        if (this._button) {
            this._button.updateAllWorkspaces(monitorWorkspaceMap);
        }
    }

    // Rebuild on monitor changes
    rebuild(monitorWorkspaceMap) {
        if (this._button) {
            this._button.buildIndicators(monitorWorkspaceMap);
        }
    }

    // Update highlight (call after pointer warp)
    updateHighlight() {
        if (this._button) {
            this._button._updateHighlight();
        }
    }

    // Clean up
    destroy() {
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        console.log('[MMW-Indicator] Destroyed workspace indicator');
    }
}
