// MonitorManager - Monitor detection and management
// Handles monitor-related operations

export class MonitorManager {
    /**
     * Get the monitor index where the mouse pointer is currently located
     * @returns {number} Monitor index (0-based)
     */
    getCurrentMonitor() {
        return global.display.get_current_monitor();
    }

    /**
     * Get the total number of monitors
     * @returns {number} Number of monitors
     */
    getMonitorCount() {
        return global.display.get_n_monitors();
    }

    /**
     * Get the geometry (position and size) of a specific monitor
     * @param {number} monitorIndex - Monitor index
     * @returns {Mtk.Rectangle} Monitor geometry with x, y, width, height
     */
    getMonitorGeometry(monitorIndex) {
        return global.display.get_monitor_geometry(monitorIndex);
    }

    /**
     * Get the primary monitor index
     * @returns {number} Primary monitor index
     */
    getPrimaryMonitor() {
        return global.display.get_primary_monitor();
    }

    /**
     * Check if a window is on a specific monitor
     * @param {Meta.Window} window - Window to check
     * @param {number} monitorIndex - Monitor index
     * @returns {boolean} True if window is on the specified monitor
     */
    isWindowOnMonitor(window, monitorIndex) {
        if (!window) return false;
        return window.get_monitor() === monitorIndex;
    }

    /**
     * Get all windows on a specific monitor
     * @param {number} monitorIndex - Monitor index
     * @returns {Meta.Window[]} Array of windows on the monitor
     */
    getWindowsOnMonitor(monitorIndex) {
        const windows = global.get_window_actors()
            .map(actor => actor.get_meta_window())
            .filter(window => {
                if (!window) return false;
                if (window.is_skip_taskbar()) return false;
                if (window.get_window_type() !== 0) return false; // NORMAL windows only
                return this.isWindowOnMonitor(window, monitorIndex);
            });
        return windows;
    }

    /**
     * Get all normal windows across all monitors
     * @returns {Meta.Window[]} Array of all normal windows
     */
    getAllWindows() {
        return global.get_window_actors()
            .map(actor => actor.get_meta_window())
            .filter(window => {
                if (!window) return false;
                if (window.is_skip_taskbar()) return false;
                if (window.get_window_type() !== 0) return false; // NORMAL windows only
                return true;
            });
    }

    /**
     * Check if monitor index is valid
     * @param {number} monitorIndex - Monitor index to check
     * @returns {boolean} True if valid
     */
    isValidMonitor(monitorIndex) {
        return monitorIndex >= 0 && monitorIndex < this.getMonitorCount();
    }
}
