// Highlight Overlay for Multi Monitors Workspace Extension
// Draws colored lines on edges of focused window and current display

import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Highlights the focused window (respects window stacking order)
export class WindowHighlighter {
    constructor(settings) {
        this._settings = settings;
        this._prefix = 'window-highlight';

        // Line widgets for each edge
        this._topLine = null;
        this._bottomLine = null;
        this._leftLine = null;
        this._rightLine = null;

        this._focusWindow = null;
        this._focusWindowActor = null;

        // Window geometry change handlers
        this._windowSizeChangedId = null;
        this._windowPositionChangedId = null;

        // Settings change handlers
        this._settingsChangedIds = [];

        // Watch for settings changes
        const keys = ['top', 'bottom', 'left', 'right', 'thickness', 'color'];
        for (const key of keys) {
            const fullKey = `${this._prefix}-${key}`;
            const id = this._settings.connect(`changed::${fullKey}`, () => {
                this._rebuild();
            });
            this._settingsChangedIds.push(id);
        }

        // Track focus changes
        this._displayFocusId = global.display.connect('notify::focus-window', () => {
            this._onFocusChanged();
        });

        // Track restacking (window z-order changes)
        this._restackedId = global.display.connect('restacked', () => {
            this._updateStacking();
        });

        // Track grab operations (window drag)
        this._grabOpBeginId = global.display.connect('grab-op-begin', () => {
            this._onGrabBegin();
        });

        this._grabOpEndId = global.display.connect('grab-op-end', () => {
            this._onGrabEnd();
        });

        this._isDragging = false;

        // Initial update
        this._onFocusChanged();
    }

    _onGrabBegin() {
        this._isDragging = true;
        this._removeLines();
    }

    _onGrabEnd() {
        this._isDragging = false;
        this._rebuild();
    }

    _getSettings() {
        return {
            top: this._settings.get_boolean(`${this._prefix}-top`),
            bottom: this._settings.get_boolean(`${this._prefix}-bottom`),
            left: this._settings.get_boolean(`${this._prefix}-left`),
            right: this._settings.get_boolean(`${this._prefix}-right`),
            thickness: this._settings.get_int(`${this._prefix}-thickness`),
            color: this._settings.get_string(`${this._prefix}-color`),
        };
    }

    _isEnabled() {
        const s = this._getSettings();
        return s.top || s.bottom || s.left || s.right;
    }

    _removeLines() {
        const lines = [this._topLine, this._bottomLine, this._leftLine, this._rightLine];
        for (const line of lines) {
            if (line) {
                if (line.get_parent()) {
                    line.get_parent().remove_child(line);
                }
                line.destroy();
            }
        }
        this._topLine = null;
        this._bottomLine = null;
        this._leftLine = null;
        this._rightLine = null;
    }

    _createLines(rect, windowActor) {
        this._removeLines();

        if (!rect || !windowActor) return;

        const s = this._getSettings();
        if (!this._isEnabled()) return;

        const { thickness, color } = s;
        const style = `background-color: ${color};`;

        // Create lines and add to window_group
        // Lines are drawn on the window edges (inside the frame)
        const windowGroup = global.window_group;

        if (s.top) {
            this._topLine = new St.Widget({
                style: style,
                width: rect.width,
                height: thickness,
                x: rect.x,
                y: rect.y,
            });
            windowGroup.add_child(this._topLine);
        }

        if (s.bottom) {
            this._bottomLine = new St.Widget({
                style: style,
                width: rect.width,
                height: thickness,
                x: rect.x,
                y: rect.y + rect.height - thickness,
            });
            windowGroup.add_child(this._bottomLine);
        }

        if (s.left) {
            this._leftLine = new St.Widget({
                style: style,
                width: thickness,
                height: rect.height,
                x: rect.x,
                y: rect.y,
            });
            windowGroup.add_child(this._leftLine);
        }

        if (s.right) {
            this._rightLine = new St.Widget({
                style: style,
                width: thickness,
                height: rect.height,
                x: rect.x + rect.width - thickness,
                y: rect.y,
            });
            windowGroup.add_child(this._rightLine);
        }

        // Position lines just above the window actor
        this._updateStacking();
    }

    _updateStacking() {
        if (!this._focusWindowActor) return;

        const windowGroup = global.window_group;
        const lines = [this._topLine, this._bottomLine, this._leftLine, this._rightLine];

        for (const line of lines) {
            if (line && line.get_parent() === windowGroup) {
                // Position the line just above the window actor
                windowGroup.set_child_above_sibling(line, this._focusWindowActor);
            }
        }
    }

    _disconnectWindowSignals() {
        if (this._windowSizeChangedId && this._focusWindow) {
            this._focusWindow.disconnect(this._windowSizeChangedId);
            this._windowSizeChangedId = null;
        }
        if (this._windowPositionChangedId && this._focusWindow) {
            this._focusWindow.disconnect(this._windowPositionChangedId);
            this._windowPositionChangedId = null;
        }
    }

    _connectWindowSignals() {
        if (!this._focusWindow) return;

        // Track window size changes (including maximize/unmaximize)
        this._windowSizeChangedId = this._focusWindow.connect('size-changed', () => {
            this._rebuild();
        });

        // Track window position changes
        this._windowPositionChangedId = this._focusWindow.connect('position-changed', () => {
            this._rebuild();
        });
    }

    _onFocusChanged() {
        // Disconnect from old window
        this._disconnectWindowSignals();

        this._focusWindow = global.display.get_focus_window();

        if (!this._focusWindow ||
            this._focusWindow.get_window_type() !== Meta.WindowType.NORMAL) {
            this._removeLines();
            this._focusWindow = null;
            this._focusWindowActor = null;
            return;
        }

        // Get the window actor
        this._focusWindowActor = this._focusWindow.get_compositor_private();

        // Connect to new window's geometry change signals
        this._connectWindowSignals();

        // Update highlight
        this._rebuild();
    }

    _rebuild() {
        // Don't rebuild during drag
        if (this._isDragging) {
            return;
        }

        if (!this._focusWindow || !this._focusWindowActor) {
            this._removeLines();
            return;
        }

        try {
            const rect = this._focusWindow.get_frame_rect();
            this._createLines(rect, this._focusWindowActor);
        } catch (e) {
            // Window may have been destroyed
            this._removeLines();
        }
    }

    // Public method to force update (called externally)
    update() {
        this._rebuild();
    }

    destroy() {
        // Disconnect settings handlers
        for (const id of this._settingsChangedIds) {
            this._settings.disconnect(id);
        }
        this._settingsChangedIds = [];

        if (this._displayFocusId) {
            global.display.disconnect(this._displayFocusId);
            this._displayFocusId = null;
        }

        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }

        if (this._grabOpBeginId) {
            global.display.disconnect(this._grabOpBeginId);
            this._grabOpBeginId = null;
        }

        if (this._grabOpEndId) {
            global.display.disconnect(this._grabOpEndId);
            this._grabOpEndId = null;
        }

        // Disconnect window geometry signals
        this._disconnectWindowSignals();

        this._focusWindow = null;
        this._focusWindowActor = null;

        this._removeLines();
    }
}

// Highlights the current display (where pointer is)
// Display highlights are drawn behind all windows
export class DisplayHighlighter {
    constructor(settings) {
        this._settings = settings;
        this._prefix = 'display-highlight';

        // Line widgets for each edge
        this._topLine = null;
        this._bottomLine = null;
        this._leftLine = null;
        this._rightLine = null;

        this._currentMonitor = -1;

        // Settings change handlers
        this._settingsChangedIds = [];

        // Watch for settings changes
        const keys = ['top', 'bottom', 'left', 'right', 'thickness', 'color'];
        for (const key of keys) {
            const fullKey = `${this._prefix}-${key}`;
            const id = this._settings.connect(`changed::${fullKey}`, () => {
                this._rebuild();
            });
            this._settingsChangedIds.push(id);
        }

        this._eventIds = [];

        // Track pointer movement
        const events = [
            'motion-event',
            'enter-event',
            'leave-event',
            'button-press-event',
            'button-release-event',
        ];

        for (const eventName of events) {
            const id = global.stage.connect(eventName, () => {
                this._onPointerMoved();
                return false; // EVENT_PROPAGATE
            });
            this._eventIds.push(id);
        }

        // Track focus changes too (for keyboard navigation)
        this._focusId = global.display.connect('notify::focus-window', () => {
            this._onPointerMoved();
        });

        // Track monitor changes
        this._monitorsChangedId = global.backend.get_monitor_manager().connect('monitors-changed', () => {
            this._currentMonitor = -1;
            this._onPointerMoved();
        });

        // Initial update
        this._onPointerMoved();
    }

    _getSettings() {
        return {
            top: this._settings.get_boolean(`${this._prefix}-top`),
            bottom: this._settings.get_boolean(`${this._prefix}-bottom`),
            left: this._settings.get_boolean(`${this._prefix}-left`),
            right: this._settings.get_boolean(`${this._prefix}-right`),
            thickness: this._settings.get_int(`${this._prefix}-thickness`),
            color: this._settings.get_string(`${this._prefix}-color`),
        };
    }

    _isEnabled() {
        const s = this._getSettings();
        return s.top || s.bottom || s.left || s.right;
    }

    _removeLines() {
        const lines = [this._topLine, this._bottomLine, this._leftLine, this._rightLine];
        for (const line of lines) {
            if (line) {
                if (line.get_parent()) {
                    line.get_parent().remove_child(line);
                }
                line.destroy();
            }
        }
        this._topLine = null;
        this._bottomLine = null;
        this._leftLine = null;
        this._rightLine = null;
    }

    _createLines(rect) {
        this._removeLines();

        if (!rect) return;

        const s = this._getSettings();
        if (!this._isEnabled()) return;

        const { thickness, color } = s;
        const style = `background-color: ${color};`;

        // Add to uiGroup (on top of everything)
        if (s.top) {
            this._topLine = new St.Widget({
                style: style,
                width: rect.width,
                height: thickness,
                x: rect.x,
                y: rect.y,
            });
            Main.uiGroup.add_child(this._topLine);
        }

        if (s.bottom) {
            this._bottomLine = new St.Widget({
                style: style,
                width: rect.width,
                height: thickness,
                x: rect.x,
                y: rect.y + rect.height - thickness,
            });
            Main.uiGroup.add_child(this._bottomLine);
        }

        if (s.left) {
            this._leftLine = new St.Widget({
                style: style,
                width: thickness,
                height: rect.height,
                x: rect.x,
                y: rect.y,
            });
            Main.uiGroup.add_child(this._leftLine);
        }

        if (s.right) {
            this._rightLine = new St.Widget({
                style: style,
                width: thickness,
                height: rect.height,
                x: rect.x + rect.width - thickness,
                y: rect.y,
            });
            Main.uiGroup.add_child(this._rightLine);
        }
    }

    _getMonitorAtPointer() {
        const [pointerX, pointerY] = global.get_pointer();
        const nMonitors = global.display.get_n_monitors();

        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            if (pointerX >= geo.x && pointerX < geo.x + geo.width &&
                pointerY >= geo.y && pointerY < geo.y + geo.height) {
                return i;
            }
        }

        return global.display.get_primary_monitor();
    }

    _onPointerMoved() {
        const monitor = this._getMonitorAtPointer();

        if (monitor !== this._currentMonitor) {
            this._currentMonitor = monitor;
            this._rebuild();
        }
    }

    _rebuild() {
        if (this._currentMonitor < 0) {
            this._removeLines();
            return;
        }

        const geo = global.display.get_monitor_geometry(this._currentMonitor);
        if (!geo) {
            this._removeLines();
            return;
        }

        this._createLines({
            x: geo.x,
            y: geo.y,
            width: geo.width,
            height: geo.height,
        });
    }

    // Public method to force update (called externally after warp)
    update() {
        this._currentMonitor = -1; // Force re-detection
        this._onPointerMoved();
    }

    destroy() {
        // Disconnect settings handlers
        for (const id of this._settingsChangedIds) {
            this._settings.disconnect(id);
        }
        this._settingsChangedIds = [];

        // Disconnect stage events
        for (const id of this._eventIds) {
            global.stage.disconnect(id);
        }
        this._eventIds = [];

        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }

        if (this._monitorsChangedId) {
            global.backend.get_monitor_manager().disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        this._removeLines();
    }
}
