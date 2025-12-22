// WorkspaceMapper - Monitor-Workspace mapping management
// Manages the relationship between monitors and workspaces (Spectrwm style)

export class WorkspaceMapper {
    // monitorIndex -> workspaceIndex mapping
    _monitorToWorkspace = new Map();

    constructor(monitorManager) {
        this._monitorManager = monitorManager;
    }

    /**
     * Set the workspace for a specific monitor
     * @param {number} monitorIndex - Monitor index
     * @param {number} workspaceIndex - Workspace index to assign
     */
    setMapping(monitorIndex, workspaceIndex) {
        this._monitorToWorkspace.set(monitorIndex, workspaceIndex);
    }

    /**
     * Get the workspace currently assigned to a monitor
     * @param {number} monitorIndex - Monitor index
     * @returns {number} Workspace index (defaults to 0 if not set)
     */
    getWorkspaceForMonitor(monitorIndex) {
        return this._monitorToWorkspace.get(monitorIndex) ?? 0;
    }

    /**
     * Find which monitor is displaying a specific workspace
     * @param {number} workspaceIndex - Workspace index to find
     * @returns {number|null} Monitor index, or null if not displayed
     */
    getMonitorForWorkspace(workspaceIndex) {
        for (const [monitor, workspace] of this._monitorToWorkspace) {
            if (workspace === workspaceIndex) {
                return monitor;
            }
        }
        return null;
    }

    /**
     * Check if a workspace is currently displayed on any monitor
     * @param {number} workspaceIndex - Workspace index to check
     * @returns {boolean} True if workspace is displayed
     */
    isWorkspaceDisplayed(workspaceIndex) {
        return this.getMonitorForWorkspace(workspaceIndex) !== null;
    }

    /**
     * Get all current mappings
     * @returns {Map<number, number>} Map of monitorIndex -> workspaceIndex
     */
    getAllMappings() {
        return new Map(this._monitorToWorkspace);
    }

    /**
     * Get a list of workspaces that are currently displayed
     * @returns {number[]} Array of workspace indices
     */
    getDisplayedWorkspaces() {
        return Array.from(this._monitorToWorkspace.values());
    }

    /**
     * Clear all mappings
     */
    clear() {
        this._monitorToWorkspace.clear();
    }

    /**
     * Get mapping as a debug string
     * @returns {string} Debug representation of current mappings
     */
    toString() {
        const mappings = [];
        for (const [monitor, workspace] of this._monitorToWorkspace) {
            mappings.push(`M${monitor}->WS${workspace}`);
        }
        return `[${mappings.join(', ')}]`;
    }
}
