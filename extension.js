// GNOME Shell 46 Extension - Multi Monitors Independent Workspace
// ESModules format (required for GNOME 45+)

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { WorkspaceIndicatorManager } from './lib/workspaceIndicator.js';
import { WindowHighlighter, DisplayHighlighter } from './lib/highlightOverlay.js';
import { PopupBanner } from './lib/popupBanner.js';

// System keybinding schema
const WM_KEYBINDINGS_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const MUTTER_SCHEMA = 'org.gnome.mutter';

// Debug log file
const DEBUG_LOG_PATH = '/tmp/mmw-debug.log';

// Off-screen coordinate for hiding windows
const OFFSCREEN_X = -20000;
const OFFSCREEN_Y = -20000;

export default class MultiMonitorsWorkspaceExtension extends Extension {
    _settings = null;
    _wmSettings = null;
    _interfaceSettings = null;
    _mutterSettings = null;
    _debugMode = false;

    // monitorIndex -> workspaceIndex (which WS each monitor is displaying)
    _monitorWorkspaceMap = new Map();

    // windowId -> { relX, relY } (relative position within monitor for hidden windows)
    _savedWindowPositions = new Map();

    // Track recently processed windows to avoid duplicates
    _recentlyProcessedWindows = new Set();

    // Track windows pending placement (to suppress warp-pointer-to-focus)
    // Key: windowId, Value: targetMonitor
    _windowsPendingPlacement = new Map();

    // Save window info before disable (for restore after enable)
    // Key: windowId, Value: { monitorIndex, relX, relY, width, height }
    _savedWindowsBeforeDisable = new Map();

    // Track last focused window per workspace (for focus restoration)
    // Key: wsIndex, Value: windowId
    _lastWindowPerWorkspace = new Map();

    _signalIds = [];
    _osdLabel = null;
    _osdTimeoutId = null;

    // Flag to distinguish internal vs external workspace changes
    _isInternalSwitch = false;

    // Workspace indicator
    _indicatorManager = null;

    // Highlight overlays
    _windowHighlighter = null;
    _displayHighlighter = null;

    // Popup banner for workspace/display changes
    _popupBanner = null;

    enable() {
        console.log('[MultiMonitorsWorkspace] Enabling extension...');

        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({ schema_id: WM_KEYBINDINGS_SCHEMA });
        this._interfaceSettings = new Gio.Settings({ schema_id: INTERFACE_SCHEMA });
        this._mutterSettings = new Gio.Settings({ schema_id: MUTTER_SCHEMA });

        // Check prerequisites
        const requiredChanges = this._checkPrerequisites();

        if (requiredChanges.length > 0) {
            // Show confirmation dialog
            this._showPrerequisiteDialog(
                requiredChanges,
                () => {
                    // User accepted: apply changes and continue
                    this._applyPrerequisiteChanges(requiredChanges);
                    this._continueEnable();
                },
                () => {
                    // User rejected: disable extension
                    this._disableExtension();
                }
            );
        } else {
            // Prerequisites already met, continue normally
            this._continueEnable();
        }
    }

    _continueEnable() {
        // Read debug mode setting
        this._debugMode = this._settings.get_boolean('debug-mode');
        if (this._debugMode) {
            this._initDebugLog();
        }

        this._updateWorkspaceKeybindingSettings();
        this._overrideSystemKeybindings();
        this._initializeMapping();
        this._registerKeybindings();
        this._connectSignals();

        this._debugLog('=== Extension Enabled ===');
        this._debugDumpState('Initial State');

        // Create workspace indicator in top bar (if enabled in settings)
        if (this._settings.get_boolean('show-workspace-indicator')) {
            this._indicatorManager = new WorkspaceIndicatorManager();
            this._indicatorManager.create(this._monitorWorkspaceMap);
        }

        // Create highlight overlays
        this._windowHighlighter = new WindowHighlighter(this._settings);
        this._displayHighlighter = new DisplayHighlighter(this._settings);

        // Create popup banner
        this._popupBanner = new PopupBanner(this._settings);

        console.log('[MultiMonitorsWorkspace] Extension enabled successfully');

        // Restore saved secondary windows after a delay
        // This handles re-enable after screen unlock
        if (this._savedWindowsBeforeDisable && this._savedWindowsBeforeDisable.size > 0) {
            console.log(`[MultiMonitorsWorkspace] Will restore ${this._savedWindowsBeforeDisable.size} saved windows`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._restoreSavedSecondaryWindows();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        console.log('[MultiMonitorsWorkspace] Disabling extension...');

        // Restore windows to their logical workspaces before disabling
        this._restoreWindowsToLogicalWorkspaces();

        this._disconnectSignals();
        this._unregisterKeybindings();
        this._restoreSystemKeybindings();
        this._hideOsd();

        // Destroy workspace indicator
        if (this._indicatorManager) {
            this._indicatorManager.destroy();
            this._indicatorManager = null;
        }

        // Destroy highlight overlays
        if (this._windowHighlighter) {
            this._windowHighlighter.destroy();
            this._windowHighlighter = null;
        }
        if (this._displayHighlighter) {
            this._displayHighlighter.destroy();
            this._displayHighlighter = null;
        }

        // Destroy popup banner
        if (this._popupBanner) {
            this._popupBanner.destroy();
            this._popupBanner = null;
        }

        this._monitorWorkspaceMap.clear();
        // Note: Do NOT clear _savedWindowPositions - it's needed for correct window placement after unlock
        this._recentlyProcessedWindows.clear();
        this._windowsPendingPlacement.clear();
        // Note: Do NOT clear _savedWindowsBeforeDisable - it's needed for restore after enable
        // Note: Do NOT clear _lastWindowPerWorkspace - it's useful for focus restoration after unlock
        this._interfaceSettings = null;
        this._wmSettings = null;
        this._mutterSettings = null;
        this._settings = null;

        console.log('[MultiMonitorsWorkspace] Extension disabled successfully');
    }

    // Save secondary windows and move them to global WS before disable
    // This removes the STICKY (WS=-1) state that causes issues after screen unlock
    _restoreWindowsToLogicalWorkspaces() {
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const currentGlobalWs = global.workspace_manager.get_active_workspace();
        const primaryGeo = global.display.get_monitor_geometry(primaryMonitor);

        console.log('[MultiMonitorsWorkspace] Saving and moving secondary windows to global WS...');

        // Clear previous saved data
        this._savedWindowsBeforeDisable.clear();

        for (let monitorIndex = 0; monitorIndex < nMonitors; monitorIndex++) {
            if (monitorIndex === primaryMonitor) continue; // Skip primary

            const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
            const windowsOnMonitor = this._getWindowsOnMonitor(monitorIndex);
            const logicalWs = this._monitorWorkspaceMap.get(monitorIndex) ?? 0;

            for (const window of windowsOnMonitor) {
                const title = window.get_title?.() ?? 'unknown';
                const rect = window.get_frame_rect();
                const relX = rect.x - monitorGeo.x;
                const relY = rect.y - monitorGeo.y;
                const windowId = this._getWindowId(window);

                // Save window info for restore after enable
                this._savedWindowsBeforeDisable.set(windowId, {
                    monitorIndex,
                    logicalWs,
                    relX,
                    relY,
                    width: rect.width,
                    height: rect.height,
                    title
                });

                // Move to primary coordinates
                const newX = primaryGeo.x + relX;
                const newY = primaryGeo.y + relY;
                window.move_resize_frame(false, newX, newY, rect.width, rect.height);

                // Assign to GLOBAL WS (not logical WS) - this removes STICKY state
                window.change_workspace(currentGlobalWs);

                console.log(`[MultiMonitorsWorkspace] Saved "${title}" from M${monitorIndex} (WS${logicalWs}) -> primary, global WS`);
            }
        }

        console.log(`[MultiMonitorsWorkspace] Saved ${this._savedWindowsBeforeDisable.size} windows for restore`);
    }

    // Update workspace keybinding settings based on modifier key
    _updateWorkspaceKeybindingSettings() {
        const modifier = this._settings.get_string('workspace-modifier');
        const modKey = modifier === 'Super' ? '<Super>' : modifier === 'Ctrl' ? '<Control>' : '<Alt>';

        console.log(`[MultiMonitorsWorkspace] Setting workspace modifier to: ${modifier}`);

        // Update switch workspace keybindings
        for (let i = 0; i <= 9; i++) {
            const keyName = `mmw-switch-ws-${i}`;
            const keyNum = (i + 1) % 10; // 0->1, 1->2, ..., 9->0
            const binding = `${modKey}${keyNum}`;
            this._settings.set_strv(keyName, [binding]);
        }

        // Update move window keybindings
        for (let i = 0; i <= 9; i++) {
            const keyName = `mmw-move-ws-${i}`;
            const keyNum = (i + 1) % 10;
            const binding = `${modKey}<Shift>${keyNum}`;
            this._settings.set_strv(keyName, [binding]);
        }

        console.log(`[MultiMonitorsWorkspace] Keybindings updated: ${modKey}1-0 for switch, ${modKey}<Shift>1-0 for move`);
    }

    _overrideSystemKeybindings() {
        const savedBindings = {};
        let hasConflicts = false;

        for (let i = 0; i <= 9; i++) {
            const extKey = `mmw-switch-ws-${i}`;
            const sysKey = `switch-to-workspace-${i + 1}`;

            let extBindings = [];
            try {
                extBindings = this._settings.get_strv(extKey);
            } catch (e) {
                continue;
            }

            let sysBindings = [];
            try {
                sysBindings = this._wmSettings.get_strv(sysKey);
            } catch (e) {
                continue;
            }

            for (const extBinding of extBindings) {
                if (sysBindings.includes(extBinding)) {
                    hasConflicts = true;
                    break;
                }
            }

            if (sysBindings.length > 0) {
                savedBindings[sysKey] = sysBindings;
            }
        }

        // Check move-to-workspace-N conflicts
        for (let i = 0; i <= 9; i++) {
            const extKey = `mmw-move-ws-${i}`;
            const sysKey = `move-to-workspace-${i + 1}`;

            let extBindings = [];
            try {
                extBindings = this._settings.get_strv(extKey);
            } catch (e) {
                continue;
            }

            let sysBindings = [];
            try {
                sysBindings = this._wmSettings.get_strv(sysKey);
            } catch (e) {
                continue;
            }

            for (const extBinding of extBindings) {
                if (sysBindings.includes(extBinding)) {
                    hasConflicts = true;
                    break;
                }
            }

            if (sysBindings.length > 0) {
                savedBindings[sysKey] = sysBindings;
            }
        }

        if (hasConflicts) {
            this._settings.set_string('saved-system-keybindings', JSON.stringify(savedBindings));
            console.log('[MultiMonitorsWorkspace] Saved system keybindings');

            for (const sysKey of Object.keys(savedBindings)) {
                this._wmSettings.set_strv(sysKey, []);
            }
            console.log('[MultiMonitorsWorkspace] Disabled conflicting system keybindings');
        }
    }

    _restoreSystemKeybindings() {
        const savedJson = this._settings.get_string('saved-system-keybindings');
        if (!savedJson || savedJson === '') return;

        try {
            const savedBindings = JSON.parse(savedJson);
            for (const [key, bindings] of Object.entries(savedBindings)) {
                if (Array.isArray(bindings)) {
                    this._wmSettings.set_strv(key, bindings);
                }
            }
            this._settings.set_string('saved-system-keybindings', '');
            console.log('[MultiMonitorsWorkspace] System keybindings restored');
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to restore keybindings:', e);
        }
    }

    _checkPrerequisites() {
        // Check required mutter settings and return list of needed changes
        const changes = [];

        if (!this._mutterSettings.get_boolean('workspaces-only-on-primary')) {
            changes.push({
                key: 'workspaces-only-on-primary',
                current: false,
                required: true,
                description: 'Enable workspaces-only-on-primary',
            });
        }

        if (this._mutterSettings.get_boolean('dynamic-workspaces')) {
            changes.push({
                key: 'dynamic-workspaces',
                current: true,
                required: false,
                description: 'Disable dynamic-workspaces',
            });
        }

        return changes;
    }

    _applyPrerequisiteChanges(changes) {
        for (const change of changes) {
            console.log(`[MultiMonitorsWorkspace] Setting ${change.key} to ${change.required}`);
            this._mutterSettings.set_boolean(change.key, change.required);
        }
    }

    _showPrerequisiteDialog(changes, onAccept, onReject) {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'modal-dialog',
            destroyOnClose: true,
        });

        const title = new St.Label({
            style_class: 'modal-dialog-title',
            text: 'Multi Monitors Workspace',
            x_align: Clutter.ActorAlign.CENTER,
        });
        dialog.contentLayout.add_child(title);

        const message = new St.Label({
            text: `This extension requires the following settings to be changed:\n\n${changes.map(c => `• ${c.description}`).join('\n')}\n\nDo you want to apply these changes?`,
            style_class: 'modal-dialog-description',
        });
        message.clutter_text.line_wrap = true;
        dialog.contentLayout.add_child(message);

        dialog.addButton({
            label: 'No (Disable Extension)',
            action: () => {
                dialog.close();
                onReject();
            },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: 'Yes (Apply Changes)',
            action: () => {
                dialog.close();
                onAccept();
            },
            default: true,
        });

        dialog.open();
    }

    _disableExtension() {
        console.log('[MultiMonitorsWorkspace] User rejected prerequisite changes, disabling extension...');
        Main.notify(
            'Multi Monitors Workspace',
            'Extension disabled: prerequisites not met.'
        );

        // Disable the extension via command
        const extensionUuid = this.metadata.uuid;
        try {
            GLib.spawn_command_line_async(`gnome-extensions disable ${extensionUuid}`);
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to disable extension:', e);
        }
    }

    _initializeMapping() {
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const currentWs = global.workspace_manager.get_active_workspace_index();

        console.log(`[MultiMonitorsWorkspace] Initializing for ${nMonitors} monitors, primary=M${primaryMonitor}, currentWS=${currentWs}`);

        // Log all monitor geometries for debugging
        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            console.log(`[MultiMonitorsWorkspace] Monitor M${i}: x=${geo.x}, y=${geo.y}, w=${geo.width}, h=${geo.height}`);
        }

        // Ensure we have enough workspaces
        this._ensureWorkspaceExists(9);

        // Initialize: all monitors start showing the current global workspace
        // Then assign different workspaces based on which windows are on each monitor
        for (let i = 0; i < nMonitors; i++) {
            if (i === primaryMonitor) {
                // Primary monitor shows current global workspace
                this._monitorWorkspaceMap.set(i, currentWs);
            } else {
                // Secondary monitors: check if there are windows on them
                // For now, assign sequential workspaces
                const wsIndex = (currentWs + i) % 10;
                this._monitorWorkspaceMap.set(i, wsIndex);
            }
        }

        this._logMappings('Initial');
    }

    _registerKeybindings() {
        // Register workspace switch keybindings (Alt+1-9,0)
        for (let i = 0; i <= 9; i++) {
            const keyName = `mmw-switch-ws-${i}`;
            const workspaceIndex = i;
            Main.wm.addKeybinding(
                keyName,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    this._switchWorkspace(workspaceIndex);
                }
            );
        }

        // Register window move keybindings (Alt+Shift+1-9,0)
        for (let i = 0; i <= 9; i++) {
            const keyName = `mmw-move-ws-${i}`;
            const workspaceIndex = i;
            Main.wm.addKeybinding(
                keyName,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    this._moveWindowToWorkspace(workspaceIndex);
                }
            );
        }

        // Register warp-to-monitor keybindings (up to 8 monitors)
        for (let i = 0; i < 8; i++) {
            const keyName = `mmw-warp-to-monitor-${i}`;
            const monitorSortIndex = i;
            Main.wm.addKeybinding(
                keyName,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    this._warpPointerToMonitor(monitorSortIndex);
                    // Show popup banner
                    if (this._popupBanner) {
                        const wsIndex = this._monitorWorkspaceMap.get(monitorSortIndex) ?? 0;
                        this._popupBanner.show(monitorSortIndex, wsIndex);
                    }
                }
            );
        }

        // Register cycle focus keybindings
        Main.wm.addKeybinding(
            'mmw-cycle-focus-forward',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._cycleFocus(true);
            }
        );

        Main.wm.addKeybinding(
            'mmw-cycle-focus-backward',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._cycleFocus(false);
            }
        );

        // Register swap window position keybindings
        Main.wm.addKeybinding(
            'mmw-swap-window-forward',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._swapWindowPosition(true);
            }
        );

        Main.wm.addKeybinding(
            'mmw-swap-window-backward',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._swapWindowPosition(false);
            }
        );

        console.log('[MultiMonitorsWorkspace] Keybindings registered');
    }

    _unregisterKeybindings() {
        for (let i = 0; i <= 9; i++) {
            Main.wm.removeKeybinding(`mmw-switch-ws-${i}`);
            Main.wm.removeKeybinding(`mmw-move-ws-${i}`);
        }
        for (let i = 0; i < 8; i++) {
            Main.wm.removeKeybinding(`mmw-warp-to-monitor-${i}`);
        }
        Main.wm.removeKeybinding('mmw-cycle-focus-forward');
        Main.wm.removeKeybinding('mmw-cycle-focus-backward');
        Main.wm.removeKeybinding('mmw-swap-window-forward');
        Main.wm.removeKeybinding('mmw-swap-window-backward');
    }

    // Cycle focus within current monitor's workspace
    _cycleFocus(forward) {
        const currentMonitor = this._getMonitorAtPointer();
        const currentWs = this._monitorWorkspaceMap.get(currentMonitor) ?? 0;

        // Get windows on current monitor that belong to current workspace
        const windows = this._getWindowsOnMonitorForWorkspace(currentMonitor, currentWs);

        if (windows.length === 0) {
            return;
        }

        // Sort windows by position (top-left to bottom-right)
        windows.sort((a, b) => {
            const rectA = a.get_frame_rect();
            const rectB = b.get_frame_rect();
            if (Math.abs(rectA.y - rectB.y) < 50) {
                return rectA.x - rectB.x;
            }
            return rectA.y - rectB.y;
        });

        // Find current focused window
        const focusedWindow = global.display.get_focus_window();
        let currentIndex = -1;
        if (focusedWindow) {
            currentIndex = windows.indexOf(focusedWindow);
        }

        // Calculate next index
        let nextIndex;
        if (currentIndex === -1) {
            nextIndex = 0;
        } else if (forward) {
            nextIndex = (currentIndex + 1) % windows.length;
        } else {
            nextIndex = (currentIndex - 1 + windows.length) % windows.length;
        }

        // Focus the next window
        const nextWindow = windows[nextIndex];
        const timestamp = global.get_current_time();

        // Check if we should also raise the window
        if (this._settings.get_boolean('raise-on-cycle-focus')) {
            nextWindow.activate(timestamp);  // Focus + Raise
        } else {
            nextWindow.focus(timestamp);     // Focus only
        }

        this._debugLog(`Cycled focus to "${nextWindow.get_title()}" (${nextIndex + 1}/${windows.length})`);

        // Warp pointer if enabled
        if (this._settings.get_boolean('warp-pointer-to-focus')) {
            const rect = nextWindow.get_frame_rect();
            const centerX = Math.floor(rect.x + rect.width / 2);
            const centerY = Math.floor(rect.y + rect.height / 2);

            const seat = Clutter.get_default_backend().get_default_seat();
            seat.warp_pointer(centerX, centerY);
        }
    }

    // Swap current window's position and size with the next/previous window
    _swapWindowPosition(forward) {
        const currentMonitor = this._getMonitorAtPointer();
        const currentWs = this._monitorWorkspaceMap.get(currentMonitor) ?? 0;

        // Get windows on current monitor that belong to current workspace
        const windows = this._getWindowsOnMonitorForWorkspace(currentMonitor, currentWs);

        if (windows.length < 2) {
            return;  // Need at least 2 windows to swap
        }

        // Sort windows by position (same as cycle focus)
        windows.sort((a, b) => {
            const rectA = a.get_frame_rect();
            const rectB = b.get_frame_rect();
            if (Math.abs(rectA.y - rectB.y) < 50) {
                return rectA.x - rectB.x;
            }
            return rectA.y - rectB.y;
        });

        // Find current focused window
        const focusedWindow = global.display.get_focus_window();
        if (!focusedWindow) {
            return;
        }

        const currentIndex = windows.indexOf(focusedWindow);
        if (currentIndex === -1) {
            return;  // Focused window is not in the list
        }

        // Calculate target index
        let targetIndex;
        if (forward) {
            targetIndex = (currentIndex + 1) % windows.length;
        } else {
            targetIndex = (currentIndex - 1 + windows.length) % windows.length;
        }

        const targetWindow = windows[targetIndex];

        // Save maximized/fullscreen states (to swap them)
        const currentMaximized = focusedWindow.get_maximized();
        const targetMaximized = targetWindow.get_maximized();
        const currentFullscreen = focusedWindow.is_fullscreen();
        const targetFullscreen = targetWindow.is_fullscreen();

        this._debugLog(`Swapping positions: "${focusedWindow.get_title()}" <-> "${targetWindow.get_title()}"`);
        this._debugLog(`  Current maximized: ${currentMaximized}, fullscreen: ${currentFullscreen}`);
        this._debugLog(`  Target maximized: ${targetMaximized}, fullscreen: ${targetFullscreen}`);

        // Unmaximize/unfullscreen before moving
        if (currentMaximized) focusedWindow.unmaximize(currentMaximized);
        if (targetMaximized) targetWindow.unmaximize(targetMaximized);
        if (currentFullscreen) focusedWindow.unmake_fullscreen();
        if (targetFullscreen) targetWindow.unmake_fullscreen();

        // Wait for state changes to take effect, then swap positions
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (focusedWindow.is_destroyed?.() || targetWindow.is_destroyed?.()) {
                return GLib.SOURCE_REMOVE;
            }

            // Get positions after unmaximize (may have changed)
            const currentRect = focusedWindow.get_frame_rect();
            const targetRect = targetWindow.get_frame_rect();

            this._debugLog(`  Current rect: (${currentRect.x},${currentRect.y}) ${currentRect.width}x${currentRect.height}`);
            this._debugLog(`  Target rect: (${targetRect.x},${targetRect.y}) ${targetRect.width}x${targetRect.height}`);

            // Swap positions and sizes
            focusedWindow.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            targetWindow.move_resize_frame(false, currentRect.x, currentRect.y, currentRect.width, currentRect.height);

            // Restore states (swapped: focused gets target's state, target gets focused's state)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (focusedWindow.is_destroyed?.() || targetWindow.is_destroyed?.()) {
                    return GLib.SOURCE_REMOVE;
                }

                // Apply swapped states
                if (targetMaximized) focusedWindow.maximize(targetMaximized);
                if (currentMaximized) targetWindow.maximize(currentMaximized);
                if (targetFullscreen) focusedWindow.make_fullscreen();
                if (currentFullscreen) targetWindow.make_fullscreen();

                // Re-focus the originally focused window to prevent "ready" notification
                if (!focusedWindow.is_destroyed?.()) {
                    focusedWindow.focus(global.get_current_time());
                }

                this._debugLog(`Swap complete with state swap`);
                return GLib.SOURCE_REMOVE;
            });

            // Warp pointer to new position if enabled
            if (this._settings.get_boolean('warp-pointer-to-focus')) {
                const newCenterX = Math.floor(targetRect.x + targetRect.width / 2);
                const newCenterY = Math.floor(targetRect.y + targetRect.height / 2);

                const seat = Clutter.get_default_backend().get_default_seat();
                seat.warp_pointer(newCenterX, newCenterY);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    // Get windows on a specific monitor for a specific workspace
    _getWindowsOnMonitorForWorkspace(monitorIndex, wsIndex) {
        const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
        const primaryMonitor = global.display.get_primary_monitor();

        return global.get_window_actors()
            .map(actor => actor.get_meta_window())
            .filter(win => {
                if (!win) return false;
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_hidden()) return false;
                if (win.minimized) return false;

                const rect = win.get_frame_rect();
                const centerX = rect.x + rect.width / 2;
                const centerY = rect.y + rect.height / 2;

                // Check if window is on this monitor
                const isOnMonitor = centerX >= monitorGeo.x &&
                                   centerX < monitorGeo.x + monitorGeo.width &&
                                   centerY >= monitorGeo.y &&
                                   centerY < monitorGeo.y + monitorGeo.height;

                if (!isOnMonitor) return false;

                // For primary monitor, check actual workspace
                if (monitorIndex === primaryMonitor) {
                    const winWs = win.get_workspace()?.index() ?? -1;
                    return winWs === wsIndex;
                }

                // For secondary monitors, all visible windows belong to displayed workspace
                return true;
            });
    }

    // Warp pointer to monitor and focus last used window (by system monitor index)
    _warpPointerToMonitor(monitorIndex) {
        const nMonitors = global.display.get_n_monitors();

        // Check if monitorIndex is valid
        if (monitorIndex >= nMonitors) {
            return;
        }

        const geo = global.display.get_monitor_geometry(monitorIndex);
        const wsIndex = this._monitorWorkspaceMap.get(monitorIndex) ?? 0;
        const seat = Clutter.get_default_backend().get_default_seat();

        // Check if we have a saved window for this workspace
        const lastWindowId = this._lastWindowPerWorkspace.get(wsIndex);
        let targetX, targetY;
        let focusedWindow = null;

        if (lastWindowId) {
            // Try to find the saved window
            const window = this._findWindowById(lastWindowId);
            if (window && !window.is_destroyed?.()) {
                // Verify the window is on the correct monitor
                const windowMonitor = this._getWindowMonitor(window);
                // Verify the window is visible on the current workspace
                const activeWs = global.workspace_manager.get_active_workspace();
                const isOnActiveWs = window.located_on_workspace(activeWs);

                if (windowMonitor === monitorIndex && isOnActiveWs) {
                    // Focus the window and warp to its center
                    const rect = window.get_frame_rect();
                    targetX = Math.floor(rect.x + rect.width / 2);
                    targetY = Math.floor(rect.y + rect.height / 2);
                    focusedWindow = window;
                    this._debugLog(`Restored focus to last window: "${window.get_title()}" on WS${wsIndex}`);
                } else if (!isOnActiveWs) {
                    this._debugLog(`Window "${window.get_title()}" not on active WS, clearing record`);
                    this._lastWindowPerWorkspace.delete(wsIndex);
                }
            }
        }

        // If no saved window or window not found, use monitor center
        if (!focusedWindow) {
            targetX = Math.floor(geo.x + geo.width / 2);
            targetY = Math.floor(geo.y + geo.height / 2);
        }

        // Warp pointer
        seat.warp_pointer(targetX, targetY);

        // Focus the window (or find one at position)
        if (focusedWindow) {
            focusedWindow.focus(global.get_current_time());
        } else {
            this._focusWindowAtPosition(targetX, targetY, monitorIndex);
        }

        // Update indicator highlight
        if (this._indicatorManager) {
            this._indicatorManager.updateHighlight();
        }
    }

    // Focus window at position - optimized version that only checks windows on specific monitor
    _focusWindowAtPosition(pointerX, pointerY, monitorIndex) {
        const currentWs = this._monitorWorkspaceMap.get(monitorIndex) ?? 0;
        const windows = this._getWindowsOnMonitorForWorkspace(monitorIndex, currentWs);

        if (windows.length === 0) {
            // No windows on this monitor - unfocus all windows to prevent
            // focus staying on a different monitor's window
            this._unfocusAllWindows();
            this._debugLog(`No windows on M${monitorIndex}, unfocused all windows`);
            return;
        }

        // Find topmost window containing the pointer
        let targetWindow = null;
        let highestLayer = -1;

        for (const win of windows) {
            const rect = win.get_frame_rect();
            if (pointerX >= rect.x && pointerX < rect.x + rect.width &&
                pointerY >= rect.y && pointerY < rect.y + rect.height) {
                const layer = win.get_layer();
                if (layer > highestLayer || targetWindow === null) {
                    highestLayer = layer;
                    targetWindow = win;
                }
            }
        }

        // If no window under pointer, focus the topmost window on this monitor
        if (!targetWindow && windows.length > 0) {
            // Sort by stacking order (use window actor's position in window_group)
            const windowGroup = global.window_group;
            const sortedWindows = [...windows].sort((a, b) => {
                const actorA = a.get_compositor_private();
                const actorB = b.get_compositor_private();
                if (!actorA || !actorB) return 0;
                // Higher index = on top
                const children = windowGroup.get_children();
                return children.indexOf(actorB) - children.indexOf(actorA);
            });
            targetWindow = sortedWindows[0];
            this._debugLog(`No window under pointer, focusing topmost: "${targetWindow.get_title()}"`);
        }

        if (targetWindow) {
            targetWindow.focus(global.get_current_time());
        }
    }

    // Focus last used window for a workspace, or fall back to window at pointer position
    _focusLastOrAtPosition(monitorIndex, wsIndex, pointerX, pointerY) {
        const lastWindowId = this._lastWindowPerWorkspace.get(wsIndex);

        if (lastWindowId) {
            // Try to find the saved window
            const window = this._findWindowById(lastWindowId);
            if (window && !window.is_destroyed?.()) {
                // Verify the window is on the correct monitor
                const windowMonitor = this._getWindowMonitor(window);
                // Verify the window is visible on the current workspace
                const activeWs = global.workspace_manager.get_active_workspace();
                const isOnActiveWs = window.located_on_workspace(activeWs);

                if (windowMonitor === monitorIndex && isOnActiveWs) {
                    // Focus the window and warp to its center
                    const rect = window.get_frame_rect();
                    const targetX = Math.floor(rect.x + rect.width / 2);
                    const targetY = Math.floor(rect.y + rect.height / 2);

                    const seat = Clutter.get_default_backend().get_default_seat();
                    seat.warp_pointer(targetX, targetY);

                    window.focus(global.get_current_time());
                    this._debugLog(`Restored focus to last window: "${window.get_title()}" on WS${wsIndex}`);
                    return;
                }
            }
            // Window not found, moved, or not on active WS - clear the record
            this._lastWindowPerWorkspace.delete(wsIndex);
        }

        // No saved window - use provided pointer position
        this._focusWindowAtPosition(pointerX, pointerY, monitorIndex);
    }

    // Find a window by its ID
    _findWindowById(windowId) {
        const actors = global.get_window_actors();
        for (const actor of actors) {
            const window = actor.get_meta_window();
            if (!window) continue;
            if (this._getWindowId(window) === windowId) {
                return window;
            }
        }
        return null;
    }

    // Unfocus all windows - used when moving to empty monitor
    _unfocusAllWindows() {
        // Remove Clutter key focus
        global.stage.set_key_focus(null);

        // Try to unfocus at Mutter/Meta level
        // This is needed because set_key_focus only affects Clutter, not window focus
        try {
            // Try unset_input_focus if available (GNOME 46+)
            if (typeof global.display.unset_input_focus === 'function') {
                global.display.unset_input_focus(global.get_current_time());
            }
        } catch (e) {
            // API might not exist or throw
            this._debugLog(`unset_input_focus failed: ${e.message}`);
        }

        // As a fallback, try to focus the stage actor itself
        // This can help release window focus on some configurations
        try {
            global.stage.grab_key_focus();
        } catch (e) {
            // Ignore errors
        }
    }

    // Focus the window under the given pointer position (searches all windows)
    _focusWindowUnderPointer(pointerX, pointerY) {
        const windows = global.get_window_actors()
            .map(actor => actor.get_meta_window())
            .filter(win => {
                if (!win) return false;
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_hidden()) return false;
                if (win.minimized) return false;
                return true;
            });

        // Find topmost window containing the pointer
        let targetWindow = null;
        let highestLayer = -1;

        for (const win of windows) {
            const rect = win.get_frame_rect();
            if (pointerX >= rect.x && pointerX < rect.x + rect.width &&
                pointerY >= rect.y && pointerY < rect.y + rect.height) {
                const layer = win.get_layer();
                if (layer > highestLayer || targetWindow === null) {
                    highestLayer = layer;
                    targetWindow = win;
                }
            }
        }

        if (targetWindow) {
            const timestamp = global.get_current_time();
            targetWindow.focus(timestamp);
            this._debugLog(`Focused window: "${targetWindow.get_title()}"`);
        }
    }

    // Move the focused window to target workspace (without switching display)
    _moveWindowToWorkspace(targetWs) {
        // Save mouse pointer position before any window operations
        const [savedPointerX, savedPointerY] = global.get_pointer();

        const focusedWindow = global.display.get_focus_window();
        if (!focusedWindow) {
            console.log('[MultiMonitorsWorkspace] No focused window to move');
            return;
        }

        // Skip non-normal windows
        if (focusedWindow.get_window_type() !== Meta.WindowType.NORMAL) {
            console.log('[MultiMonitorsWorkspace] Cannot move non-normal window');
            return;
        }

        const title = focusedWindow.get_title?.() ?? 'unknown';
        const currentWs = focusedWindow.get_workspace()?.index() ?? -1;
        const currentMonitor = this._getMonitorAtPointer();
        const currentDisplayWs = this._monitorWorkspaceMap.get(currentMonitor) ?? 0;

        this._debugLog(`\n========== MOVE WINDOW ==========`);
        this._debugLog(`Window: "${title}" from WS${currentWs} to WS${targetWs}`);
        this._debugLog(`Current monitor: M${currentMonitor} displaying WS${currentDisplayWs}`);
        this._debugLog(`Saved pointer: (${savedPointerX}, ${savedPointerY})`);

        if (currentWs === targetWs) {
            this._debugLog('Result: No change (same workspace)');
            return;
        }

        // Ensure target workspace exists
        this._ensureWorkspaceExists(targetWs);

        const targetWsObj = global.workspace_manager.get_workspace_by_index(targetWs);
        const primaryMonitor = global.display.get_primary_monitor();
        const primaryGeo = global.display.get_monitor_geometry(primaryMonitor);
        const rect = focusedWindow.get_frame_rect();
        const monitorGeo = global.display.get_monitor_geometry(currentMonitor);

        // Save relative position for later restoration
        const relX = rect.x - monitorGeo.x;
        const relY = rect.y - monitorGeo.y;
        const windowId = this._getWindowId(focusedWindow);
        this._savedWindowPositions.set(windowId, { relX, relY, wsIndex: targetWs });

        // Move window to target workspace
        const newX = primaryGeo.x + relX;
        const newY = primaryGeo.y + relY;
        focusedWindow.move_frame(false, newX, newY);
        focusedWindow.change_workspace(targetWsObj);

        this._debugLog(`Moved "${title}" to WS${targetWs} at primary coords (${newX},${newY})`);

        // Restore mouse pointer position if it moved during window operations
        this._restorePointerPosition(savedPointerX, savedPointerY);

        this._debugLog(`========== END MOVE WINDOW ==========\n`);
    }

    _connectSignals() {
        const monitorManager = global.backend.get_monitor_manager();
        const id1 = monitorManager.connect('monitors-changed', () => {
            console.log('[MultiMonitorsWorkspace] Monitors changed, reinitializing...');
            this._monitorWorkspaceMap.clear();
            this._initializeMapping();

            // Rebuild workspace indicator
            if (this._indicatorManager) {
                this._indicatorManager.rebuild(this._monitorWorkspaceMap);
            }
        });
        this._signalIds.push({ obj: monitorManager, id: id1 });

        // Listen for debug-mode setting changes
        const id2 = this._settings.connect('changed::debug-mode', () => {
            this._debugMode = this._settings.get_boolean('debug-mode');
            console.log(`[MultiMonitorsWorkspace] Debug mode: ${this._debugMode}`);
            if (this._debugMode) {
                this._initDebugLog();
                this._debugLog('=== Debug Mode Enabled ===');
                this._debugDumpState('Current State');
            }
        });
        this._signalIds.push({ obj: this._settings, id: id2 });

        // Listen for show-workspace-indicator setting changes
        const indicatorSettingId = this._settings.connect('changed::show-workspace-indicator', () => {
            const showIndicator = this._settings.get_boolean('show-workspace-indicator');
            console.log(`[MultiMonitorsWorkspace] Workspace indicator: ${showIndicator}`);
            if (showIndicator) {
                // Create indicator if not exists
                if (!this._indicatorManager) {
                    this._indicatorManager = new WorkspaceIndicatorManager();
                    this._indicatorManager.create(this._monitorWorkspaceMap);
                }
            } else {
                // Destroy indicator if exists
                if (this._indicatorManager) {
                    this._indicatorManager.destroy();
                    this._indicatorManager = null;
                }
            }
        });
        this._signalIds.push({ obj: this._settings, id: indicatorSettingId });

        // Listen for workspace-modifier setting changes
        const modifierSettingId = this._settings.connect('changed::workspace-modifier', () => {
            console.log('[MultiMonitorsWorkspace] Workspace modifier changed, updating keybindings...');
            // Unregister old keybindings
            this._unregisterKeybindings();
            // Update keybinding settings
            this._updateWorkspaceKeybindingSettings();
            // Re-register keybindings
            this._registerKeybindings();
        });
        this._signalIds.push({ obj: this._settings, id: modifierSettingId });

        // Listen for new window creation
        const id3 = global.display.connect('window-created', (display, window) => {
            this._onWindowCreated(window, 'window-created');
        });
        this._signalIds.push({ obj: global.display, id: id3 });

        // Also listen for window map (when window becomes visible)
        // This catches windows created by existing processes (e.g., Chrome)
        const id4 = global.window_manager.connect('map', (wm, windowActor) => {
            const window = windowActor.get_meta_window();
            if (window) {
                this._onWindowCreated(window, 'map');
            }
        });
        this._signalIds.push({ obj: global.window_manager, id: id4 });

        // Listen for session mode changes (screen lock/unlock)
        const id5 = Main.sessionMode.connect('updated', (session) => {
            this._onSessionModeChanged(session);
        });
        this._signalIds.push({ obj: Main.sessionMode, id: id5 });

        // Listen for focus window changes (for pointer warp feature)
        const focusId = global.display.connect('notify::focus-window', () => {
            this._onFocusWindowChanged();
        });
        this._signalIds.push({ obj: global.display, id: focusId });

        // Listen for workspace changes (to detect external WS changes from GNOME)
        const wsChangedId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._onSystemWorkspaceChanged();
        });
        this._signalIds.push({ obj: global.workspace_manager, id: wsChangedId });
    }

    // Handle focus window changes - ensure focus stays on current monitor
    _onFocusWindowChanged() {
        const focusWindow = global.display.get_focus_window();

        // Get current pointer position and monitor
        const pointerMonitor = this._getMonitorAtPointer();

        // If focus window exists, check if it's on a different monitor than pointer
        if (focusWindow) {
            const windowType = focusWindow.get_window_type();
            if (windowType === Meta.WindowType.NORMAL) {
                // Record last focused window for the workspace
                // Skip recording during internal switch operations to avoid corrupting saved state
                if (!this._isInternalSwitch) {
                    const windowMonitor = this._getWindowMonitor(focusWindow);
                    if (windowMonitor !== -1) {
                        const wsIndex = this._monitorWorkspaceMap.get(windowMonitor);
                        if (wsIndex !== undefined) {
                            const windowId = this._getWindowId(focusWindow);
                            this._lastWindowPerWorkspace.set(wsIndex, windowId);
                        }
                    }
                }
                const rect = focusWindow.get_frame_rect();
                const windowCenterX = rect.x + rect.width / 2;
                const windowCenterY = rect.y + rect.height / 2;

                // Determine which monitor the focus window is on
                let focusWindowMonitor = -1;
                const nMonitors = global.display.get_n_monitors();
                for (let i = 0; i < nMonitors; i++) {
                    const geo = global.display.get_monitor_geometry(i);
                    if (windowCenterX >= geo.x && windowCenterX < geo.x + geo.width &&
                        windowCenterY >= geo.y && windowCenterY < geo.y + geo.height) {
                        focusWindowMonitor = i;
                        break;
                    }
                }

                // If focus moved to a different monitor than pointer, correct it
                if (focusWindowMonitor !== -1 && focusWindowMonitor !== pointerMonitor) {
                    this._debugLog(`Focus moved to M${focusWindowMonitor} but pointer on M${pointerMonitor}, correcting...`);

                    // Skip if this window is pending placement
                    const windowId = this._getWindowId(focusWindow);
                    if (!this._windowsPendingPlacement.has(windowId)) {
                        // Try to focus a window on the pointer's monitor
                        const [pointerX, pointerY] = global.get_pointer();
                        this._focusWindowAtPosition(pointerX, pointerY, pointerMonitor);
                        return;
                    }
                }
            }
        }

        // warp-pointer-to-focus feature
        if (!this._settings.get_boolean('warp-pointer-to-focus')) {
            return;
        }

        if (!focusWindow) return;

        // Skip windows that are pending placement (we'll warp after placement is done)
        const windowId = this._getWindowId(focusWindow);
        if (this._windowsPendingPlacement.has(windowId)) {
            this._debugLog(`Skipping warp for pending window "${focusWindow.get_title()}"`);
            return;
        }

        // Skip non-normal windows (dialogs, menus, etc.)
        const windowType = focusWindow.get_window_type();
        if (windowType !== Meta.WindowType.NORMAL) return;

        // Get window frame rect
        const rect = focusWindow.get_frame_rect();

        // Get current pointer position
        const [pointerX, pointerY] = global.get_pointer();

        // Check if pointer is already inside the window
        if (pointerX >= rect.x && pointerX < rect.x + rect.width &&
            pointerY >= rect.y && pointerY < rect.y + rect.height) {
            // Pointer is inside window - likely mouse click focus change
            return;
        }

        // Warp pointer to window center
        const centerX = Math.floor(rect.x + rect.width / 2);
        const centerY = Math.floor(rect.y + rect.height / 2);

        const seat = Clutter.get_default_backend().get_default_seat();
        seat.warp_pointer(centerX, centerY);

        this._debugLog(`Warped pointer to (${centerX}, ${centerY}) for "${focusWindow.get_title()}"`);
    }

    // Handle external workspace changes from GNOME (default indicator, shortcuts, etc.)
    // Treat this as a workspace switch on the primary monitor
    _onSystemWorkspaceChanged() {
        // Skip if this is our own internal switch
        if (this._isInternalSwitch) {
            this._debugLog('System WS changed (internal - ignoring)');
            return;
        }

        const targetWs = global.workspace_manager.get_active_workspace_index();
        const primaryMonitor = global.display.get_primary_monitor();
        const previousWs = this._monitorWorkspaceMap.get(primaryMonitor) ?? 0;

        this._debugLog(`\n========== EXTERNAL WS CHANGE ==========`);
        this._debugLog(`Treating as primary switch: WS${previousWs} -> WS${targetWs}`);

        if (targetWs === previousWs) {
            this._debugLog('No change needed');
            return;
        }

        // Check if targetWs is already displayed on another monitor (SWAP case)
        const existingMonitor = this._getMonitorForWorkspace(targetWs);

        if (existingMonitor !== null && existingMonitor !== primaryMonitor) {
            // SWAP: reuse existing swap logic, but skip workspace.activate()
            this._debugLog(`Mode: SWAP (WS${targetWs} already on M${existingMonitor})`);
            this._performSwap(primaryMonitor, existingMonitor, previousWs, targetWs, true);
        } else {
            // SIMPLE SWITCH on primary
            // GNOME already changed WS, so we just need to save previousWs window positions
            this._debugLog(`Mode: SIMPLE SWITCH`);
            this._saveWorkspaceWindowPositions(primaryMonitor, previousWs);
            this._monitorWorkspaceMap.set(primaryMonitor, targetWs);
        }

        // Update workspace indicator
        if (this._indicatorManager) {
            this._indicatorManager.update(this._monitorWorkspaceMap);
        }

        this._debugDumpState('AFTER External WS Change');
        this._debugLog(`========== END EXTERNAL WS CHANGE ==========\n`);
    }

    // Save window positions for a specific workspace (used when external WS change occurs)
    _saveWorkspaceWindowPositions(monitorIndex, wsIndex) {
        const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
        const wsWindows = this._getWindowsOnWorkspace(wsIndex);

        this._debugLog(`  Saving positions for WS${wsIndex} windows (${wsWindows.length} found)`);

        for (const window of wsWindows) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();
            const relX = rect.x - monitorGeo.x;
            const relY = rect.y - monitorGeo.y;

            const windowId = this._getWindowId(window);
            this._savedWindowPositions.set(windowId, { relX, relY, wsIndex });
            this._debugLog(`    "${shortTitle}" saved rel(${relX},${relY})`);
        }
    }

    _onWindowCreated(window, source = 'unknown') {
        if (!window) return;

        // Avoid processing the same window twice (from both signals)
        const windowId = this._getWindowId(window);
        if (this._recentlyProcessedWindows?.has(windowId)) {
            return;
        }

        const title = window.get_title?.() ?? 'unknown';
        const windowType = window.get_window_type();
        const skipTaskbar = window.is_skip_taskbar();

        this._debugLog(`WINDOW CREATED [${source}]: "${title}" type=${windowType} skipTaskbar=${skipTaskbar}`);

        // Process NORMAL and DIALOG windows
        if (windowType !== Meta.WindowType.NORMAL && windowType !== Meta.WindowType.DIALOG) {
            this._debugLog(`WINDOW CREATED: "${title}" SKIPPED (type=${windowType})`);
            return;
        }
        if (skipTaskbar) {
            this._debugLog(`WINDOW CREATED: "${title}" SKIPPED (skip_taskbar)`);
            return;
        }

        // Mark as processed to avoid duplicates from both signals
        this._recentlyProcessedWindows.add(windowId);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._recentlyProcessedWindows.delete(windowId);
            return GLib.SOURCE_REMOVE;
        });

        // Capture pointer position NOW (before warp-pointer-to-focus can move it)
        const [capturedPointerX, capturedPointerY] = global.get_pointer();
        const targetMonitor = this._getMonitorAtPointer();

        this._debugLog(`WINDOW CREATED: Captured pointer at (${capturedPointerX},${capturedPointerY}) on M${targetMonitor}`);

        // Mark window as pending placement (suppresses warp-pointer-to-focus)
        this._windowsPendingPlacement.set(windowId, targetMonitor);

        // Delay to let the window initialize its position
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._moveWindowToMonitor(window, targetMonitor, windowId);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Move window to a specific monitor (used for new window placement)
    _moveWindowToMonitor(window, targetMonitor, windowId = null) {
        if (!window || window.is_destroyed?.()) {
            if (windowId) this._windowsPendingPlacement.delete(windowId);
            return;
        }

        const title = window.get_title?.() ?? 'unknown';
        const rect = window.get_frame_rect();

        // Get the logical workspace for the target monitor
        const logicalWs = this._monitorWorkspaceMap.get(targetMonitor) ?? 0;
        const currentGlobalWs = global.workspace_manager.get_active_workspace();
        const currentGlobalWsIndex = currentGlobalWs?.index() ?? 0;
        const primaryMonitor = global.display.get_primary_monitor();
        const targetGeo = global.display.get_monitor_geometry(targetMonitor);

        if (!targetGeo) {
            this._debugLog(`NEW WINDOW: "${title}" SKIPPED - invalid target monitor M${targetMonitor}`);
            return;
        }

        // Find which monitor the window is currently on
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const nMonitors = global.display.get_n_monitors();
        let sourceMonitor = -1;
        let sourceGeo = null;
        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            if (centerX >= geo.x && centerX < geo.x + geo.width &&
                centerY >= geo.y && centerY < geo.y + geo.height) {
                sourceMonitor = i;
                sourceGeo = geo;
                break;
            }
        }

        this._debugLog(`NEW WINDOW: "${title}" at (${rect.x},${rect.y}) on M${sourceMonitor}, target M${targetMonitor}`);

        // If already on target monitor, just set monitor assignment and workspace
        if (sourceMonitor === targetMonitor) {
            window.move_to_monitor(targetMonitor);
            if (targetMonitor === primaryMonitor) {
                const logicalWsObj = global.workspace_manager.get_workspace_by_index(logicalWs);
                if (logicalWsObj) {
                    window.change_workspace(logicalWsObj);
                }
            } else {
                window.change_workspace(currentGlobalWs);
            }
            this._debugLog(`NEW WINDOW: "${title}" already on M${targetMonitor}, assigned WS${targetMonitor === primaryMonitor ? logicalWs : currentGlobalWsIndex}`);
            // Use current position for pointer warp
            const warpX = Math.floor(rect.x + rect.width / 2);
            const warpY = Math.floor(rect.y + rect.height / 2);
            this._finishWindowPlacement(window, windowId, warpX, warpY);
            return;
        }

        // Calculate relative position within source monitor
        let relX, relY;
        if (sourceGeo) {
            relX = rect.x - sourceGeo.x;
            relY = rect.y - sourceGeo.y;
        } else {
            // Fallback: use absolute position modulo monitor size
            relX = rect.x % targetGeo.width;
            relY = rect.y % targetGeo.height;
        }

        // Move to target monitor (where pointer was when window was created)
        let newX = targetGeo.x + relX;
        let newY = targetGeo.y + relY;

        // Ensure window stays within monitor bounds
        newX = Math.max(targetGeo.x, Math.min(newX, targetGeo.x + targetGeo.width - rect.width));
        newY = Math.max(targetGeo.y, Math.min(newY, targetGeo.y + targetGeo.height - rect.height));

        // Move window to target monitor
        window.move_frame(false, newX, newY);

        // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
        window.move_to_monitor(targetMonitor);

        // Assign to correct workspace
        if (targetMonitor === primaryMonitor) {
            // Primary: assign to logical WS (which should be global WS)
            const logicalWsObj = global.workspace_manager.get_workspace_by_index(logicalWs);
            if (logicalWsObj) {
                window.change_workspace(logicalWsObj);
            }
        } else {
            // Secondary: assign to global WS to be visible
            window.change_workspace(currentGlobalWs);
        }

        this._debugLog(`NEW WINDOW: "${title}" moved to M${targetMonitor} at (${newX},${newY}), WS${targetMonitor === primaryMonitor ? logicalWs : currentGlobalWsIndex}`);

        // Remove from pending placement and warp pointer to calculated position
        const warpX = Math.floor(newX + rect.width / 2);
        const warpY = Math.floor(newY + rect.height / 2);
        this._finishWindowPlacement(window, windowId, warpX, warpY);
    }

    // Finish window placement: remove from pending, focus window, and warp pointer if needed
    _finishWindowPlacement(window, windowId, warpX, warpY) {
        // Remove from pending placement
        if (windowId) {
            this._windowsPendingPlacement.delete(windowId);
        }

        // Focus the newly created window
        if (window && !window.is_destroyed?.()) {
            const title = window.get_title?.() ?? 'unknown';
            window.activate(global.get_current_time());
            this._debugLog(`NEW WINDOW: Focused "${title}"`);
        }

        // Warp pointer to specified position if setting is enabled
        if (this._settings.get_boolean('warp-pointer-to-focus') && warpX !== undefined && warpY !== undefined) {
            const seat = Clutter.get_default_backend().get_default_seat();
            seat.warp_pointer(warpX, warpY);

            this._debugLog(`NEW WINDOW: Warped pointer to (${warpX},${warpY})`);
        }
    }

    // Handle session mode changes (screen lock/unlock)
    _onSessionModeChanged(session) {
        // Log all session mode changes for debugging
        console.log(`[MultiMonitorsWorkspace] Session mode changed: currentMode=${session.currentMode}, parentMode=${session.parentMode}`);
        this._debugLog(`Session mode changed: currentMode=${session.currentMode}, parentMode=${session.parentMode}`);

        // user mode = normal desktop (unlocked)
        if (session.currentMode === 'user' || session.parentMode === 'user') {
            this._debugLog('Session mode is user - refreshing secondary windows');
            console.log('[MultiMonitorsWorkspace] Screen unlocked, refreshing secondary windows...');
            // Delay to let GNOME's unlock processing complete
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._refreshSecondaryWindows();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Refresh windows on secondary monitors after screen unlock
    // Re-applies workspace membership and position/size to fix any inconsistencies
    _refreshSecondaryWindows() {
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const currentGlobalWs = global.workspace_manager.get_active_workspace();

        this._debugLog('Refreshing secondary monitor windows...');

        for (let monitorIndex = 0; monitorIndex < nMonitors; monitorIndex++) {
            if (monitorIndex === primaryMonitor) continue;

            const logicalWs = this._monitorWorkspaceMap.get(monitorIndex);
            if (logicalWs === undefined) continue;

            const windowsOnMonitor = this._getWindowsOnMonitor(monitorIndex);
            this._debugLog(`  M${monitorIndex} (WS${logicalWs}): ${windowsOnMonitor.length} windows`);

            for (const window of windowsOnMonitor) {
                const title = window.get_title?.() ?? 'unknown';
                const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
                const rect = window.get_frame_rect();

                // Ensure window is on global WS (makes it visible/sticky on secondary)
                window.change_workspace(currentGlobalWs);

                // Re-apply position and size
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

                // Delayed re-apply for tiling state preservation
                const w = window, x = rect.x, y = rect.y, width = rect.width, height = rect.height;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    if (!w.is_destroyed?.()) {
                        w.move_resize_frame(false, x, y, width, height);
                    }
                    return GLib.SOURCE_REMOVE;
                });

                this._debugLog(`    "${shortTitle}" refreshed at (${rect.x},${rect.y}) ${rect.width}x${rect.height}`);
            }
        }

        console.log('[MultiMonitorsWorkspace] Secondary windows refreshed');
    }

    // Restore windows that were saved before disable() back to their secondary monitors
    _restoreSavedSecondaryWindows() {
        if (!this._savedWindowsBeforeDisable || this._savedWindowsBeforeDisable.size === 0) {
            console.log('[MultiMonitorsWorkspace] No saved windows to restore');
            return;
        }

        console.log(`[MultiMonitorsWorkspace] Restoring ${this._savedWindowsBeforeDisable.size} saved windows...`);
        const currentGlobalWs = global.workspace_manager.get_active_workspace();

        for (const [windowId, info] of this._savedWindowsBeforeDisable) {
            const { monitorIndex, logicalWs, relX, relY, width, height, title } = info;

            // Find the window by ID
            const window = this._findWindowById(windowId);
            if (!window || window.is_destroyed?.()) {
                console.log(`[MultiMonitorsWorkspace] Window "${title}" not found, skipping`);
                continue;
            }

            const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
            if (!monitorGeo) {
                console.log(`[MultiMonitorsWorkspace] Monitor M${monitorIndex} not found, skipping "${title}"`);
                continue;
            }

            // Calculate target position on the secondary monitor
            const newX = monitorGeo.x + relX;
            const newY = monitorGeo.y + relY;

            // Move window to secondary monitor
            window.move_resize_frame(false, newX, newY, width, height);

            // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
            window.move_to_monitor(monitorIndex);

            // Assign to current global WS (makes it sticky/visible on secondary)
            window.change_workspace(currentGlobalWs);

            // Delayed re-apply for tiling state preservation and position correction
            const w = window, x = newX, y = newY, finalW = width, finalH = height;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!w.is_destroyed?.()) {
                    w.move_resize_frame(false, x, y, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            console.log(`[MultiMonitorsWorkspace] Restored "${title}" to M${monitorIndex} at (${newX},${newY}) ${width}x${height}`);
        }

        // Update monitor-workspace mappings based on saved info
        for (const [windowId, info] of this._savedWindowsBeforeDisable) {
            const { monitorIndex, logicalWs } = info;
            this._monitorWorkspaceMap.set(monitorIndex, logicalWs);
        }

        // Clear saved data after restore
        this._savedWindowsBeforeDisable.clear();
        console.log('[MultiMonitorsWorkspace] Saved windows restored');

        this._logMappings('After Restore');

        // Update workspace indicator with restored mappings
        if (this._indicatorManager) {
            this._indicatorManager.update(this._monitorWorkspaceMap);
        }
    }

    _disconnectSignals() {
        for (const s of this._signalIds) {
            try { s.obj.disconnect(s.id); } catch (e) {}
        }
        this._signalIds = [];
    }

    _switchWorkspace(targetWs) {
        // Save mouse pointer position before any window operations
        const [savedPointerX, savedPointerY] = global.get_pointer();

        // Get current monitor from mouse pointer position
        const currentMonitor = this._getMonitorAtPointer();
        const primaryMonitor = global.display.get_primary_monitor();
        const previousWs = this._monitorWorkspaceMap.get(currentMonitor) ?? 0;

        this._debugLog(`\n========== SWITCH REQUEST ==========`);
        this._debugLog(`Operation: M${currentMonitor} WS${previousWs} -> WS${targetWs} (primary=M${primaryMonitor})`);
        this._debugLog(`Saved pointer: (${savedPointerX}, ${savedPointerY})`);
        this._debugDumpState('BEFORE Switch');

        if (targetWs === previousWs) {
            this._debugLog('Result: No change (same workspace)');
            return;
        }

        // Ensure target workspace exists
        this._ensureWorkspaceExists(targetWs);

        // Check for swap: is targetWs already displayed on another monitor?
        const existingMonitor = this._getMonitorForWorkspace(targetWs);

        if (existingMonitor !== null && existingMonitor !== currentMonitor) {
            // Target WS is already on another monitor
            const switchMode = this._settings.get_string('workspace-switch-mode');

            if (switchMode === 'warp') {
                // Warp mode: just move pointer to the monitor showing target WS
                this._debugLog(`Mode: WARP (WS${targetWs} already on M${existingMonitor}, moving pointer there)`);
                this._warpPointerToMonitor(existingMonitor);

                // Update indicator to show new current monitor
                if (this._indicatorManager) {
                    this._indicatorManager.update(this._monitorWorkspaceMap);
                }

                // Show popup banner
                if (this._popupBanner) {
                    this._popupBanner.show(existingMonitor, targetWs);
                }

                this._debugLog(`========== END SWITCH (WARP) ==========\n`);
                return;
            }

            // Swap mode: exchange workspaces between monitors
            this._debugLog(`Mode: SWAP (WS${targetWs} already on M${existingMonitor})`);
            this._performSwap(currentMonitor, existingMonitor, previousWs, targetWs);
        } else {
            this._debugLog(`Mode: SIMPLE SWITCH`);

            if (currentMonitor === primaryMonitor) {
                // Primary monitor: change global WS
                this._simpleSwitch_Primary(currentMonitor, previousWs, targetWs);
            } else {
                // Secondary monitor: keep global WS, use WS membership to hide/show
                this._simpleSwitch_Secondary(currentMonitor, previousWs, targetWs);
            }

            this._monitorWorkspaceMap.set(currentMonitor, targetWs);
        }

        // Update workspace indicator
        if (this._indicatorManager) {
            this._indicatorManager.update(this._monitorWorkspaceMap);
        }

        // Show popup banner
        if (this._popupBanner) {
            this._popupBanner.show(currentMonitor, targetWs);
        }

        // Restore mouse pointer position if it moved during window operations
        this._restorePointerPosition(savedPointerX, savedPointerY);

        // Focus last focused window or window under pointer after workspace switch
        const focusTargetMonitor = currentMonitor;
        const focusTargetWs = targetWs;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            const [pointerX, pointerY] = global.get_pointer();
            this._focusLastOrAtPosition(focusTargetMonitor, focusTargetWs, pointerX, pointerY);

            // Update highlight overlays after focus change
            if (this._windowHighlighter) {
                this._windowHighlighter.update();
            }
            if (this._displayHighlighter) {
                this._displayHighlighter.update();
            }

            return GLib.SOURCE_REMOVE;
        });

        this._debugDumpState('AFTER Switch');
        this._debugLog(`========== END SWITCH ==========\n`);
    }

    // Restore mouse pointer to saved position if it has moved
    // Uses delayed execution to handle GNOME's async focus handling
    _restorePointerPosition(savedX, savedY) {
        // First immediate check and restore
        this._doPointerRestore(savedX, savedY, 'immediate');

        // Then delayed restore to handle GNOME's async focus changes
        // Multiple delays to catch different timing scenarios
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._doPointerRestore(savedX, savedY, 'delay-50ms');
            return GLib.SOURCE_REMOVE;
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._doPointerRestore(savedX, savedY, 'delay-150ms');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Activate workspace without animation
    _activateWorkspaceWithoutAnimation(workspace) {
        // Set flag to indicate this is an internal switch
        this._isInternalSwitch = true;

        if (!this._interfaceSettings) {
            workspace.activate(global.get_current_time());
            // Reset flag after a short delay (after signal handlers have processed)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._isInternalSwitch = false;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        // Save current animation state and disable
        const wasEnabled = this._interfaceSettings.get_boolean('enable-animations');
        if (wasEnabled) {
            this._interfaceSettings.set_boolean('enable-animations', false);
        }

        // Activate workspace
        workspace.activate(global.get_current_time());

        // Restore animation state after a short delay
        if (wasEnabled) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (this._interfaceSettings) {
                    this._interfaceSettings.set_boolean('enable-animations', true);
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        // Reset internal switch flag after signal handlers have processed
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._isInternalSwitch = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Actually perform the pointer restore
    _doPointerRestore(savedX, savedY, phase) {
        const [currentX, currentY] = global.get_pointer();

        // Only restore if pointer has moved significantly (more than 5 pixels)
        const dx = Math.abs(currentX - savedX);
        const dy = Math.abs(currentY - savedY);

        if (dx > 5 || dy > 5) {
            const seat = Clutter.get_default_backend().get_default_seat();
            seat.warp_pointer(savedX, savedY);
            this._debugLog(`Pointer restore [${phase}]: (${currentX},${currentY}) -> (${savedX},${savedY})`);
        }
    }

    // Primary monitor simple switch: change global workspace
    // skipActivate: true when called from external WS change (GNOME already activated)
    _simpleSwitch_Primary(monitorIndex, previousWs, targetWs, skipActivate = false) {
        this._debugLog(`PRIMARY SWITCH: M${monitorIndex} WS${previousWs} -> WS${targetWs}${skipActivate ? ' (external)' : ''}`);

        const monitorGeo = global.display.get_monitor_geometry(monitorIndex);

        // Get windows currently on this monitor
        const windowsOnMonitor = this._getWindowsOnMonitor(monitorIndex);

        // Move current windows to previousWs (they will be hidden when global WS changes)
        const previousWsObj = global.workspace_manager.get_workspace_by_index(previousWs);
        for (const window of windowsOnMonitor) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();
            const relX = rect.x - monitorGeo.x;
            const relY = rect.y - monitorGeo.y;

            // Save position for later restoration
            const windowId = this._getWindowId(window);
            this._savedWindowPositions.set(windowId, { relX, relY, wsIndex: previousWs });

            // Assign to previousWs (will be hidden when global WS changes to targetWs)
            window.change_workspace(previousWsObj);
            this._debugLog(`  -> "${shortTitle}" assigned to WS${previousWs}, saved rel(${relX},${relY})`);
        }

        // Load windows from targetWs
        const targetWsWindows = this._getWindowsOnWorkspace(targetWs);
        const targetWsObj = global.workspace_manager.get_workspace_by_index(targetWs);

        for (const window of targetWsWindows) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;

            const windowId = this._getWindowId(window);
            const savedPos = this._savedWindowPositions.get(windowId);

            let newX, newY;
            if (savedPos && savedPos.wsIndex === targetWs) {
                newX = monitorGeo.x + savedPos.relX;
                newY = monitorGeo.y + savedPos.relY;
                this._savedWindowPositions.delete(windowId);
            } else {
                // Default position
                newX = monitorGeo.x + Math.floor(monitorGeo.width / 4);
                newY = monitorGeo.y + Math.floor(monitorGeo.height / 4);
            }

            // Move window to target position (will be visible after global WS change)
            window.move_frame(false, newX, newY);
            this._debugLog(`  <- "${shortTitle}" from WS${targetWs} to (${newX},${newY})`);
        }

        // Change global workspace to targetWs (without animation)
        // Skip if called from external WS change (GNOME already activated)
        if (!skipActivate) {
            this._debugLog(`  Activating global WS${targetWs}`);
            this._activateWorkspaceWithoutAnimation(targetWsObj);
        }
    }

    // Secondary monitor simple switch: coordinate-based (workspaces-only-on-primary mode)
    // In this mode, secondary monitor windows are automatically sticky (WS=-1),
    // but we track which WS each monitor displays via _monitorWorkspaceMap.
    // Switch = move current windows back to primary, then bring targetWs windows here.
    _simpleSwitch_Secondary(monitorIndex, previousWs, targetWs) {
        this._debugLog(`SECONDARY SWITCH: M${monitorIndex} WS${previousWs} -> WS${targetWs}`);

        const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
        const primaryMonitor = global.display.get_primary_monitor();
        const primaryGeo = global.display.get_monitor_geometry(primaryMonitor);

        // Step 1: Move current windows on this secondary back to primary
        // These windows belong to previousWs (even if their WS attribute is -1/sticky)
        const windowsOnMonitor = this._getWindowsOnMonitor(monitorIndex);

        this._debugLog(`  Step1: Moving ${windowsOnMonitor.length} windows from M${monitorIndex} back to primary M${primaryMonitor}`);
        for (const window of windowsOnMonitor) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();
            const relX = rect.x - monitorGeo.x;
            const relY = rect.y - monitorGeo.y;

            // Move to primary monitor (relative position and size preserved)
            const newX = primaryGeo.x + relX;
            const newY = primaryGeo.y + relY;
            const width = rect.width;
            const height = rect.height;
            window.move_resize_frame(false, newX, newY, width, height);

            // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
            window.move_to_monitor(primaryMonitor);

            // Re-apply size after a short delay (GNOME may reset size when untiling)
            const w = window, finalW = width, finalH = height, finalX = newX, finalY = newY;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!w.is_destroyed?.()) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Assign to previousWs so it will be hidden (global WS is different)
            const previousWsObj = global.workspace_manager.get_workspace_by_index(previousWs);
            if (previousWsObj) {
                window.change_workspace(previousWsObj);
            }

            this._debugLog(`  -> "${shortTitle}" moved to primary (${newX},${newY}) size ${width}x${height}, assigned to WS${previousWs}`);
        }

        // Step 2: Bring windows from targetWs to this secondary monitor
        // Look for windows on PRIMARY that belong to targetWs
        // IMPORTANT: Include hidden windows since targetWs may not be the current global WS
        const primaryWindows = this._getWindowsOnMonitor(primaryMonitor, true);
        const targetWsObj = global.workspace_manager.get_workspace_by_index(targetWs);
        const currentGlobalWs = global.workspace_manager.get_active_workspace();

        // Filter to only windows that belong to targetWs
        const targetWsWindows = primaryWindows.filter(w => {
            const ws = w.get_workspace();
            return ws && ws.index() === targetWs;
        });

        this._debugLog(`  Step2: Moving ${targetWsWindows.length} windows from primary (WS${targetWs}) to M${monitorIndex}`);
        for (const window of targetWsWindows) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();

            // Calculate relative position from primary
            const relX = rect.x - primaryGeo.x;
            const relY = rect.y - primaryGeo.y;

            // Move to this secondary monitor (preserve size)
            const newX = monitorGeo.x + relX;
            const newY = monitorGeo.y + relY;
            const width = rect.width;
            const height = rect.height;
            window.move_resize_frame(false, newX, newY, width, height);

            // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
            window.move_to_monitor(monitorIndex);

            // Re-apply size after a short delay (GNOME may reset size when untiling)
            const w = window, finalW = width, finalH = height, finalX = newX, finalY = newY;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!w.is_destroyed?.()) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Assign to current global WS so it becomes visible (sticky on secondary)
            window.change_workspace(currentGlobalWs);

            this._debugLog(`  <- "${shortTitle}" moved to M${monitorIndex} (${newX},${newY}) size ${width}x${height}, assigned to global WS`);
        }
    }

    // Find a window by its stable ID
    _findWindowById(windowId) {
        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window();
            if (!window) continue;
            if (this._getWindowId(window) === windowId) {
                return window;
            }
        }
        return null;
    }

    _getMonitorForWorkspace(ws) {
        for (const [m, w] of this._monitorWorkspaceMap) {
            if (w === ws) return m;
        }
        return null;
    }

    // Get the monitor index where the window is currently located (by coordinates)
    _getWindowMonitor(window) {
        if (!window) return -1;

        const rect = window.get_frame_rect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const nMonitors = global.display.get_n_monitors();

        for (let i = 0; i < nMonitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            if (centerX >= geo.x && centerX < geo.x + geo.width &&
                centerY >= geo.y && centerY < geo.y + geo.height) {
                return i;
            }
        }
        return -1;
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

        this._debugLog(`WARNING: Pointer (${pointerX},${pointerY}) not on any monitor, using primary`);
        return global.display.get_primary_monitor();
    }

    // Get all normal windows currently on a specific monitor (by coordinate)
    // Note: We intentionally do NOT filter sticky windows here because GNOME
    // sometimes makes windows sticky when moving across monitors
    // Set includeHidden=true to include hidden windows (useful for SWAP operations)
    _getWindowsOnMonitor(monitorIndex, includeHidden = false) {
        const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
        const windows = [];

        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window();
            if (!window) continue;
            if (window.is_skip_taskbar()) continue;
            if (window.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (!includeHidden && window.is_hidden()) continue;

            const rect = window.get_frame_rect();
            // Check if window center is within this monitor
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;

            if (centerX >= monitorGeo.x && centerX < monitorGeo.x + monitorGeo.width &&
                centerY >= monitorGeo.y && centerY < monitorGeo.y + monitorGeo.height) {
                windows.push(window);
            }
        }

        return windows;
    }

    // Get all windows on a specific workspace
    _getWindowsOnWorkspace(wsIndex) {
        const workspace = global.workspace_manager.get_workspace_by_index(wsIndex);
        if (!workspace) return [];

        return global.get_window_actors()
            .map(a => a.get_meta_window())
            .filter(w => {
                if (!w) return false;
                if (w.is_skip_taskbar()) return false;
                if (w.get_window_type() !== Meta.WindowType.NORMAL) return false;
                // Skip sticky windows (on all workspaces, ws=-1)
                if (w.is_on_all_workspaces()) return false;
                return w.get_workspace() === workspace;
            });
    }

    // Get stable window ID for position tracking
    _getWindowId(window) {
        // Prefer stable_sequence as it's consistent across the window's lifetime
        if (window.get_stable_sequence) {
            return `seq_${window.get_stable_sequence()}`;
        }
        // Fallback to window ID
        if (window.get_id) {
            return `id_${window.get_id()}`;
        }
        // Last resort: use title (less reliable)
        return `title_${window.get_title?.() ?? 'unknown'}`;
    }

    // Save windows currently on monitor to a workspace (move them there)
    // Stores relative position and minimizes windows to hide them
    _saveMonitorWindowsToWorkspace(monitorIndex, wsIndex) {
        const windows = this._getWindowsOnMonitor(monitorIndex);
        const targetWs = global.workspace_manager.get_workspace_by_index(wsIndex);

        if (!targetWs) {
            this._debugLog(`SAVE: Cannot save to WS${wsIndex}, doesn't exist`);
            return;
        }

        const sourceGeo = global.display.get_monitor_geometry(monitorIndex);

        this._debugLog(`SAVE: ${windows.length} windows from M${monitorIndex} to WS${wsIndex}`);

        for (const window of windows) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();
            const oldWs = window.get_workspace()?.index() ?? -1;

            // Store relative position within the source monitor
            const relX = rect.x - sourceGeo.x;
            const relY = rect.y - sourceGeo.y;
            const windowId = this._getWindowId(window);
            this._savedWindowPositions.set(windowId, { relX, relY, wsIndex, wasMinimized: window.minimized });

            // Move to target workspace and minimize to ensure it's hidden
            window.change_workspace(targetWs);
            if (!window.minimized) {
                window.minimize();
            }

            this._debugLog(`  SAVE: "${shortTitle}" WS${oldWs}->${wsIndex} (${rect.x},${rect.y})->MINIMIZED, saved rel(${relX},${relY})`);
        }
    }

    // Load windows from a workspace to a monitor (move them to current WS and position)
    // Uses saved relative positions to restore windows correctly
    _loadWorkspaceWindowsToMonitor(monitorIndex, wsIndex) {
        const windows = this._getWindowsOnWorkspace(wsIndex);
        const currentGlobalWs = global.workspace_manager.get_active_workspace();
        const currentGlobalWsIndex = currentGlobalWs?.index() ?? 0;
        const targetGeo = global.display.get_monitor_geometry(monitorIndex);

        this._debugLog(`LOAD: ${windows.length} windows from WS${wsIndex} to M${monitorIndex} (global WS${currentGlobalWsIndex})`);

        for (const window of windows) {
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const rect = window.get_frame_rect();
            const oldWs = window.get_workspace()?.index() ?? -1;

            // Get saved relative position
            const windowId = this._getWindowId(window);
            const savedPos = this._savedWindowPositions.get(windowId);

            let relX, relY;
            let wasMinimized = false;
            if (savedPos) {
                relX = savedPos.relX;
                relY = savedPos.relY;
                wasMinimized = savedPos.wasMinimized || false;
                this._savedWindowPositions.delete(windowId); // Clean up after use
            } else {
                // Fallback: use default position (center of monitor)
                relX = Math.floor(targetGeo.width / 4);
                relY = Math.floor(targetGeo.height / 4);
                this._debugLog(`  LOAD: "${shortTitle}" no saved position, using default`);
            }

            // Move to active workspace
            if (oldWs !== currentGlobalWsIndex) {
                window.change_workspace(currentGlobalWs);
                this._debugLog(`  LOAD: "${shortTitle}" WS${oldWs}->WS${currentGlobalWsIndex}`);
            }

            // Calculate absolute position on target monitor
            const newX = targetGeo.x + relX;
            const newY = targetGeo.y + relY;

            window.move_frame(false, newX, newY);

            // Unminimize if it was minimized by SAVE (not originally minimized)
            if (window.minimized && !wasMinimized) {
                window.unminimize();
            }

            this._debugLog(`  LOAD: "${shortTitle}" rel(${relX},${relY})->(${newX},${newY}) on M${monitorIndex}`);
        }
    }

    _performSwap(monitor1, monitor2, ws1, ws2, skipActivate = false) {
        // monitor1 (current) wants to show ws2 (currently on monitor2)
        // monitor2 will show ws1 (currently on monitor1)
        // After swap: M1 displays ws2, M2 displays ws1
        //
        // workspaces-only-on-primary mode:
        // - Secondary monitor windows are automatically STICKY
        // - Only call change_workspace() when moving TO primary display
        // - When moving TO secondary, just move coordinates (no WS change)
        //
        // skipActivate: true when called from external WS change (GNOME already activated)
        const primaryMonitor = global.display.get_primary_monitor();

        this._debugLog(`SWAP: M${monitor1}(WS${ws1}) <-> M${monitor2}(WS${ws2}), primary=M${primaryMonitor}`);

        // Collect windows from both monitors (by coordinate)
        const windows1 = this._getWindowsOnMonitor(monitor1);
        const windows2 = this._getWindowsOnMonitor(monitor2);

        const geo1 = global.display.get_monitor_geometry(monitor1);
        const geo2 = global.display.get_monitor_geometry(monitor2);

        this._debugLog(`SWAP: M${monitor1} has ${windows1.length} windows, M${monitor2} has ${windows2.length} windows`);

        // Collect window info before modifying (relative positions and size within each monitor)
        const info1 = windows1.map(w => {
            const rect = w.get_frame_rect();
            return {
                window: w,
                relX: rect.x - geo1.x,
                relY: rect.y - geo1.y,
                width: rect.width,
                height: rect.height,
                title: w.get_title?.() ?? 'unknown'
            };
        });
        const info2 = windows2.map(w => {
            const rect = w.get_frame_rect();
            return {
                window: w,
                relX: rect.x - geo2.x,
                relY: rect.y - geo2.y,
                width: rect.width,
                height: rect.height,
                title: w.get_title?.() ?? 'unknown'
            };
        });

        // Determine if we need to change global WS (only if primary is involved)
        const primaryInvolved = (monitor1 === primaryMonitor || monitor2 === primaryMonitor);
        let newGlobalWs;
        let newGlobalWsObj = null;

        if (primaryInvolved) {
            if (monitor1 === primaryMonitor) {
                // Primary (monitor1) will show ws2 after swap
                newGlobalWs = ws2;
            } else {
                // Primary (monitor2) will show ws1 after swap
                newGlobalWs = ws1;
            }
            newGlobalWsObj = global.workspace_manager.get_workspace_by_index(newGlobalWs);
            this._debugLog(`SWAP: Primary involved, will change global WS to ${newGlobalWs}`);
        } else {
            // Neither is primary, no global WS change needed
            newGlobalWs = global.workspace_manager.get_active_workspace_index();
            this._debugLog(`SWAP: Neither monitor is primary, keeping global WS${newGlobalWs}`);
        }

        // Move windows from M1 -> M2
        // These windows were on ws1, M2 will display ws1 after swap
        this._debugLog(`SWAP: Moving M${monitor1} windows -> M${monitor2} (M2 will show WS${ws1})`);
        for (const { window, relX, relY, width, height, title } of info1) {
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;

            // Calculate new position on M2 (preserve size)
            const newX = geo2.x + relX;
            const newY = geo2.y + relY;
            window.move_resize_frame(false, newX, newY, width, height);

            // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
            window.move_to_monitor(monitor2);

            // Re-apply size after a short delay (GNOME may reset size when untiling)
            const w = window, finalW = width, finalH = height, finalX = newX, finalY = newY;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!w.is_destroyed?.()) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Only change WS when moving TO primary
            if (monitor2 === primaryMonitor && newGlobalWsObj) {
                window.change_workspace(newGlobalWsObj);
                this._debugLog(`  "${shortTitle}" -> M${monitor2}(PRIMARY) at (${newX},${newY}) ${width}x${height}, WS changed to ${newGlobalWs}`);
            } else {
                // Moving to secondary: no WS change needed (windows are sticky in this mode)
                this._debugLog(`  "${shortTitle}" -> M${monitor2}(secondary) at (${newX},${newY}) ${width}x${height}, no WS change`);
            }
        }

        // Move windows from M2 -> M1
        // These windows were on ws2, M1 will display ws2 after swap
        this._debugLog(`SWAP: Moving M${monitor2} windows -> M${monitor1} (M1 will show WS${ws2})`);
        for (const { window, relX, relY, width, height, title } of info2) {
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;

            // Calculate new position on M1 (preserve size)
            const newX = geo1.x + relX;
            const newY = geo1.y + relY;
            window.move_resize_frame(false, newX, newY, width, height);

            // Explicitly set monitor assignment (fixes maximize on wrong monitor issue)
            window.move_to_monitor(monitor1);

            // Re-apply size after a short delay (GNOME may reset size when untiling)
            const w = window, finalW = width, finalH = height, finalX = newX, finalY = newY;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!w.is_destroyed?.()) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Only change WS when moving TO primary
            if (monitor1 === primaryMonitor && newGlobalWsObj) {
                window.change_workspace(newGlobalWsObj);
                this._debugLog(`  "${shortTitle}" -> M${monitor1}(PRIMARY) at (${newX},${newY}) ${width}x${height}, WS changed to ${newGlobalWs}`);
            } else {
                // Moving to secondary: no WS change needed (windows are sticky in this mode)
                this._debugLog(`  "${shortTitle}" -> M${monitor1}(secondary) at (${newX},${newY}) ${width}x${height}, no WS change`);
            }
        }

        // Change global workspace only if primary is involved (without animation)
        // Skip if called from external WS change (GNOME already activated)
        if (primaryInvolved && newGlobalWsObj && !skipActivate) {
            this._debugLog(`SWAP: Activating global WS${newGlobalWs}`);
            this._activateWorkspaceWithoutAnimation(newGlobalWsObj);
        }

        // Update mappings (swap the workspace assignments)
        this._monitorWorkspaceMap.set(monitor1, ws2);
        this._monitorWorkspaceMap.set(monitor2, ws1);
        this._debugLog(`SWAP Complete: M${monitor1}->WS${ws2}, M${monitor2}->WS${ws1}`);
    }

    _ensureWorkspaceExists(wsIndex) {
        const wsManager = global.workspace_manager;
        while (wsManager.get_n_workspaces() <= wsIndex) {
            wsManager.append_new_workspace(false, global.get_current_time());
        }
    }

    _logMappings(label) {
        const mappings = [];
        for (const [m, w] of this._monitorWorkspaceMap) {
            mappings.push(`M${m}:WS${w}`);
        }
        console.log(`[MultiMonitorsWorkspace] ${label} mappings: [${mappings.join(', ')}]`);
    }

    _showOsd(monitorIndex, wsIndex) {
        this._hideOsd();

        const monitorGeometry = global.display.get_monitor_geometry(monitorIndex);
        const isPrimary = monitorIndex === global.display.get_primary_monitor();

        this._osdLabel = new St.Label({
            style_class: 'osd-window',
            style: 'font-size: 32px; padding: 16px 24px; background-color: rgba(0,0,0,0.8); border-radius: 8px;',
            text: `M${monitorIndex} → WS${wsIndex}${isPrimary ? ' (Primary)' : ''}`,
        });

        Main.uiGroup.add_child(this._osdLabel);

        const labelWidth = this._osdLabel.get_width();
        const labelHeight = this._osdLabel.get_height();
        this._osdLabel.set_position(
            monitorGeometry.x + Math.floor((monitorGeometry.width - labelWidth) / 2),
            monitorGeometry.y + Math.floor((monitorGeometry.height - labelHeight) / 2)
        );

        this._osdTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._hideOsd();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideOsd() {
        if (this._osdTimeoutId) {
            GLib.source_remove(this._osdTimeoutId);
            this._osdTimeoutId = null;
        }
        if (this._osdLabel) {
            Main.uiGroup.remove_child(this._osdLabel);
            this._osdLabel.destroy();
            this._osdLabel = null;
        }
    }

    // ========== Debug Logging ==========

    _initDebugLog() {
        try {
            // Clear previous log file
            GLib.file_set_contents(DEBUG_LOG_PATH, '');
            this._debugLog(`Debug log initialized at ${new Date().toISOString()}`);
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to init debug log:', e);
        }
    }

    _debugLog(message) {
        if (!this._debugMode) return;

        const timestamp = new Date().toISOString().slice(11, 23);
        const line = `[${timestamp}] ${message}\n`;
        try {
            const file = Gio.File.new_for_path(DEBUG_LOG_PATH);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(line, null);
            stream.close(null);
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Debug log write failed:', e);
        }
        // Also output to journal
        console.log(`[MMW-DEBUG] ${message}`);
    }

    _debugDumpState(label) {
        this._debugLog(`--- ${label} ---`);

        // Current monitor (mouse position)
        const [pointerX, pointerY] = global.get_pointer();
        const currentMonitor = this._getMonitorAtPointer();
        this._debugLog(`Current: M${currentMonitor} (pointer at ${pointerX},${pointerY})`);

        // Monitor -> Workspace mappings
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const mappings = [];
        for (let i = 0; i < nMonitors; i++) {
            const ws = this._monitorWorkspaceMap.get(i) ?? '?';
            const geo = global.display.get_monitor_geometry(i);
            const primary = i === primaryMonitor ? '*' : '';
            mappings.push(`M${i}${primary}:WS${ws}(${geo.x},${geo.y})`);
        }
        this._debugLog(`Mappings: [${mappings.join(', ')}]`);

        // All windows with their WS and coordinates
        this._debugLog('Windows:');
        let winCount = 0;
        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window();
            if (!window) continue;
            if (window.is_skip_taskbar()) continue;
            if (window.get_window_type() !== Meta.WindowType.NORMAL) continue;

            winCount++;
            const title = window.get_title?.() ?? 'unknown';
            const shortTitle = title.length > 20 ? title.slice(0, 20) + '...' : title;
            const wsIndex = window.get_workspace()?.index() ?? -1;
            const sticky = window.is_on_all_workspaces() ? '[STICKY]' : '';
            const hidden = window.is_hidden() ? '[HIDDEN]' : '';
            const rect = window.get_frame_rect();

            // Determine which monitor the window is on (by coordinate)
            let onMonitor = '?';
            for (let m = 0; m < nMonitors; m++) {
                const geo = global.display.get_monitor_geometry(m);
                const centerX = rect.x + rect.width / 2;
                const centerY = rect.y + rect.height / 2;
                if (centerX >= geo.x && centerX < geo.x + geo.width &&
                    centerY >= geo.y && centerY < geo.y + geo.height) {
                    onMonitor = `M${m}`;
                    break;
                }
            }

            this._debugLog(`  W${winCount}: "${shortTitle}" WS${wsIndex} ${sticky}${hidden} @(${rect.x},${rect.y}) on ${onMonitor}`);
        }
        if (winCount === 0) {
            this._debugLog('  (no windows)');
        }
        this._debugLog('---');
    }
}
