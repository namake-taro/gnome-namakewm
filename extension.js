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
import { WallpaperOverlayManager } from './lib/wallpaperOverlay.js';

// System keybinding schema
const WM_KEYBINDINGS_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const WM_PREFERENCES_SCHEMA = 'org.gnome.desktop.wm.preferences';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const MUTTER_SCHEMA = 'org.gnome.mutter';

// Debug log file
const DEBUG_LOG_PATH = '/tmp/mmw-debug.log';

// Off-screen coordinate for hiding windows
const OFFSCREEN_X = -20000;
const OFFSCREEN_Y = -20000;

// Directions for relative (neighbouring) monitor navigation
const ADJACENT_DIRECTIONS = ['left', 'right', 'up', 'down'];

// How long after enable() a rule with scope "startup" still counts as
// autostart placement. Autostarted apps appear within the first seconds of the
// session, so this only needs to cover the login burst - keeping it short means
// an app you open yourself later is not dragged away unexpectedly.
const APP_RULE_STARTUP_SECONDS = 30;

// Valid values for the "scope" field of an app-workspace-map entry
const APP_RULE_SCOPES = ['startup', 'always'];

// The keys a WM_CLASS is looked up under, most specific first: the string
// itself, lowercased, then the part after the last dot.
//
// The second key is what makes an app id usable as a rule. A GApplication-based
// app - every modern GNOME app - reports its app id as WM_CLASS, so a rule
// configured from the desktop file says "org.gnome.Nautilus" while a window may
// equally report the bare "nautilus" (that is what the program name gives you).
// Accepting both spellings means the rule works either way, and the desktop
// entry no longer has to be guessed exactly right.
function wmClassLookupKeys(wmClass) {
    const keys = [wmClass.toLowerCase()];
    const lastDot = wmClass.lastIndexOf('.');
    if (lastDot > 0 && lastDot < wmClass.length - 1) {
        keys.push(wmClass.slice(lastDot + 1).toLowerCase());
    }
    return keys;
}

export default class MultiMonitorsWorkspaceExtension extends Extension {
    _settings = null;
    _wmSettings = null;
    _wmPreferences = null;
    _interfaceSettings = null;
    _mutterSettings = null;
    _debugMode = false;

    // monitorIndex -> workspaceIndex (which WS each monitor is displaying)
    _monitorWorkspaceMap = new Map();

    // wmClass (lowercased) -> { workspace, scope } from app-workspace-map
    _appWorkspaceMap = new Map();

    // windowId -> { relX, relY } (relative position within monitor for hidden windows)
    _savedWindowPositions = new Map();

    // Track recently processed windows to avoid duplicates
    _recentlyProcessedWindows = new Set();

    // Track windows pending placement (to suppress warp-pointer-to-focus)
    // Key: windowId, Value: targetMonitor
    _windowsPendingPlacement = new Map();

    // Saved mapping before disable (for restore after enable)
    // Key: monitorIndex, Value: logicalWs
    _savedMappingBeforeDisable = new Map();

    // Windows already handled by an app-workspace rule, so a rule is applied
    // at most once per window. This is what keeps the login sweep from pulling
    // a window back after the user has deliberately moved it somewhere else.
    // Key: windowId
    _rulePlacedWindows = new Set();

    // Windows a rule has seen go away, filled from the window's own "unmanaged"
    // signal. Deferred work on a rule window has to be able to tell "the window
    // is not on screen yet" from "the window is gone", and _isWindowAlive()
    // cannot: check_alive() also answers false for a window that has not drawn
    // a buffer yet, which is exactly the state an autostarted app is in while
    // the rule is still placing it.
    // Key: windowId
    _unmanagedRuleWindows = new Set();

    // Monotonic deadline after which scope "startup" rules stop applying.
    _startupDeadline = 0;

    // Workspace a window is currently being bound to, used to let a newer
    // request cancel an older one that is still retrying. See
    // _bindWindowToWorkspace().
    // Key: windowId, Value: workspace index
    _pendingWsBindings = new Map();

    // Track last focused window per workspace (for focus restoration)
    // Key: wsIndex, Value: windowId
    _lastWindowPerWorkspace = new Map();

    _signalIds = [];
    _osdLabel = null;
    _osdTimeoutId = null;

    // Flag to distinguish internal vs external workspace changes
    _isInternalSwitch = false;

    // Suppresses the "focus is on another monitor than the pointer" guard in
    // _onFocusWindowChanged. Set while we deliberately jump to a neighbouring
    // monitor: the pointer warp is not visible to global.get_pointer() yet
    // when the focus notification arrives, so the guard would pull the focus
    // straight back and cancel the jump.
    _suppressFocusMonitorGuard = false;
    _suppressFocusGuardTimeoutId = null;

    // Workspace indicator
    _indicatorManager = null;

    // Highlight overlays
    _windowHighlighter = null;
    _displayHighlighter = null;

    // Popup banner for workspace/display changes
    _popupBanner = null;

    // Wallpaper overlay manager for per-workspace wallpapers
    _wallpaperManager = null;

    // Timer management for defensive cleanup
    _pendingTimeoutIds = new Set();
    _pointerRestoreTimeoutIds = [];
    _focusRestoreTimeoutId = null;
    _internalSwitchTimeoutId = null;
    _animationRestoreTimeoutId = null;
    _restoreWindowsTimeoutId = null;

    enable() {
        console.log('[MultiMonitorsWorkspace] Enabling extension...');

        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({ schema_id: WM_KEYBINDINGS_SCHEMA });
        this._wmPreferences = new Gio.Settings({ schema_id: WM_PREFERENCES_SCHEMA });
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
        this._applyFocusMode();
        this._initializeMapping();
        this._registerKeybindings();

        // App placement rules. The deadline has to be set before any signal is
        // connected, otherwise a window created in between would be judged
        // against a deadline of 0 and every "startup" rule would already look
        // expired.
        this._appWorkspaceMap = this._readAppWorkspaceMap();
        this._startupDeadline =
            GLib.get_monotonic_time() + APP_RULE_STARTUP_SECONDS * GLib.USEC_PER_SEC;
        this._debugLog(`App workspace rules: ${this._appWorkspaceMap.size}, ` +
            `startup rules valid for ${APP_RULE_STARTUP_SECONDS}s`);

        this._connectSignals();

        this._debugLog('=== Extension Enabled ===');
        this._debugDumpState('Initial State');

        // Create workspace indicator in top bar (if enabled in settings)
        if (this._settings.get_boolean('show-workspace-indicator')) {
            this._indicatorManager = new WorkspaceIndicatorManager(this.metadata.uuid, this._settings.get_boolean('flat-panel-indicator'));
            this._indicatorManager.create(this._monitorWorkspaceMap);
        }

        // Create highlight overlays
        this._windowHighlighter = new WindowHighlighter(this._settings);
        this._displayHighlighter = new DisplayHighlighter(this._settings);

        // Create popup banner
        this._popupBanner = new PopupBanner(this._settings);

        // Create wallpaper overlay manager (always create for settings monitoring)
        console.log('[MultiMonitorsWorkspace] Creating WallpaperOverlayManager');
        this._wallpaperManager = new WallpaperOverlayManager(this._settings);
        const wallpapersEnabled = this._settings.get_boolean('enable-workspace-wallpapers');
        console.log(`[MultiMonitorsWorkspace] Workspace wallpapers enabled: ${wallpapersEnabled}`);
        if (wallpapersEnabled) {
            this._wallpaperManager.enable();
            this._wallpaperManager.update(this._monitorWorkspaceMap);
        }

        console.log('[MultiMonitorsWorkspace] Extension enabled successfully');

        // Catch windows that were mapped before the signals above existed.
        // Autostarted apps are launched in parallel to the shell coming up, so
        // some of them are simply never seen by window-created. Without this
        // sweep they would stay on the workspace Mutter gave them - WS1.
        //
        // Spread over the whole startup window rather than run once: on a slow
        // login a tray app may only show its window several seconds in, and a
        // single early pass would miss it. Windows already handled are skipped,
        // so repeating is harmless.
        if (this._appWorkspaceMap.size > 0) {
            for (const delay of [1500, 5000, 12000, 22000]) {
                this._addManagedTimeout(delay, () => {
                    this._sweepExistingWindows(`enable+${delay}ms`);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        // Restore secondary windows after a delay
        // This handles re-enable after screen unlock
        if (this._savedMappingBeforeDisable && this._savedMappingBeforeDisable.size > 0) {
            console.log('[MultiMonitorsWorkspace] Will restore secondary windows from saved mapping');
            this._restoreWindowsTimeoutId = this._addManagedTimeout(500, () => {
                this._restoreWindowsTimeoutId = null;
                this._restoreSecondaryWindowsFromMapping();
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
        this._restoreFocusMode();
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

        // Destroy wallpaper overlay manager
        if (this._wallpaperManager) {
            this._wallpaperManager.destroy();
            this._wallpaperManager = null;
        }

        // Clear all managed timeouts before nullifying settings
        this._clearAllManagedTimeouts();

        // Note: Do NOT clear _monitorWorkspaceMap - it's copied to _savedMappingBeforeDisable for restore
        // Note: Do NOT clear _savedWindowPositions - it's needed for correct window placement after unlock
        this._recentlyProcessedWindows.clear();
        this._windowsPendingPlacement.clear();
        this._rulePlacedWindows.clear();
        this._unmanagedRuleWindows.clear();
        this._pendingWsBindings.clear();
        this._appWorkspaceMap = new Map();
        // Note: Do NOT clear _savedMappingBeforeDisable - it's needed for restore after enable
        // Note: Do NOT clear _lastWindowPerWorkspace - it's useful for focus restoration after unlock
        this._interfaceSettings = null;
        this._wmSettings = null;
        this._wmPreferences = null;
        this._mutterSettings = null;
        this._settings = null;

        console.log('[MultiMonitorsWorkspace] Extension disabled successfully');
    }

    // Move secondary windows to their logical WS and primary coordinates before disable
    // On enable(), windows can be retrieved by _getWindowsOnWorkspace(logicalWs)
    _restoreWindowsToLogicalWorkspaces() {
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const primaryGeo = global.display.get_monitor_geometry(primaryMonitor);

        console.log('[MultiMonitorsWorkspace] Moving secondary windows to their logical WS...');

        // Save current mapping for restore after enable
        this._savedMappingBeforeDisable.clear();
        for (const [monitorIndex, wsIndex] of this._monitorWorkspaceMap) {
            this._savedMappingBeforeDisable.set(monitorIndex, wsIndex);
        }

        let windowCount = 0;
        for (let monitorIndex = 0; monitorIndex < nMonitors; monitorIndex++) {
            if (monitorIndex === primaryMonitor) continue;

            const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
            const windowsOnMonitor = this._getWindowsOnMonitor(monitorIndex);
            const logicalWs = this._monitorWorkspaceMap.get(monitorIndex) ?? 0;

            // Ensure target workspace exists
            this._ensureWorkspaceExists(logicalWs);
            const logicalWsObj = global.workspace_manager.get_workspace_by_index(logicalWs);

            for (const window of windowsOnMonitor) {
                const title = window.get_title?.() ?? 'unknown';
                const rect = window.get_frame_rect();
                const relX = rect.x - monitorGeo.x;
                const relY = rect.y - monitorGeo.y;

                // Move to primary coordinates
                const newX = primaryGeo.x + relX;
                const newY = primaryGeo.y + relY;
                window.move_resize_frame(false, newX, newY, rect.width, rect.height);

                // Assign to logical WS (GNOME's global WS)
                if (logicalWsObj) {
                    window.change_workspace(logicalWsObj);
                }

                windowCount++;
                console.log(`[MultiMonitorsWorkspace] Moved "${title}" from M${monitorIndex} -> primary, WS${logicalWs}`);
            }
        }

        console.log(`[MultiMonitorsWorkspace] Moved ${windowCount} windows to logical WS`);
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

    // Focus-follows-mouse is Mutter's own focus-mode. We only flip it between
    // 'click' and 'sloppy' and remember the previous value so disable() can put
    // it back - we should not leave a global GNOME setting changed behind us.
    _applyFocusMode() {
        if (!this._wmPreferences) return;

        const wantFollow = this._settings.get_boolean('focus-follows-mouse');
        const target = wantFollow ? 'sloppy' : 'click';

        try {
            const current = this._wmPreferences.get_string('focus-mode');

            if (current === target) {
                this._debugLog(`focus-mode already '${target}'`);
                return;
            }

            // Remember what was there before the first change we made
            if (this._settings.get_string('saved-focus-mode') === '') {
                this._settings.set_string('saved-focus-mode', current);
            }

            this._wmPreferences.set_string('focus-mode', target);
            console.log(`[MultiMonitorsWorkspace] focus-mode: ${current} -> ${target}`);
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to set focus-mode:', e);
        }
    }

    _restoreFocusMode() {
        if (!this._wmPreferences) return;

        const saved = this._settings.get_string('saved-focus-mode');
        if (saved === '') return;

        try {
            this._wmPreferences.set_string('focus-mode', saved);
            this._settings.set_string('saved-focus-mode', '');
            console.log(`[MultiMonitorsWorkspace] focus-mode restored to '${saved}'`);
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to restore focus-mode:', e);
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

    // Read the user's per-monitor startup assignment from GSettings.
    // Returns Map<monitor, workspace>. Malformed entries, entries for monitors
    // that do not exist and duplicate workspaces are all dropped, so a bad
    // value degrades to "automatic" instead of breaking the mapping.
    _readConfiguredWorkspaceMap(nMonitors, nWorkspaces) {
        const result = new Map();
        const used = new Set();

        let raw = [];
        try {
            const stored = this._settings.get_strv('monitor-workspace-map');
            if (stored.length > 0) {
                raw = JSON.parse(stored[0]);
            }
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to parse monitor-workspace-map:', e.message);
            return result;
        }

        if (!Array.isArray(raw)) {
            if (raw.length > 0)
                console.error('[MultiMonitorsWorkspace] monitor-workspace-map is not an array, ignoring');
            return result;
        }

        for (const entry of raw) {
            const mon = entry?.monitor;
            const ws = entry?.workspace;
            if (!Number.isInteger(mon) || !Number.isInteger(ws)) {
                console.error(`[MultiMonitorsWorkspace] Ignoring malformed monitor-workspace-map entry: ${JSON.stringify(entry)}`);
                continue;
            }
            if (mon < 0 || mon >= nMonitors) {
                console.error(`[MultiMonitorsWorkspace] monitor-workspace-map references non-existent M${mon}, ignoring`);
                continue;
            }
            if (ws < 0 || ws >= nWorkspaces) {
                console.error(`[MultiMonitorsWorkspace] monitor-workspace-map references non-existent WS${ws}, ignoring`);
                continue;
            }
            if (used.has(ws)) {
                console.error(`[MultiMonitorsWorkspace] WS${ws} configured for two monitors, first wins, ignoring M${mon}`);
                continue;
            }
            used.add(ws);
            result.set(mon, ws);
        }

        return result;
    }

    // Returns Map<wmClass, {workspace, scope}> for the app-workspace-map
    // setting. WM_CLASS is matched case-insensitively: the .desktop files
    // spell it "firefox" while the running window may report "Firefox", and
    // making the user type the exact casing of an implementation detail is a
    // pointless trap. Malformed entries and duplicate keys are dropped so a bad
    // value degrades to "no rule" instead of misplacing windows.
    _readAppWorkspaceMap() {
        const result = new Map();

        let raw = [];
        try {
            const stored = this._settings.get_string('app-workspace-map');
            if (stored && stored.trim() !== '') {
                raw = JSON.parse(stored);
            }
        } catch (e) {
            console.error('[MultiMonitorsWorkspace] Failed to parse app-workspace-map:', e.message);
            return result;
        }

        if (!Array.isArray(raw)) {
            if (raw.length > 0)
                console.error('[MultiMonitorsWorkspace] app-workspace-map is not an array, ignoring');
            return result;
        }

        for (const entry of raw) {
            const wmClass = entry?.wmClass;
            const ws = entry?.workspace;
            if (typeof wmClass !== 'string' || wmClass.trim() === '') {
                console.error(`[MultiMonitorsWorkspace] Ignoring app-workspace-map entry without wmClass: ${JSON.stringify(entry)}`);
                continue;
            }
            if (!Number.isInteger(ws) || ws < 0 || ws > 9) {
                console.error(`[MultiMonitorsWorkspace] Ignoring app-workspace-map entry with invalid workspace: ${JSON.stringify(entry)}`);
                continue;
            }
            // An unknown scope is treated as "startup", the more conservative of
            // the two: it only ever applies during the login burst.
            const scope = APP_RULE_SCOPES.includes(entry?.scope) ? entry.scope : 'startup';

            // "maximize" is optional per rule. A rule that does not carry it
            // follows the global default, which is what lets an existing rule
            // list pick up a changed default without being rewritten. A rule
            // that carries it - including an explicit false - always wins.
            const maximize = typeof entry?.maximize === 'boolean'
                ? entry.maximize
                : this._settings.get_boolean('maximize-app-windows');

            const keys = wmClassLookupKeys(wmClass);
            if (result.has(keys[0])) {
                console.error(`[MultiMonitorsWorkspace] WM_CLASS "${wmClass}" configured twice, first wins`);
                continue;
            }

            // The first key is the WM_CLASS itself and always wins a collision;
            // the extra keys only fill gaps, so a rule for "com.example.Foo"
            // cannot be shadowed by a later, unrelated "Foo".
            for (const key of keys) {
                if (!result.has(key)) result.set(key, { workspace: ws, scope, maximize });
            }
        }

        return result;
    }

    // The app-workspace rule for a window, or null if the app is not mapped.
    // Rules with scope "startup" stop applying once the startup deadline has
    // passed, so they only ever catch autostarted windows.
    _getAppWorkspaceRule(window) {
        const wmClass = window.get_wm_class?.();
        if (!wmClass) return null;

        let rule = null;
        for (const key of wmClassLookupKeys(wmClass)) {
            rule = this._appWorkspaceMap.get(key);
            if (rule) break;
        }
        if (!rule) return null;

        if (rule.scope === 'startup' && GLib.get_monotonic_time() >= this._startupDeadline) {
            this._debugLog(`App rule for ${wmClass} expired (scope=startup)`);
            return null;
        }

        return { wmClass, ...rule };
    }

    // Hand out distinct workspaces to the monitors that do not have one yet.
    // Starts counting at `startWs` (normally the active workspace + 1) so the
    // monitors end up with a contiguous block around where the user already is.
    // Never returns a workspace already in `used`, unless every single
    // workspace is taken (more monitors than workspaces) - that case is logged
    // and the remaining monitors share a workspace rather than looping forever.
    _assignFreeWorkspaces(targets, nWorkspaces, used, startWs = 0) {
        const nextWs = (ws) => (ws + 1) % nWorkspaces;
        let candidate = ((startWs % nWorkspaces) + nWorkspaces) % nWorkspaces;

        for (const mon of targets) {
            // Bound the search so we cannot spin forever
            let attempts = 0;
            while (used.has(candidate) && attempts < nWorkspaces) {
                candidate = nextWs(candidate);
                attempts++;
            }

            if (used.has(candidate)) {
                console.error(`[MultiMonitorsWorkspace] All ${nWorkspaces} workspaces are already assigned; M${mon} has to share one`);
                continue;
            }

            this._monitorWorkspaceMap.set(mon, candidate);
            used.add(candidate);
            candidate = nextWs(candidate);
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
        const nWorkspaces = Math.max(global.workspace_manager.get_n_workspaces(), 1);

        this._monitorWorkspaceMap.clear();

        // Honour the user's per-monitor assignment first
        const configured = this._readConfiguredWorkspaceMap(nMonitors, nWorkspaces);
        const used = new Set();
        for (const [mon, ws] of configured) {
            this._monitorWorkspaceMap.set(mon, ws);
            used.add(ws);
        }
        if (configured.size > 0) {
            console.log(`[MultiMonitorsWorkspace] Using configured startup mapping: ${JSON.stringify([...configured])}`);
        }

        // The primary keeps whatever is active right now unless the user picked
        // one explicitly - reassigning it would visibly move the desktop.
        let primaryWs = currentWs;
        if (primaryWs < 0 || primaryWs >= nWorkspaces) primaryWs = 0;
        if (!this._monitorWorkspaceMap.has(primaryMonitor)) {
            this._monitorWorkspaceMap.set(primaryMonitor, primaryWs);
            used.add(primaryWs);
        }

        // Everything else gets whatever is left, counting up from the workspace
        // the user is on so the monitors end up as one contiguous block.
        const unassigned = [];
        for (let i = 0; i < nMonitors; i++) {
            if (!this._monitorWorkspaceMap.has(i)) unassigned.push(i);
        }
        this._assignFreeWorkspaces(unassigned, nWorkspaces, used, primaryWs + 1);

        this._logMappings('Initial');
    }

    // Handle a monitor being plugged in or removed.
    // The monitors that are still connected keep the workspace they were
    // showing - unplugging one must not reshuffle the whole desktop. Only
    // monitors that are new (or vanished) are touched.
    _reassignAfterMonitorChange() {
        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();

        // Drop monitors that are gone
        for (const mon of [...this._monitorWorkspaceMap.keys()]) {
            if (mon >= nMonitors) {
                console.log(`[MultiMonitorsWorkspace] M${mon} disconnected, dropping from mapping`);
                this._monitorWorkspaceMap.delete(mon);
            }
        }

        const used = new Set(this._monitorWorkspaceMap.values());

        // The primary may have changed identity
        if (!this._monitorWorkspaceMap.has(primaryMonitor) && nMonitors > 0) {
            let primaryWs = global.workspace_manager.get_active_workspace_index();
            const nWorkspaces = Math.max(global.workspace_manager.get_n_workspaces(), 1);
            if (primaryWs < 0 || primaryWs >= nWorkspaces) primaryWs = 0;
            if (used.has(primaryWs)) {
                // Its slot is taken, let the generic assignment deal with it
                this._debugLog(`Primary is now M${primaryMonitor}, but WS${primaryWs} is already in use`);
            } else {
                console.log(`[MultiMonitorsWorkspace] Primary is now M${primaryMonitor}, giving it WS${primaryWs}`);
                this._monitorWorkspaceMap.set(primaryMonitor, primaryWs);
                used.add(primaryWs);
            }
        }

        // Only fill in monitors we have never seen
        const nWorkspaces = Math.max(global.workspace_manager.get_n_workspaces(), 1);
        const fresh = [];
        for (let i = 0; i < nMonitors; i++) {
            if (!this._monitorWorkspaceMap.has(i)) fresh.push(i);
        }
        if (fresh.length === 0) {
            this._logMappings('After monitor change');
            return;
        }

        // Give newly connected monitors their configured workspace if that is
        // still free, otherwise hand out the next free one.
        const configured = this._readConfiguredWorkspaceMap(nMonitors, nWorkspaces);
        const stillNeedsSlot = [];
        for (const mon of fresh) {
            const ws = configured.get(mon);
            if (ws !== undefined && !used.has(ws)) {
                console.log(`[MultiMonitorsWorkspace] New M${mon} takes its configured WS${ws}`);
                this._monitorWorkspaceMap.set(mon, ws);
                used.add(ws);
            } else {
                stillNeedsSlot.push(mon);
            }
        }
        this._assignFreeWorkspaces(stillNeedsSlot, nWorkspaces, used);

        this._logMappings('After monitor change');
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
                    this._beginIntentionalMonitorJump();
                    try {
                        this._warpPointerToMonitor(monitorSortIndex);
                    } catch (e) {
                        console.error(`[MultiMonitorsWorkspace] _warpPointerToMonitor(${monitorSortIndex}) failed:`, e);
                        this._debugLog(`EXCEPTION in _warpPointerToMonitor(${monitorSortIndex}): ${e.message}`);
                    }
                    // Show popup banner
                    if (this._popupBanner) {
                        const wsIndex = this._monitorWorkspaceMap.get(monitorSortIndex) ?? 0;
                        this._popupBanner.show(monitorSortIndex, wsIndex);
                    }
                }
            );
        }

        // Register relative monitor navigation keybindings
        for (const direction of ADJACENT_DIRECTIONS) {
            const warpKeyName = `mmw-warp-to-adjacent-${direction}`;
            const warpAction = Main.wm.addKeybinding(
                warpKeyName,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    const target = this._warpToAdjacentMonitor(direction);
                    if (target === -1) return;
                    // Show popup banner for the monitor we ended up on. Use the
                    // index the handler resolved rather than asking the pointer,
                    // which may not have caught up with the warp yet.
                    if (this._popupBanner) {
                        const wsIndex = this._monitorWorkspaceMap.get(target) ?? 0;
                        this._popupBanner.show(target, wsIndex);
                    }
                }
            );
            this._logKeybindingGrab(warpKeyName, warpAction);

            const moveKeyName = `mmw-move-window-to-adjacent-${direction}`;
            const moveAction = Main.wm.addKeybinding(
                moveKeyName,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    this._moveWindowToAdjacentMonitor(direction);
                }
            );
            this._logKeybindingGrab(moveKeyName, moveAction);
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

    // Main.wm.addKeybinding() returns Meta.KeyBindingAction.NONE when the
    // accelerator could not be grabbed - usually because another component
    // already owns that key combination. Log it, otherwise such a keybinding
    // silently never fires.
    _logKeybindingGrab(keyName, action) {
        let accels = [];
        try {
            accels = this._settings.get_strv(keyName);
        } catch (e) {
            accels = ['<schema error>'];
        }

        if (accels.length === 0)
            return;

        if (action === Meta.KeyBindingAction.NONE) {
            this._debugLog(`KEYBINDING NOT GRABBED: ${keyName} = ${accels.join(', ')} -- already taken by another component`);
        } else {
            this._debugLog(`keybinding ok: ${keyName} = ${accels.join(', ')}`);
        }
    }

    _unregisterKeybindings() {
        for (let i = 0; i <= 9; i++) {
            Main.wm.removeKeybinding(`mmw-switch-ws-${i}`);
            Main.wm.removeKeybinding(`mmw-move-ws-${i}`);
        }
        for (let i = 0; i < 8; i++) {
            Main.wm.removeKeybinding(`mmw-warp-to-monitor-${i}`);
        }
        for (const direction of ADJACENT_DIRECTIONS) {
            Main.wm.removeKeybinding(`mmw-warp-to-adjacent-${direction}`);
            Main.wm.removeKeybinding(`mmw-move-window-to-adjacent-${direction}`);
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
        // is_maximized() since mutter 49; get_maximized() was removed. Both the
        // getter and maximize()/unmaximize() lost their MetaMaximizeFlags
        // parameter, so these are plain booleans now.
        const currentMaximized = focusedWindow.is_maximized();
        const targetMaximized = targetWindow.is_maximized();
        const currentFullscreen = focusedWindow.is_fullscreen();
        const targetFullscreen = targetWindow.is_fullscreen();

        this._debugLog(`Swapping positions: "${focusedWindow.get_title()}" <-> "${targetWindow.get_title()}"`);
        this._debugLog(`  Current maximized: ${currentMaximized}, fullscreen: ${currentFullscreen}`);
        this._debugLog(`  Target maximized: ${targetMaximized}, fullscreen: ${targetFullscreen}`);

        // Unmaximize/unfullscreen before moving
        if (currentMaximized) focusedWindow.unmaximize();
        if (targetMaximized) targetWindow.unmaximize();
        if (currentFullscreen) focusedWindow.unmake_fullscreen();
        if (targetFullscreen) targetWindow.unmake_fullscreen();

        // Wait for state changes to take effect, then swap positions
        this._addManagedTimeout(50, () => {
            if (!this._isWindowAlive(focusedWindow) || !this._isWindowAlive(targetWindow)) {
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
            this._addManagedTimeout(50, () => {
                if (!this._isWindowAlive(focusedWindow) || !this._isWindowAlive(targetWindow)) {
                    return GLib.SOURCE_REMOVE;
                }

                // Apply swapped states
                if (targetMaximized) focusedWindow.maximize();
                if (currentMaximized) targetWindow.maximize();
                if (targetFullscreen) focusedWindow.make_fullscreen();
                if (currentFullscreen) targetWindow.make_fullscreen();

                // Re-focus the originally focused window to prevent "ready" notification
                if (this._isWindowAlive(focusedWindow)) {
                    focusedWindow.focus(global.get_current_time());
                }

                this._debugLog(`Swap complete with state swap`);
                return GLib.SOURCE_REMOVE;
            });

            // Warp pointer to new position if enabled
            if (this._settings?.get_boolean('warp-pointer-to-focus')) {
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
            if (this._isWindowAlive(window)) {
                // Verify the window is on the correct monitor
                const windowMonitor = this._getWindowMonitor(window);
                // Only the primary monitor tracks the real global workspace. In
                // workspaces-only-on-primary mode the windows on secondary
                // monitors are sticky (WS = -1), so asking
                // window.located_on_workspace(activeWs) reports false for them
                // and used to wipe the saved record on every jump.
                const primaryMonitor = global.display.get_primary_monitor();
                let isVisibleHere;
                if (monitorIndex === primaryMonitor) {
                    const activeWs = global.workspace_manager.get_active_workspace();
                    isVisibleHere = window.located_on_workspace(activeWs);
                } else {
                    // On a secondary monitor every non-hidden window is visible
                    isVisibleHere = !window.is_hidden();
                }

                    if (windowMonitor === monitorIndex && isVisibleHere) {
                    // Focus the window and warp to its center
                    const rect = window.get_frame_rect();
                    targetX = Math.floor(rect.x + rect.width / 2);
                    targetY = Math.floor(rect.y + rect.height / 2);
                    focusedWindow = window;
                    this._debugLog(`Restored focus to last window: "${window.get_title()}" on WS${wsIndex}`);
                } else if (!isVisibleHere) {


                    this._debugLog(`Window "${window.get_title()}" not visible here, clearing record`);
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
        this._debugLog(`    warp_pointer(${targetX},${targetY})`);
        seat.warp_pointer(targetX, targetY);

        // Focus the window (or find one at position)
        this._debugLog(`    focusing: ${focusedWindow ? `"${focusedWindow.get_title?.()}"` : '<by position>'}`);
        if (focusedWindow) {
            focusedWindow.focus(global.get_current_time());
        } else {
            this._focusWindowAtPosition(targetX, targetY, monitorIndex);
        }
        this._debugLog(`    focus call returned`);

        // Update indicator highlight
        if (this._indicatorManager) {
            this._indicatorManager.updateHighlight();
        }
    }

    // Describe pointer + focus so we can see whether a jump actually happened,
    // not merely that the target was computed.
    _describeFocusState(label) {
        const [px, py] = global.get_pointer();
        const monAtPointer = this._getMonitorAtPointer();
        const focused = global.display.get_focus_window();
        let focusDesc = 'none';
        if (focused) {
            const fmon = this._getWindowMonitor(focused);
            const title = (focused.get_title?.() ?? '?').slice(0, 28);
            focusDesc = `"${title}" on M${fmon}`;
        }
        this._debugLog(`  ${label}: pointer=(${px},${py}) on M${monAtPointer} | focus=${focusDesc} | stageFocus=${global.stage.get_key_focus() ? 'actor' : 'null'}`);
    }

    // Keep the "focus is on another monitor" guard out of the way for a moment.
    // GObject notify::focus-window normally fires synchronously from focus(),
    // but the pointer warp and any queued focus change can land a few
    // milliseconds later, so we clear the flag on a short timer rather than
    // right after the call returns.
    _beginIntentionalMonitorJump() {
        this._suppressFocusMonitorGuard = true;

        if (this._suppressFocusGuardTimeoutId) {
            this._cancelManagedTimeout(this._suppressFocusGuardTimeoutId);
        }
        this._suppressFocusGuardTimeoutId = this._addManagedTimeout(300, () => {
            this._suppressFocusGuardTimeoutId = null;
            this._suppressFocusMonitorGuard = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Warp pointer and focus to the neighbouring monitor in a direction.
    // Thin wrapper: the actual work is done by _warpPointerToMonitor().
    // Returns the monitor we landed on, or -1 when there was no neighbour, so
    // the caller does not have to ask the pointer where it ended up.
    _warpToAdjacentMonitor(direction) {
        const fromMonitor = this._getMonitorAtPointer();
        const targetMonitor = this._getAdjacentMonitor(fromMonitor, direction);

        if (targetMonitor === -1) {
            this._debugLog(`No monitor ${direction} of M${fromMonitor}, ignoring`);
            return -1;
        }

        this._describeFocusState(`BEFORE ${direction} M${fromMonitor}->M${targetMonitor}`);
        this._debugLog(`Warp to adjacent monitor: M${fromMonitor} --${direction}--> M${targetMonitor}`);
        this._beginIntentionalMonitorJump();
        try {
            this._warpPointerToMonitor(targetMonitor);
        } catch (e) {
            console.error(`[MultiMonitorsWorkspace] _warpPointerToMonitor(${targetMonitor}) failed:`, e);
            this._debugLog(`EXCEPTION in _warpPointerToMonitor: ${e.message}`);
            this._debugLog(`STACK: ${e.stack}`);
        }
        this._describeFocusState(`AFTER  ${direction} M${fromMonitor}->M${targetMonitor}`);
        return targetMonitor;
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
            if (this._isWindowAlive(window)) {
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
    // NOTE: a second, byte-identical _findWindowById used to exist further down
    // in this class and shadowed this one. Only the surviving definition below
    // (next to _getWindowId) is kept.

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

    // Move the focused window to the workspace displayed on the neighbouring
    // monitor in a direction. The window is physically relocated to that
    // monitor (keeping its relative position and size) and assigned the
    // workspace that monitor is showing.
    //
    // This deliberately does not reuse _moveWindowToWorkspace(): that one
    // always places the window at *primary* coordinates, which would leave the
    // window on a different monitor than the one we just navigated to.
    _moveWindowToAdjacentMonitor(direction) {
        const focusedWindow = global.display.get_focus_window();
        if (!focusedWindow) {
            console.log('[MultiMonitorsWorkspace] No focused window to move');
            return;
        }

        if (focusedWindow.get_window_type() !== Meta.WindowType.NORMAL) {
            console.log('[MultiMonitorsWorkspace] Cannot move non-normal window');
            return;
        }

        const fromMonitor = this._getMonitorAtPointer();
        const targetMonitor = this._getAdjacentMonitor(fromMonitor, direction);
        if (targetMonitor === -1) {
            this._debugLog(`No monitor ${direction} of M${fromMonitor}, ignoring`);
            return;
        }

        const title = focusedWindow.get_title?.() ?? 'unknown';
        const fromGeo = global.display.get_monitor_geometry(fromMonitor);
        const targetGeo = global.display.get_monitor_geometry(targetMonitor);
        const targetWs = this._monitorWorkspaceMap.get(targetMonitor) ?? 0;
        const primaryMonitor = global.display.get_primary_monitor();
        const currentGlobalWs = global.workspace_manager.get_active_workspace();

        this._debugLog(`\n========== MOVE WINDOW TO ADJACENT MONITOR ==========`);
        this._debugLog(`Window: "${title}" M${fromMonitor} --${direction}--> M${targetMonitor} (WS${targetWs})`);

        const rect = focusedWindow.get_frame_rect();
        const relX = rect.x - fromGeo.x;
        const relY = rect.y - fromGeo.y;
        const width = rect.width;
        const height = rect.height;

        // Remember the relative position so a later workspace switch can put
        // the window back where the user expects it.
        const windowId = this._getWindowId(focusedWindow);
        this._savedWindowPositions.set(windowId, { relX, relY, wsIndex: targetWs });

        const newX = targetGeo.x + relX;
        const newY = targetGeo.y + relY;
        focusedWindow.move_resize_frame(false, newX, newY, width, height);

        // Explicit monitor assignment - without this maximised windows end up
        // sized for the wrong monitor.
        focusedWindow.move_to_monitor(targetMonitor);

        // Re-apply size after a short delay (GNOME may reset it)
        const w = focusedWindow, finalX = newX, finalY = newY, finalW = width, finalH = height;
        this._addManagedTimeout(50, () => {
            if (this._isWindowAlive(w)) {
                w.move_resize_frame(false, finalX, finalY, finalW, finalH);
            }
            return GLib.SOURCE_REMOVE;
        });

        // Secondary monitor windows are sticky (workspaces-only-on-primary), so
        // there we assign the current global workspace; on primary we assign
        // the workspace the monitor is actually showing. The primary case has to
        // go through _bindWindowToWorkspace(): the move onto the primary is what
        // decides the workspace, a change_workspace() in this tick is ignored
        // while the window is still sticky, and Mutter would then drop the window
        // on the active workspace instead of the one that was asked for.
        if (targetMonitor === primaryMonitor) {
            this._bindWindowToWorkspace(focusedWindow, targetWs, title);
        } else if (currentGlobalWs) {
            focusedWindow.change_workspace(currentGlobalWs);
        }

        // Follow the window with the pointer, otherwise focus and pointer would
        // sit on different monitors.
        const seat = Clutter.get_default_backend().get_default_seat();
        seat.warp_pointer(Math.floor(newX + width / 2), Math.floor(newY + height / 2));

        if (this._indicatorManager) {
            this._indicatorManager.updateHighlight();
        }
        if (this._popupBanner) {
            this._popupBanner.show(targetMonitor, targetWs);
        }

        this._debugLog(`Moved "${title}" to M${targetMonitor} (WS${targetWs}) at (${newX},${newY}) ${width}x${height}`);
        this._debugLog(`========== END MOVE WINDOW TO ADJACENT MONITOR ==========\n`);
    }

    _connectSignals() {
        const monitorManager = global.backend.get_monitor_manager();
        const id1 = monitorManager.connect('monitors-changed', () => {
            console.log('[MultiMonitorsWorkspace] Monitors changed, reassigning...');
            this._reassignAfterMonitorChange();

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
                    this._indicatorManager = new WorkspaceIndicatorManager(this.metadata.uuid, this._settings.get_boolean('flat-panel-indicator'));
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

        // Switching the flat layout only needs a rebuild of the panel button
        const flatIndicatorId = this._settings.connect('changed::flat-panel-indicator', () => {
            const flat = this._settings.get_boolean('flat-panel-indicator');
            console.log(`[MultiMonitorsWorkspace] Flat panel indicator: ${flat}`);
            if (!this._indicatorManager) return;
            this._indicatorManager.setFlatIndicator(flat);
            this._indicatorManager.rebuild(this._monitorWorkspaceMap);
        });
        this._signalIds.push({ obj: this._settings, id: flatIndicatorId });

        // Focus-follows-mouse flips Mutter's focus-mode, apply it live
        const focusFollowsId = this._settings.connect('changed::focus-follows-mouse', () => {
            const follow = this._settings.get_boolean('focus-follows-mouse');
            console.log(`[MultiMonitorsWorkspace] Focus follows mouse: ${follow}`);
            this._applyFocusMode();
        });
        this._signalIds.push({ obj: this._settings, id: focusFollowsId });

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

        // Re-read the app placement rules when they change in the preferences.
        // Windows already handled keep their old placement, new ones pick the
        // new rules up right away.
        const appMapId = this._settings.connect('changed::app-workspace-map', () => {
            this._appWorkspaceMap = this._readAppWorkspaceMap();
            this._debugLog(`App workspace rules reloaded: ${this._appWorkspaceMap.size} entries`);
            // Forget which windows were handled under the old rules, otherwise a
            // newly added rule could never fire for an already open window.
        this._rulePlacedWindows.clear();
        this._unmanagedRuleWindows.clear();

            if (this._appWorkspaceMap.size > 0) {
                this._sweepExistingWindows('rules-changed');
            }
        });
        this._signalIds.push({ obj: this._settings, id: appMapId });

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

        // NOTE: there is deliberately no global "unmap" handler here.
        // global.window_manager is a Shell.Wm, which only has a "map" signal -
        // connecting "unmap" to it throws and would abort the rest of
        // _connectSignals(). Cleanup is done per window instead, see
        // _markRulePlaced().

        // NOTE: a Main.sessionMode 'updated' handler used to be connected here.
        // It was dead code: metadata.json declares no "session-modes", so GNOME
        // defaults to ['user'] and disables the extension the moment the screen
        // locks -- the user -> unlock-dialog transition can never be observed
        // from a running extension. Window restoration on unlock is handled by
        // the disable()/enable() cycle in _continueEnable() instead
        // (_restoreWindowsTimeoutId -> _restoreSecondaryWindowsFromMapping).

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
                    // ...unless we are in the middle of a deliberate jump to a
                    // neighbouring monitor. The pointer warp we just requested is
                    // not reflected by global.get_pointer() at this point, so the
                    // comparison above is stale and "correcting" would undo the
                    // jump by pulling focus back onto the monitor we came from.
                    if (this._suppressFocusMonitorGuard) {
                        this._debugLog(`Focus on M${focusWindowMonitor} vs pointer M${pointerMonitor}: intentional monitor jump, not correcting`);
                    } else {
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

        // Update wallpaper overlays
        if (this._wallpaperManager) {
            this._wallpaperManager.update(this._monitorWorkspaceMap);
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
        this._addManagedTimeout(1000, () => {
            this._recentlyProcessedWindows.delete(windowId);
            return GLib.SOURCE_REMOVE;
        });

        // An app-workspace rule takes precedence over the pointer-based
        // placement below. The window gets parked on the configured workspace
        // and is never activated, so the view stays exactly where the user is
        // looking even though the window belongs to a different one.
        const appRule = this._getAppWorkspaceRule(window);
        if (appRule) {
            this._markRulePlaced(window, windowId);
            // A rule fires at most once per window, so drop the dedup entry
            // again right away. Leaving it would make the 1s lock swallow the
            // 'map' signal and with it the retries the placement needs.
            this._recentlyProcessedWindows.delete(windowId);
            this._placeWindowByAppRule(window, appRule, windowId);
            return;
        }

        // Capture pointer position NOW (before warp-pointer-to-focus can move it)
        const [capturedPointerX, capturedPointerY] = global.get_pointer();
        const targetMonitor = this._getMonitorAtPointer();

        this._debugLog(`WINDOW CREATED: Captured pointer at (${capturedPointerX},${capturedPointerY}) on M${targetMonitor}`);

        // Mark window as pending placement (suppresses warp-pointer-to-focus)
        this._windowsPendingPlacement.set(windowId, targetMonitor);

        // Delay to let the window initialize its position
        this._addManagedIdle(() => {
            this._moveWindowToMonitor(window, targetMonitor, windowId);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Walk every window that currently exists and apply an app-workspace rule
    // to the ones that are still on their original workspace.
    //
    // Windows already handled by a rule are skipped via _rulePlacedWindows, so
    // this can never yank a window back once the user has moved it themselves.
    _sweepExistingWindows(label) {
        if (this._appWorkspaceMap.size === 0) return;

        const actors = global.get_window_actors();
        this._debugLog(`APP RULE SWEEP (${label}): checking ${actors.length} windows`);

        for (const actor of actors) {
            const window = actor.get_meta_window();
            if (!window) continue;

            const windowType = window.get_window_type();
            if (windowType !== Meta.WindowType.NORMAL) continue;
            if (window.is_skip_taskbar()) continue;

            const windowId = this._getWindowId(window);
            if (this._rulePlacedWindows.has(windowId)) continue;

            const rule = this._getAppWorkspaceRule(window);
            if (!rule) continue;

            // Only intervene while the window is still where it was created.
            // If it is already on a workspace of its own, something moved it
            // deliberately and that decision wins.
            if (window.get_workspace() !== global.workspace_manager.get_active_workspace()) {
                this._debugLog(
                    `APP RULE SWEEP: "${rule.wmClass}" already on WS` +
                    `${window.get_workspace()?.index()}, not WS${rule.workspace} - leaving it alone`);
                this._markRulePlaced(window, windowId);
                continue;
            }

            this._debugLog(`APP RULE SWEEP: applying "${rule.wmClass}" -> WS${rule.workspace}`);
            this._markRulePlaced(window, windowId);
            this._placeWindowByAppRule(window, rule, windowId);
        }
    }

    // Remember that a rule has already been applied to this window.
    //
    // Cleanup is attached to the window's own "unmanaged" signal rather than to
    // a global one, for two reasons. global.window_manager is a Shell.Wm, which
    // only has "map", so a global "unmap" handler does not exist. And MetaWindow
    // has no "unmap" either - its signals are configure, focus, raised, shown,
    // size-changed, position-changed, workspace-changed, highest-scale-monitor-
    // changed, unmanaging and unmanaged.
    _markRulePlaced(window, windowId) {
        this._rulePlacedWindows.add(windowId);
        this._unmanagedRuleWindows.delete(windowId);

        try {
            window.connect('unmanaged', () => {
                this._rulePlacedWindows.delete(windowId);
                this._unmanagedRuleWindows.add(windowId);
            });
        } catch (e) {
            // Not fatal: the set is cleared on disable anyway, it would just
            // keep one stale entry per window for the rest of the session.
            this._debugLog(`APP RULE: cannot observe unmanaged on ${windowId}: ${e.message}`);
        }
    }

    // Whether a window a rule is working on still exists.
    //
    // Deliberately not _isWindowAlive(): that asks whether Mutter considers the
    // window ready to be focused, which is false for a window that has not drawn
    // its first buffer yet - the normal state of an autostarted app seconds
    // into login, and precisely when a rule is placing it. The "unmanaged"
    // signal connected in _markRulePlaced() is the actual "this window is gone"
    // event, and it cannot be missed.
    _isRuleWindowAlive(windowId) {
        return !this._unmanagedRuleWindows.has(windowId);
    }

    // Place a window on the workspace an app rule asks for, and nothing else.
    //
    // The rule's workspace index only means something together with the
    // monitor-workspace mapping: _monitorWorkspaceMap says which monitor shows
    // which workspace. So the window has to end up on the monitor that shows
    // the requested workspace, not on the primary.
    //
    // Getting this wrong is invisible rather than wrong-looking, which is what
    // made it so hard to see: under workspaces-only-on-primary only the primary
    // binds its windows to the active workspace, every window on a secondary
    // monitor is sticky and therefore visible on whatever workspace is active.
    // Parking a rule window on the primary put it on the requested workspace
    // (change_workspace() succeeds and reports success) while the primary kept
    // showing a different one, so the window sat there hidden until a workspace
    // switch dragged it onto the right monitor. Parking it on the monitor that
    // actually shows the workspace makes it sticky and visible there, which is
    // exactly what the user sees for every other window of that workspace.
    //
    // When no monitor is mapped to the requested workspace there is nowhere to
    // put it, so the primary is used and the window is bound to the workspace
    // itself - it shows up whenever the user switches to that workspace.
    //
    // The window is never activated: meta_window_activate() switches to the
    // window's workspace, and the user wants an app to start quietly on e.g.
    // workspace 5 without being taken there. move_frame() and change_workspace()
    // do not change the active workspace on their own.
    _placeWindowOnWorkspace(window, wmClass, workspace) {
        this._ensureWorkspaceExists(workspace);
        const wsObj = global.workspace_manager.get_workspace_by_index(workspace);
        if (!wsObj) {
            this._debugLog(`APP RULE: "${wmClass}" cannot get WS${workspace}`);
            return false;
        }

        const primaryMonitor = global.display.get_primary_monitor();
        const hostMonitor = this._getMonitorForWorkspace(workspace);
        const targetMonitor = hostMonitor ?? primaryMonitor;
        const isPrimaryTarget = targetMonitor === primaryMonitor;

        this._debugLog(
            `APP RULE: "${wmClass}" -> WS${workspace} hosted by M${targetMonitor}` +
            `${isPrimaryTarget ? ' (primary)' : ''}`);

        const rect = window.get_frame_rect();
        const sourceMonitor = this._getWindowMonitor(window);

        if (sourceMonitor !== targetMonitor) {
            // Mutter derives a window's monitor from its position, so moving the
            // frame is what actually reassigns it. Keep the position relative to
            // the current monitor so the window lands where the user expects,
            // then clamp it onto the target.
            const targetGeo = global.display.get_monitor_geometry(targetMonitor);
            const sourceGeo = sourceMonitor >= 0
                ? global.display.get_monitor_geometry(sourceMonitor)
                : null;
            let newX = sourceGeo ? targetGeo.x + (rect.x - sourceGeo.x) : targetGeo.x;
            let newY = sourceGeo ? targetGeo.y + (rect.y - sourceGeo.y) : targetGeo.y;
            newX = Math.max(targetGeo.x, Math.min(newX, targetGeo.x + targetGeo.width - rect.width));
            newY = Math.max(targetGeo.y, Math.min(newY, targetGeo.y + targetGeo.height - rect.height));

            try {
                window.move_frame(false, newX, newY);
            } catch (e) {
                this._debugLog(`APP RULE: "${wmClass}" move_frame(M${targetMonitor}) threw: ${e.message}`);
                return false;
            }
        }

        // Only the primary binds windows to a workspace. On a secondary monitor
        // the window is sticky now, and change_workspace() is a no-op there -
        // asking for it anyway would only produce a misleading mismatch below.
        if (isPrimaryTarget) {
            try {
                window.change_workspace(wsObj);
            } catch (e) {
                this._debugLog(`APP RULE: "${wmClass}" change_workspace(WS${workspace}) threw: ${e.message}`);
                return false;
            }
        }

        const landedMonitor = this._getWindowMonitor(window);
        const landedWs = window.get_workspace()?.index() ?? -1;
        const landed = isPrimaryTarget ? landedWs === workspace : landedMonitor === targetMonitor;
        this._debugLog(
            `APP RULE: "${wmClass}" wanted WS${workspace} on M${targetMonitor}, ` +
            `now WS${landedWs} on M${landedMonitor}`);

        if (!landed) {
            console.warn(
                `[MultiMonitorsWorkspace] app rule had no effect for ${wmClass}: ` +
                `wanted WS${workspace} on M${targetMonitor}, ` +
                `got WS${landedWs} on M${landedMonitor}`);
            return false;
        }
        return true;
    }

    _placeWindowByAppRule(window, rule, windowId) {
        const { wmClass, workspace, scope, maximize } = rule;

        this._debugLog(
            `APP RULE: "${wmClass}" -> WS${workspace} (scope=${scope}, maximize=${maximize})`);

        // Mark pending so warp-pointer-to-focus stays suppressed for this
        // window; cleared again once placement is done.
        this._windowsPendingPlacement.set(windowId, this._getMonitorAtPointer());

        // Autostarted windows are regularly not fully realised when
        // window-created fires, and a single attempt at idle is not enough to
        // land one reliably. Retry over ~1.3s and stop as soon as the window
        // really sits on the target workspace.
        const delays = [0, 300, 1000];
        let attempt = 0;

        const tryPlace = () => {
            let done = false;
            try {
                done = this._placeWindowOnWorkspace(window, wmClass, workspace);
            } catch (e) {
                this._debugLog(`APP RULE: "${wmClass}" placement threw: ${e.message}`);
                console.warn(`[MultiMonitorsWorkspace] App rule placement failed: ${e.message}`);
            }

            this._windowsPendingPlacement.delete(windowId);

            attempt++;
            if (done) {
                this._debugLog(`APP RULE: "${wmClass}" placed on WS${workspace} on attempt ${attempt}`);
                this._maximizeAfterRulePlacement(window, windowId, wmClass, maximize);
                return;
            }
            if (attempt >= delays.length) {
                this._debugLog(`APP RULE: "${wmClass}" gave up after ${attempt} attempts`);
                return;
            }

            this._addManagedTimeout(delays[attempt], tryPlace);
        };

        this._addManagedIdle(tryPlace);
    }

    // Maximize a rule-placed window, if its rule says so.
    //
    // This cannot run in the same tick as the move: Mutter maximises onto the
    // monitor the window is on *now*, and a move_frame() issued in the same tick
    // has not been through the monitor update yet - the window would end up
    // maximised on the monitor it came from.
    //
    // Hence the retries, which have to run well past the point where the app has
    // even drawn its first buffer: a maximise request to a window that is not
    // realised yet is accepted and then dropped, and an autostarted app can take
    // a second or two to get there. Each attempt re-issues the request, so it does
    // not matter which one is the one that sticks.
    //
    // Only ever maximizes. A window that is already maximized, and a window whose
    // app refuses to be maximized, are both left exactly as they are - unmaximizing
    // would mean touching windows the user maximized themselves.
    _maximizeAfterRulePlacement(window, windowId, wmClass, maximize) {
        if (!maximize) return;

        const delays = [50, 200, 500, 1000, 2000];
        let attempt = 0;

        const tryMaximize = () => {
            if (!this._isRuleWindowAlive(windowId)) {
                this._debugLog(`APP RULE: "${wmClass}" gone before it could be maximized`);
                return;
            }

            let maximized = false;
            try {
                // is_maximized() and a parameterless maximize() since mutter 49;
                // get_maximized() and the MetaMaximizeFlags parameter are gone.
                // Same convention as the window swap in _swapWithNeighbor().
                maximized = window.is_maximized();
                if (!maximized) {
                    // user_op = true: this is a deliberate placement, not something
                    // the user did by clicking the titlebar, and apps that remember
                    // geometry across restarts should store the maximized one.
                    window.maximize();
                    maximized = window.is_maximized();
                }
            } catch (e) {
                this._debugLog(`APP RULE: "${wmClass}" maximize threw: ${e.message}`);
                return;
            }

            attempt++;
            if (maximized) {
                this._debugLog(`APP RULE: "${wmClass}" maximized on attempt ${attempt} ` +
                    `(M${this._getWindowMonitor(window)})`);
                return;
            }
            if (attempt >= delays.length) {
                this._debugLog(`APP RULE: "${wmClass}" did not accept maximize, leaving it as it is`);
                return;
            }

            this._debugLog(`APP RULE: "${wmClass}" not maximized yet, retrying in ${delays[attempt]}ms`);
            this._addManagedTimeout(delays[attempt], tryMaximize);
        };

        this._addManagedTimeout(delays[attempt], tryMaximize);
    }

    // Move window to a specific monitor (used for new window placement)
    _moveWindowToMonitor(window, targetMonitor, windowId = null) {
        if (!this._isWindowAlive(window)) {
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
        if (this._isWindowAlive(window)) {
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

    // Restore secondary windows from saved mapping after enable()
    // Windows are retrieved from their logical WS and moved to secondary monitors
    _restoreSecondaryWindowsFromMapping() {
        if (!this._savedMappingBeforeDisable || this._savedMappingBeforeDisable.size === 0) {
            console.log('[MultiMonitorsWorkspace] No saved mapping to restore');
            return;
        }

        const nMonitors = global.display.get_n_monitors();
        const primaryMonitor = global.display.get_primary_monitor();
        const primaryGeo = global.display.get_monitor_geometry(primaryMonitor);
        const currentGlobalWs = global.workspace_manager.get_active_workspace();

        console.log('[MultiMonitorsWorkspace] Restoring secondary windows from mapping...');

        // Restore mapping to _monitorWorkspaceMap
        for (const [monitorIndex, wsIndex] of this._savedMappingBeforeDisable) {
            this._monitorWorkspaceMap.set(monitorIndex, wsIndex);
        }

        let windowCount = 0;
        for (let monitorIndex = 0; monitorIndex < nMonitors; monitorIndex++) {
            if (monitorIndex === primaryMonitor) continue;

            const logicalWs = this._savedMappingBeforeDisable.get(monitorIndex);
            if (logicalWs === undefined) continue;

            const monitorGeo = global.display.get_monitor_geometry(monitorIndex);
            if (!monitorGeo) continue;

            // Get windows from their logical WS
            const windowsOnWs = this._getWindowsOnWorkspace(logicalWs);

            for (const window of windowsOnWs) {
                const title = window.get_title?.() ?? 'unknown';
                const rect = window.get_frame_rect();

                // Calculate relative position (window is on primary)
                const relX = rect.x - primaryGeo.x;
                const relY = rect.y - primaryGeo.y;

                // Move to secondary monitor
                const newX = monitorGeo.x + relX;
                const newY = monitorGeo.y + relY;
                window.move_resize_frame(false, newX, newY, rect.width, rect.height);
                window.move_to_monitor(monitorIndex);
                window.change_workspace(currentGlobalWs);

                // Delayed re-apply for stability
                const w = window, x = newX, y = newY, width = rect.width, height = rect.height;
                this._addManagedTimeout(50, () => {
                    if (this._isWindowAlive(w)) {
                        w.move_resize_frame(false, x, y, width, height);
                    }
                    return GLib.SOURCE_REMOVE;
                });

                windowCount++;
                console.log(`[MultiMonitorsWorkspace] Restored "${title}" to M${monitorIndex} at (${newX},${newY})`);
            }
        }

        // Clear saved mapping
        this._savedMappingBeforeDisable.clear();
        console.log(`[MultiMonitorsWorkspace] Restored ${windowCount} windows`);

        this._logMappings('After Restore');

        // Update workspace indicator
        if (this._indicatorManager) {
            this._indicatorManager.update(this._monitorWorkspaceMap);
        }

        // Update wallpaper overlays
        if (this._wallpaperManager) {
            this._wallpaperManager.update(this._monitorWorkspaceMap);
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

        // Update wallpaper overlays
        if (this._wallpaperManager) {
            this._wallpaperManager.update(this._monitorWorkspaceMap);
        }

        // Show popup banner
        if (this._popupBanner) {
            this._popupBanner.show(currentMonitor, targetWs);
        }

        // Restore mouse pointer position if it moved during window operations
        this._restorePointerPosition(savedPointerX, savedPointerY);

        // Focus last focused window or window under pointer after workspace switch
        // Cancel any existing focus restore timeout to avoid conflicts
        if (this._focusRestoreTimeoutId) {
            this._cancelManagedTimeout(this._focusRestoreTimeoutId);
        }
        const focusTargetMonitor = currentMonitor;
        const focusTargetWs = targetWs;
        this._focusRestoreTimeoutId = this._addManagedTimeout(200, () => {
            this._focusRestoreTimeoutId = null;
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
        // Cancel any existing pointer restore timeouts to avoid conflicts
        this._clearPointerRestoreTimeouts();

        // First immediate check and restore
        this._doPointerRestore(savedX, savedY, 'immediate');

        // Then delayed restore to handle GNOME's async focus changes
        // Multiple delays to catch different timing scenarios
        const id1 = this._addManagedTimeout(50, () => {
            this._doPointerRestore(savedX, savedY, 'delay-50ms');
            return GLib.SOURCE_REMOVE;
        });
        this._pointerRestoreTimeoutIds.push(id1);

        const id2 = this._addManagedTimeout(150, () => {
            this._doPointerRestore(savedX, savedY, 'delay-150ms');
            return GLib.SOURCE_REMOVE;
        });
        this._pointerRestoreTimeoutIds.push(id2);
    }

    // Activate workspace without animation
    _activateWorkspaceWithoutAnimation(workspace) {
        // Set flag to indicate this is an internal switch
        this._isInternalSwitch = true;

        // Cancel any existing internal switch timeout to avoid flag conflicts
        if (this._internalSwitchTimeoutId) {
            this._cancelManagedTimeout(this._internalSwitchTimeoutId);
            this._internalSwitchTimeoutId = null;
        }

        if (!this._interfaceSettings) {
            workspace.activate(global.get_current_time());
            // Reset flag after a short delay (after signal handlers have processed)
            this._internalSwitchTimeoutId = this._addManagedTimeout(100, () => {
                this._isInternalSwitch = false;
                this._internalSwitchTimeoutId = null;
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
            // Cancel any existing animation restore timeout
            if (this._animationRestoreTimeoutId) {
                this._cancelManagedTimeout(this._animationRestoreTimeoutId);
            }
            this._animationRestoreTimeoutId = this._addManagedTimeout(50, () => {
                if (this._interfaceSettings) {
                    this._interfaceSettings.set_boolean('enable-animations', true);
                }
                this._animationRestoreTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        // Reset internal switch flag after signal handlers have processed
        this._internalSwitchTimeoutId = this._addManagedTimeout(100, () => {
            this._isInternalSwitch = false;
            this._internalSwitchTimeoutId = null;
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

    // Bind a window to a workspace after moving it to the primary, and keep
    // asking until it really is on that workspace.
    //
    // Mutter decides a window's workspace while it processes the monitor change,
    // not when move_to_monitor() returns. A change_workspace() issued in the
    // same tick still sees the window in its old state - sticky, on a secondary
    // monitor - where it is ignored, and Mutter then drops the window onto
    // whichever workspace is active at that moment. The move succeeds, the
    // window is on the primary, and it is on the wrong workspace: that is how
    // the window belonging to WS4 becomes a WS1 window as soon as its monitor
    // moves on to another workspace.
    //
    // A pending binding is cancelled by a newer one for the same window, so a
    // second switch within the retry window wins instead of the stale retry
    // dragging the window back.
    //
    // Deliberately without an _isWindowAlive() guard: check_alive() is false for
    // a window that has not drawn a buffer yet, which is the normal state of a
    // window in the middle of a monitor move. The try/catch is what catches a
    // window that is actually gone.
    _bindWindowToWorkspace(window, wsIndex, label) {
        const windowId = this._getWindowId(window);
        this._pendingWsBindings.set(windowId, wsIndex);

        const delays = [50, 250, 700];
        let attempt = 0;

        const tryBind = () => {
            if (this._pendingWsBindings.get(windowId) !== wsIndex) {
                this._debugLog(`  "${label}" WS${wsIndex} binding superseded, abandoning`);
                return GLib.SOURCE_REMOVE;
            }

            let landed = -1;
            try {
                landed = window.get_workspace()?.index() ?? -1;
                if (landed !== wsIndex) {
                    const wsObj = global.workspace_manager.get_workspace_by_index(wsIndex);
                    if (!wsObj) return GLib.SOURCE_REMOVE;
                    window.change_workspace(wsObj);
                    landed = window.get_workspace()?.index() ?? -1;
                }
            } catch (e) {
                this._debugLog(`  binding "${label}" to WS${wsIndex} failed: ${e.message}`);
                return GLib.SOURCE_REMOVE;
            }

            attempt++;
            if (landed === wsIndex) {
                this._debugLog(`  "${label}" on WS${wsIndex} (attempt ${attempt})`);
                this._pendingWsBindings.delete(windowId);
                return GLib.SOURCE_REMOVE;
            }
            if (attempt >= delays.length) {
                this._debugLog(
                    `  "${label}" would not stay on WS${wsIndex}, it is on WS${landed}`);
                this._pendingWsBindings.delete(windowId);
                return GLib.SOURCE_REMOVE;
            }

            this._addManagedTimeout(delays[attempt], tryBind);
            return GLib.SOURCE_REMOVE;
        };

        this._addManagedTimeout(delays[attempt], tryBind);
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
            this._addManagedTimeout(50, () => {
                if (this._isWindowAlive(w)) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Bind it to previousWs so it will be hidden (global WS is
            // different). Deferred: the binding only sticks once Mutter has
            // processed the move onto the primary, see
            // _bindWindowToWorkspace().
            this._bindWindowToWorkspace(window, previousWs, shortTitle);

            this._debugLog(`  -> "${shortTitle}" moved to primary (${newX},${newY}) size ${width}x${height}, belongs to WS${previousWs}`);
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
            this._addManagedTimeout(50, () => {
                if (this._isWindowAlive(w)) {
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

    // Whether this Meta.Window is still usable.
    //
    // check_alive(timestamp) is the only safe test here. "is-alive" exists as a
    // read-only GObject property, but reading it dereferences the window's C
    // object directly, and this is called in loops over get_window_actors(),
    // where an entry can already have been freed. check_alive() reaps a window
    // that died since the last check, which a property read does not, so
    // reading the property turned this into a use-after-free and took the shell
    // down with it.
    //
    // The placement paths no longer gate on this at all - they let the
    // operations report a dead window by throwing.
    _isWindowAlive(window) {
        if (!window) return false;

        try {
            return window.check_alive(global.get_current_time()) === true;
        } catch (e) {
            this._debugLog(`check_alive() failed: ${e.message}`);
            return false;
        }
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

    // Find the neighbouring monitor of fromMonitor in the given direction.
    // Returns the monitor index, or -1 when there is no neighbour.
    //
    // Compares monitor *centres* rather than raw x/y: monitors side by side
    // often have different heights (1920x1080 next to 1280x1024), so their y
    // origins differ and any grouping by geo.y would file them in different
    // rows even though they sit next to each other.
    //
    // Ranking, in order:
    //   1. must lie strictly on the correct side on the main axis
    //   2. prefer monitors overlapping on the cross axis (directly beside)
    //   3. otherwise the closest one on the main axis
    _getAdjacentMonitor(fromMonitor, direction) {
        const nMonitors = global.display.get_n_monitors();
        if (nMonitors < 2) return -1;

        const fromGeo = global.display.get_monitor_geometry(fromMonitor);
        if (!fromGeo) return -1;
        const fromCx = fromGeo.x + fromGeo.width / 2;
        const fromCy = fromGeo.y + fromGeo.height / 2;

        let best = -1;
        let bestOverlaps = false;
        let bestDist = 0;

        for (let i = 0; i < nMonitors; i++) {
            if (i === fromMonitor) continue;
            const geo = global.display.get_monitor_geometry(i);
            if (!geo) continue;

            const cx = geo.x + geo.width / 2;
            const cy = geo.y + geo.height / 2;

            let forward, overlaps, dist;
            switch (direction) {
                case 'left':
                    forward = cx < fromCx;
                    overlaps = fromGeo.y < geo.y + geo.height && geo.y < fromGeo.y + fromGeo.height;
                    dist = fromCx - cx;
                    break;
                case 'right':
                    forward = cx > fromCx;
                    overlaps = fromGeo.y < geo.y + geo.height && geo.y < fromGeo.y + fromGeo.height;
                    dist = cx - fromCx;
                    break;
                case 'up':
                    forward = cy < fromCy;
                    overlaps = fromGeo.x < geo.x + geo.width && geo.x < fromGeo.x + fromGeo.width;
                    dist = fromCy - cy;
                    break;
                case 'down':
                    forward = cy > fromCy;
                    overlaps = fromGeo.x < geo.x + geo.width && geo.x < fromGeo.x + fromGeo.width;
                    dist = cy - fromCy;
                    break;
                default:
                    this._debugLog(`Unknown direction: ${direction}`);
                    return -1;
            }

            if (!forward) continue;
            // `dist` is always positive for accepted candidates
            if (best === -1 ||
                (overlaps && !bestOverlaps) ||
                (overlaps === bestOverlaps && dist < bestDist)) {
                best = i;
                bestOverlaps = overlaps;
                bestDist = dist;
            }
        }

        this._debugLog(`Adjacent monitor ${direction} of M${fromMonitor}: ${best}`);
        return best;
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
            this._addManagedTimeout(50, () => {
                if (this._isWindowAlive(w)) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Only bind a WS when moving TO primary; the move onto the primary
            // is what decides the workspace, so this cannot be a plain
            // change_workspace() here. See _bindWindowToWorkspace().
            if (monitor2 === primaryMonitor && newGlobalWsObj) {
                this._bindWindowToWorkspace(window, newGlobalWs, shortTitle);
                this._debugLog(`  "${shortTitle}" -> M${monitor2}(PRIMARY) at (${newX},${newY}) ${width}x${height}, bound to WS${newGlobalWs}`);
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
            this._addManagedTimeout(50, () => {
                if (this._isWindowAlive(w)) {
                    w.move_resize_frame(false, finalX, finalY, finalW, finalH);
                }
                return GLib.SOURCE_REMOVE;
            });

            // Only bind a WS when moving TO primary; the move onto the primary
            // is what decides the workspace, so this cannot be a plain
            // change_workspace() here. See _bindWindowToWorkspace().
            if (monitor1 === primaryMonitor && newGlobalWsObj) {
                this._bindWindowToWorkspace(window, newGlobalWs, shortTitle);
                this._debugLog(`  "${shortTitle}" -> M${monitor1}(PRIMARY) at (${newX},${newY}) ${width}x${height}, bound to WS${newGlobalWs}`);
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

    // ========== Timer Management ==========

    // Add a timeout that will be automatically cleaned up on disable()
    _addManagedTimeout(delay, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._pendingTimeoutIds.delete(id);
            if (this._settings === null) {
                // Extension has been disabled, skip callback
                return GLib.SOURCE_REMOVE;
            }
            return callback();
        });
        this._pendingTimeoutIds.add(id);
        return id;
    }

    // Add an idle callback that will be automatically cleaned up on disable()
    _addManagedIdle(callback) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingTimeoutIds.delete(id);
            if (this._settings === null) {
                return GLib.SOURCE_REMOVE;
            }
            return callback();
        });
        this._pendingTimeoutIds.add(id);
        return id;
    }

    // Cancel a specific managed timeout
    _cancelManagedTimeout(id) {
        if (id && this._pendingTimeoutIds.has(id)) {
            GLib.source_remove(id);
            this._pendingTimeoutIds.delete(id);
        }
    }

    // Clear all pointer restore timeouts
    _clearPointerRestoreTimeouts() {
        for (const id of this._pointerRestoreTimeoutIds) {
            this._cancelManagedTimeout(id);
        }
        this._pointerRestoreTimeoutIds = [];
    }

    // Clear all managed timeouts (called on disable)
    _clearAllManagedTimeouts() {
        // Clear specific tracked timeouts
        this._clearPointerRestoreTimeouts();

        if (this._focusRestoreTimeoutId) {
            this._cancelManagedTimeout(this._focusRestoreTimeoutId);
            this._focusRestoreTimeoutId = null;
        }

        if (this._internalSwitchTimeoutId) {
            this._cancelManagedTimeout(this._internalSwitchTimeoutId);
            this._internalSwitchTimeoutId = null;
        }

        if (this._animationRestoreTimeoutId) {
            this._cancelManagedTimeout(this._animationRestoreTimeoutId);
            this._animationRestoreTimeoutId = null;
        }

        if (this._restoreWindowsTimeoutId) {
            this._cancelManagedTimeout(this._restoreWindowsTimeoutId);
            this._restoreWindowsTimeoutId = null;
        }

        // Clear all remaining pending timeouts
        for (const id of this._pendingTimeoutIds) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Ignore errors for already-removed sources
            }
        }
        this._pendingTimeoutIds.clear();
    }

    // ========== Debug Logging ==========

    _initDebugLog() {
        try {
            // Release the previous stream before truncating, otherwise the old
            // append handle would keep writing at its stale offset.
            if (this._debugLogStream) {
                try {
                    this._debugLogStream.close(null);
                } catch (e) {
                    // already closed
                }
                this._debugLogStream = null;
            }
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

        // One long-lived append stream for the whole session. Opening a fresh
        // stream per line made back-to-back writes race each other on the file
        // offset and silently drop roughly every other line, which made the log
        // useless for diagnosing before/after behaviour.
        try {
            if (!this._debugLogStream) {
                const file = Gio.File.new_for_path(DEBUG_LOG_PATH);
                this._debugLogStream = file.append_to(Gio.FileCreateFlags.NONE, null);
            }
            this._debugLogStream.write_all(line, null);
        } catch (e) {
            // Drop the stream so the next call reopens it
            this._debugLogStream = null;
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
