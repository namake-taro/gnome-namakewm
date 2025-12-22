// WindowVisibilityManager - Window visibility control
// Controls which windows are visible based on monitor-workspace mapping

export class WindowVisibilityManager {
    // windowId -> workspaceIndex (logical workspace assignment)
    _windowWorkspaceMap = new Map();

    // windowId -> { wasMinimized: boolean } (original state for restoration)
    _windowOriginalState = new Map();

    constructor(monitorManager, workspaceMapper) {
        this._monitorManager = monitorManager;
        this._workspaceMapper = workspaceMapper;
    }

    /**
     * Assign a window to a logical workspace
     * @param {Meta.Window} window - Window to assign
     * @param {number} workspaceIndex - Workspace index
     */
    assignWindowToWorkspace(window, workspaceIndex) {
        if (!window) return;
        const windowId = this._getWindowId(window);
        this._windowWorkspaceMap.set(windowId, workspaceIndex);
    }

    /**
     * Get the logical workspace a window belongs to
     * @param {Meta.Window} window - Window to check
     * @returns {number|null} Workspace index, or null if not assigned
     */
    getWindowWorkspace(window) {
        if (!window) return null;
        const windowId = this._getWindowId(window);
        return this._windowWorkspaceMap.get(windowId) ?? null;
    }

    /**
     * Update visibility of a single window based on current mappings
     * @param {Meta.Window} window - Window to update
     */
    updateWindowVisibility(window) {
        if (!window) return;
        if (window.is_skip_taskbar()) return;
        if (window.get_window_type() !== 0) return; // NORMAL windows only

        const windowId = this._getWindowId(window);
        const windowWorkspace = this._windowWorkspaceMap.get(windowId);

        // If window has no assigned workspace, assign based on current monitor
        if (windowWorkspace === undefined) {
            const monitorIndex = window.get_monitor();
            const workspaceForMonitor = this._workspaceMapper.getWorkspaceForMonitor(monitorIndex);
            this.assignWindowToWorkspace(window, workspaceForMonitor);
            // Window should be visible (it's on its assigned workspace)
            this._showWindow(window);
            return;
        }

        // Check if window's workspace is currently displayed on its monitor
        const windowMonitor = window.get_monitor();
        const displayedWorkspace = this._workspaceMapper.getWorkspaceForMonitor(windowMonitor);

        if (windowWorkspace === displayedWorkspace) {
            // Window's workspace is displayed on its monitor -> show
            this._showWindow(window);
        } else {
            // Window's workspace is not displayed on its monitor -> hide
            this._hideWindow(window);
        }
    }

    /**
     * Update visibility of all windows on a specific monitor
     * @param {number} monitorIndex - Monitor index
     */
    updateWindowsForMonitor(monitorIndex) {
        const allWindows = this._monitorManager.getAllWindows();

        for (const window of allWindows) {
            const windowMonitor = window.get_monitor();
            if (windowMonitor === monitorIndex) {
                this.updateWindowVisibility(window);
            }
        }
    }

    /**
     * Update visibility of all windows
     */
    updateAllWindowsVisibility() {
        const allWindows = this._monitorManager.getAllWindows();

        for (const window of allWindows) {
            this.updateWindowVisibility(window);
        }
    }

    /**
     * Restore all windows to visible state (for extension disable)
     */
    restoreAllWindows() {
        const allWindows = this._monitorManager.getAllWindows();

        for (const window of allWindows) {
            this._restoreWindow(window);
        }

        this._windowWorkspaceMap.clear();
        this._windowOriginalState.clear();
    }

    /**
     * Show a window (make visible)
     * @param {Meta.Window} window - Window to show
     * @private
     */
    _showWindow(window) {
        if (!window) return;

        const windowId = this._getWindowId(window);
        const originalState = this._windowOriginalState.get(windowId);

        // Only unminimize if we minimized it (not if user minimized it)
        if (originalState && originalState.hiddenByExtension) {
            try {
                window.unminimize();
                originalState.hiddenByExtension = false;
            } catch (e) {
                console.error('[MultiMonitorsWorkspace] Error showing window:', e);
            }
        }
    }

    /**
     * Hide a window (make invisible)
     * @param {Meta.Window} window - Window to hide
     * @private
     */
    _hideWindow(window) {
        if (!window) return;

        const windowId = this._getWindowId(window);

        // Save original state if not already saved
        if (!this._windowOriginalState.has(windowId)) {
            this._windowOriginalState.set(windowId, {
                wasMinimized: window.minimized,
                hiddenByExtension: false
            });
        }

        const originalState = this._windowOriginalState.get(windowId);

        // Only minimize if not already minimized
        if (!window.minimized) {
            try {
                window.minimize();
                originalState.hiddenByExtension = true;
            } catch (e) {
                console.error('[MultiMonitorsWorkspace] Error hiding window:', e);
            }
        }
    }

    /**
     * Restore a window to its original state
     * @param {Meta.Window} window - Window to restore
     * @private
     */
    _restoreWindow(window) {
        if (!window) return;

        const windowId = this._getWindowId(window);
        const originalState = this._windowOriginalState.get(windowId);

        if (originalState && originalState.hiddenByExtension) {
            try {
                // Restore to original minimized state
                if (!originalState.wasMinimized) {
                    window.unminimize();
                }
            } catch (e) {
                console.error('[MultiMonitorsWorkspace] Error restoring window:', e);
            }
        }
    }

    /**
     * Get a unique identifier for a window
     * @param {Meta.Window} window - Window
     * @returns {string} Unique window ID
     * @private
     */
    _getWindowId(window) {
        // Use stable ID if available, otherwise fall back to XID or hash
        if (window.get_stable_sequence) {
            return `stable-${window.get_stable_sequence()}`;
        }
        return `xid-${window.get_xwindow?.() ?? window.toString()}`;
    }

    /**
     * Move a window's workspace assignment to a new workspace
     * (Used when moving windows between workspaces)
     * @param {Meta.Window} window - Window to move
     * @param {number} newWorkspaceIndex - New workspace index
     */
    moveWindowToWorkspace(window, newWorkspaceIndex) {
        if (!window) return;
        this.assignWindowToWorkspace(window, newWorkspaceIndex);
        this.updateWindowVisibility(window);
    }

    /**
     * Get debug info about current window assignments
     * @returns {string} Debug string
     */
    toString() {
        const assignments = [];
        for (const [windowId, workspace] of this._windowWorkspaceMap) {
            assignments.push(`${windowId}->WS${workspace}`);
        }
        return `WindowAssignments: [${assignments.join(', ')}]`;
    }
}
