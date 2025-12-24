// GNOME Shell 46 Extension Preferences
// ESModules format (required for GNOME 45+)

import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// System keybinding schemas to check for conflicts
const SYSTEM_KEYBINDING_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
];

// Helper class for shortcut editing
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, subtitle) {
        super._init({ title, subtitle });

        this._settings = settings;
        this._key = key;

        // Shortcut label
        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        this._updateLabel();

        // Edit button
        this._editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._editButton.connect('clicked', () => this._startEditing());

        // Clear button
        this._clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._clearButton.connect('clicked', () => this._clearShortcut());

        // Box for buttons
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        box.append(this._shortcutLabel);
        box.append(this._editButton);
        box.append(this._clearButton);

        this.add_suffix(box);

        // Key capture controller
        this._keyController = new Gtk.EventControllerKey();
        this._keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            return this._onKeyPressed(keyval, keycode, state);
        });
    }

    _updateLabel() {
        const shortcuts = this._settings.get_strv(this._key);
        if (shortcuts.length > 0 && shortcuts[0] !== '') {
            this._shortcutLabel.set_accelerator(shortcuts[0]);
        } else {
            this._shortcutLabel.set_accelerator('');
        }
    }

    _startEditing() {
        // Create a dialog for capturing the shortcut
        const dialog = new Gtk.Dialog({
            title: 'Set Shortcut',
            modal: true,
            transient_for: this.get_root(),
        });
        dialog.set_default_size(300, 100);

        const label = new Gtk.Label({
            label: 'Press a key combination...\n(Escape to cancel)',
            margin_top: 20,
            margin_bottom: 20,
            margin_start: 20,
            margin_end: 20,
        });
        dialog.get_content_area().append(label);

        const keyController = new Gtk.EventControllerKey();
        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            // Filter out modifier-only presses
            if (this._isModifierKey(keyval)) {
                return Gdk.EVENT_PROPAGATE;
            }

            // Escape cancels
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            // Get modifier state (filter out lock keys)
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mask);

            if (accel) {
                dialog.close();
                this._checkAndSetShortcut(accel);
            } else {
                dialog.close();
            }

            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keyController);

        dialog.present();
    }

    // Check for conflicts and set shortcut (with confirmation if needed)
    _checkAndSetShortcut(accel) {
        const conflict = this._findConflict(accel);

        if (conflict) {
            this._showConflictDialog(accel, conflict);
        } else {
            this._applyShortcut(accel);
        }
    }

    // Find if the accelerator conflicts with system keybindings
    _findConflict(accel) {
        const normalizedAccel = accel.toLowerCase();

        // Check system keybinding schemas
        for (const schemaId of SYSTEM_KEYBINDING_SCHEMAS) {
            try {
                const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
                if (!schema) continue;

                const gsettings = new Gio.Settings({ settings_schema: schema });
                const keys = schema.list_keys();

                for (const key of keys) {
                    const shortcuts = gsettings.get_strv(key);
                    for (const shortcut of shortcuts) {
                        if (shortcut && shortcut.toLowerCase() === normalizedAccel) {
                            return {
                                schema: schemaId,
                                key: key,
                                name: this._formatKeyName(key),
                            };
                        }
                    }
                }
            } catch (e) {
                // Schema not available, skip
            }
        }

        // Check other shortcuts in this extension (exclude current key)
        const extensionKeys = [
            'mmw-cycle-focus-forward', 'mmw-cycle-focus-backward',
            'mmw-swap-window-forward', 'mmw-swap-window-backward',
        ];
        // Add warp-to-monitor keys
        for (let i = 0; i < 8; i++) {
            extensionKeys.push(`mmw-warp-to-monitor-${i}`);
        }

        for (const key of extensionKeys) {
            if (key === this._key) continue;  // Skip self

            try {
                const shortcuts = this._settings.get_strv(key);
                for (const shortcut of shortcuts) {
                    if (shortcut && shortcut.toLowerCase() === normalizedAccel) {
                        return {
                            schema: 'this extension',
                            key: key,
                            name: this._formatKeyName(key),
                        };
                    }
                }
            } catch (e) {
                // Key not found, skip
            }
        }

        return null;
    }

    // Format key name for display
    _formatKeyName(key) {
        return key
            .replace(/^mmw-/, '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    // Show conflict confirmation dialog
    _showConflictDialog(accel, conflict) {
        const dialog = new Adw.MessageDialog({
            heading: 'Shortcut Conflict',
            body: `"${accel}" is already used by:\n\n${conflict.name}\n(${conflict.schema})\n\nDo you want to override it?`,
            transient_for: this.get_root(),
            modal: true,
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('override', 'Override');
        dialog.set_response_appearance('override', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');

        dialog.connect('response', (dlg, response) => {
            if (response === 'override') {
                this._applyShortcut(accel);
            }
            dlg.close();
        });

        dialog.present();
    }

    // Apply the shortcut to settings
    _applyShortcut(accel) {
        this._settings.set_strv(this._key, [accel]);
        this._updateLabel();
    }

    _isModifierKey(keyval) {
        return keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R ||
               keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
               keyval === Gdk.KEY_Alt_L || keyval === Gdk.KEY_Alt_R ||
               keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R ||
               keyval === Gdk.KEY_Meta_L || keyval === Gdk.KEY_Meta_R;
    }

    _clearShortcut() {
        this._settings.set_strv(this._key, []);
        this._updateLabel();
    }

    _onKeyPressed(keyval, keycode, state) {
        return Gdk.EVENT_PROPAGATE;
    }
});

// Helper class for wallpaper group configuration (simple row with settings dialog)
const WallpaperGroupRow = GObject.registerClass(
class WallpaperGroupRow extends Adw.ActionRow {
    _init(settings, groupIndex, onDelete, onUpdate) {
        super._init({
            title: `Wallpaper Group ${groupIndex + 1}`,
            subtitle: 'Select workspaces and wallpaper',
        });

        this._settings = settings;
        this._groupIndex = groupIndex;
        this._onDelete = onDelete;
        this._onUpdate = onUpdate;

        // Load current group data
        this._loadGroupData();

        // Button box
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        // Settings button (opens dialog)
        const settingsBtn = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Configure',
        });
        settingsBtn.connect('clicked', () => this._openSettingsDialog());
        buttonBox.append(settingsBtn);

        // Delete button
        const deleteBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['destructive-action'],
            tooltip_text: 'Delete',
        });
        deleteBtn.connect('clicked', () => {
            this._onDelete(this._groupIndex);
        });
        buttonBox.append(deleteBtn);

        this.add_suffix(buttonBox);

        // Update subtitle with loaded data
        this._updateSubtitle();
    }

    _loadGroupData() {
        try {
            const groupsJson = this._settings.get_string('wallpaper-groups');
            const groups = JSON.parse(groupsJson);
            if (groups[this._groupIndex]) {
                this._path = groups[this._groupIndex].path || '';
                this._workspaces = groups[this._groupIndex].workspaces || [];
                this._scale = groups[this._groupIndex].scale !== false; // default true
                this._tile = groups[this._groupIndex].tile === true; // default false
            } else {
                this._path = '';
                this._workspaces = [];
                this._scale = true;
                this._tile = false;
            }
        } catch (e) {
            this._path = '';
            this._workspaces = [];
            this._scale = true;
            this._tile = false;
        }
    }

    _saveGroupData() {
        try {
            const groupsJson = this._settings.get_string('wallpaper-groups');
            const groups = JSON.parse(groupsJson);

            // Ensure array is large enough
            while (groups.length <= this._groupIndex) {
                groups.push({ path: '', workspaces: [], scale: true, tile: false });
            }

            groups[this._groupIndex] = {
                path: this._path,
                workspaces: this._workspaces,
                scale: this._scale,
                tile: this._tile,
            };

            this._settings.set_string('wallpaper-groups', JSON.stringify(groups));
            this._onUpdate();
        } catch (e) {
            log(`[NamakeWM] Failed to save wallpaper group: ${e.message}`);
        }
    }

    _updateSubtitle() {
        const wsDisplay = this._workspaces.map(ws => ws === 9 ? 0 : ws + 1).join(', ');
        const filename = this._path ? this._path.split('/').pop() : 'No image';
        this.set_subtitle(`WS: ${wsDisplay || 'None'} | ${filename}`);
    }

    _openSettingsDialog() {
        const parentWindow = this.get_root();

        const dialog = new Gtk.Window({
            title: `Wallpaper Group ${this._groupIndex + 1}`,
            transient_for: parentWindow,
            modal: true,
            default_width: 400,
            default_height: 380,
        });

        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });

        // --- Workspace selection section ---
        const wsFrame = new Gtk.Frame();
        const wsSection = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 10,
            margin_end: 10,
        });
        const wsTitle = new Gtk.Label({
            label: 'Workspaces',
            xalign: 0,
            css_classes: ['title-4'],
        });
        wsSection.append(wsTitle);

        const wsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            homogeneous: true,
        });

        const wsButtons = [];
        for (let i = 0; i < 10; i++) {
            const wsNum = i === 9 ? 0 : i + 1;
            const btn = new Gtk.ToggleButton({
                label: String(wsNum),
            });
            btn.set_active(this._workspaces.includes(i));
            btn.connect('toggled', () => {
                if (btn.get_active()) {
                    if (!this._workspaces.includes(i)) {
                        this._workspaces.push(i);
                        this._workspaces.sort((a, b) => a - b);
                    }
                } else {
                    this._workspaces = this._workspaces.filter(ws => ws !== i);
                }
                this._saveGroupData();
                this._updateSubtitle();
            });
            wsButtons.push(btn);
            wsBox.append(btn);
        }
        wsSection.append(wsBox);
        wsFrame.set_child(wsSection);
        mainBox.append(wsFrame);

        // --- Image selection section ---
        const imageFrame = new Gtk.Frame();
        const imageSection = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 10,
            margin_end: 10,
        });
        const imageTitle = new Gtk.Label({
            label: 'Wallpaper Image',
            xalign: 0,
            css_classes: ['title-4'],
        });
        imageSection.append(imageTitle);

        const imageBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        const imageLabel = new Gtk.Label({
            label: this._path ? this._path.split('/').pop() : 'No image selected',
            ellipsize: 3, // PANGO_ELLIPSIZE_END
            hexpand: true,
            xalign: 0,
        });

        const chooseBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Select image',
        });
        chooseBtn.connect('clicked', () => {
            this._chooseFile(dialog, imageLabel);
        });

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Clear image',
        });
        clearBtn.connect('clicked', () => {
            this._path = '';
            imageLabel.set_label('No image selected');
            this._saveGroupData();
            this._updateSubtitle();
        });

        imageBox.append(imageLabel);
        imageBox.append(chooseBtn);
        imageBox.append(clearBtn);
        imageSection.append(imageBox);
        imageFrame.set_child(imageSection);
        mainBox.append(imageFrame);

        // --- Display options section ---
        const optionsFrame = new Gtk.Frame();
        const optionsSection = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 10,
            margin_end: 10,
        });
        const optionsTitle = new Gtk.Label({
            label: 'Display Options',
            xalign: 0,
            css_classes: ['title-4'],
        });
        optionsSection.append(optionsTitle);

        // Scale switch
        const scaleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        const scaleLabel = new Gtk.Label({
            label: 'Scale to Fit',
            hexpand: true,
            xalign: 0,
        });
        const scaleSwitch = new Gtk.Switch({
            active: this._scale,
            valign: Gtk.Align.CENTER,
        });
        scaleSwitch.connect('notify::active', () => {
            this._scale = scaleSwitch.get_active();
            this._saveGroupData();
        });
        scaleBox.append(scaleLabel);
        scaleBox.append(scaleSwitch);
        optionsSection.append(scaleBox);

        // Tile switch
        const tileBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        const tileLabel = new Gtk.Label({
            label: 'Tile',
            hexpand: true,
            xalign: 0,
        });
        const tileSwitch = new Gtk.Switch({
            active: this._tile,
            valign: Gtk.Align.CENTER,
        });
        tileSwitch.connect('notify::active', () => {
            this._tile = tileSwitch.get_active();
            this._saveGroupData();
        });
        tileBox.append(tileLabel);
        tileBox.append(tileSwitch);
        optionsSection.append(tileBox);

        optionsFrame.set_child(optionsSection);
        mainBox.append(optionsFrame);

        // --- Spacer to push close button to bottom ---
        const spacer = new Gtk.Box({ vexpand: true });
        mainBox.append(spacer);

        // Close button
        const closeBtn = new Gtk.Button({
            label: 'Close',
            halign: Gtk.Align.END,
        });
        closeBtn.connect('clicked', () => {
            dialog.close();
        });
        mainBox.append(closeBtn);

        dialog.set_child(mainBox);
        dialog.present();
    }

    _chooseFile(parentDialog, imageLabel) {
        const fileDialog = new Gtk.FileDialog({
            title: 'Select Wallpaper Image',
            modal: true,
        });

        // Set up file filter for images
        const filter = new Gtk.FileFilter();
        filter.set_name('Images');
        filter.add_mime_type('image/jpeg');
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/webp');
        filter.add_mime_type('image/bmp');

        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);
        fileDialog.set_filters(filters);
        fileDialog.set_default_filter(filter);

        // Set initial folder if path exists
        if (this._path) {
            try {
                const file = Gio.File.new_for_path(this._path);
                const parent = file.get_parent();
                if (parent) {
                    fileDialog.set_initial_folder(parent);
                }
            } catch (e) {
                // Ignore
            }
        }

        fileDialog.open(parentDialog, null, (dlg, result) => {
            try {
                const file = dlg.open_finish(result);
                if (file) {
                    this._path = file.get_path();
                    imageLabel.set_label(this._path.split('/').pop());
                    this._saveGroupData();
                    this._updateSubtitle();
                }
            } catch (e) {
                // User cancelled or error
            }
        });
    }
});

export default class MultiMonitorsWorkspacePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // Behavior group
        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'Workspace and window behavior settings',
        });
        page.add(behaviorGroup);

        // Workspace indicator toggle
        const indicatorRow = new Adw.SwitchRow({
            title: 'Workspace Indicator',
            subtitle: 'Show workspace numbers for each monitor in the top panel',
        });
        behaviorGroup.add(indicatorRow);

        settings.bind(
            'show-workspace-indicator',
            indicatorRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Warp pointer toggle
        const warpPointerRow = new Adw.SwitchRow({
            title: 'Warp Pointer to Focus',
            subtitle: 'Move pointer to window center when focus changes via keyboard',
        });
        behaviorGroup.add(warpPointerRow);

        settings.bind(
            'warp-pointer-to-focus',
            warpPointerRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Raise on cycle focus toggle
        const raiseOnCycleRow = new Adw.SwitchRow({
            title: 'Raise Window on Cycle Focus',
            subtitle: 'Raise window to top when cycling focus with keyboard shortcuts',
        });
        behaviorGroup.add(raiseOnCycleRow);

        settings.bind(
            'raise-on-cycle-focus',
            raiseOnCycleRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Warp to workspace instead of swap toggle
        const warpToWsRow = new Adw.SwitchRow({
            title: 'Warp to Workspace Instead of Swap',
            subtitle: 'Move pointer to monitor showing target workspace instead of swapping workspaces',
        });
        behaviorGroup.add(warpToWsRow);

        // Bind with inversion: setting 'warp' = true, 'swap' = false
        // We need manual binding since we're converting string to boolean
        warpToWsRow.set_active(settings.get_string('workspace-switch-mode') === 'warp');
        warpToWsRow.connect('notify::active', () => {
            settings.set_string('workspace-switch-mode', warpToWsRow.get_active() ? 'warp' : 'swap');
        });
        settings.connect('changed::workspace-switch-mode', () => {
            warpToWsRow.set_active(settings.get_string('workspace-switch-mode') === 'warp');
        });

        // Popup banner toggle
        const popupBannerRow = new Adw.SwitchRow({
            title: 'Popup Banner',
            subtitle: 'Show brief notification when switching workspace or display',
        });
        behaviorGroup.add(popupBannerRow);

        settings.bind(
            'show-popup-banner',
            popupBannerRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Keybindings group
        const keybindingsGroup = new Adw.PreferencesGroup({
            title: 'Keybindings',
            description: 'Keyboard shortcuts for workspace control',
        });
        page.add(keybindingsGroup);

        // Modifier key selector
        const modifierRow = new Adw.ComboRow({
            title: 'Modifier Key',
            subtitle: 'Mod+1~9,0: Switch workspace on current monitor\nMod+Shift+1~9,0: Move focused window to workspace',
        });

        const modifierModel = new Gtk.StringList();
        modifierModel.append('Alt');
        modifierModel.append('Super');
        modifierModel.append('Ctrl');
        modifierRow.set_model(modifierModel);

        // Set current value
        const currentMod = settings.get_string('workspace-modifier');
        const modIndex = ['Alt', 'Super', 'Ctrl'].indexOf(currentMod);
        modifierRow.set_selected(modIndex >= 0 ? modIndex : 0);

        // Handle changes
        modifierRow.connect('notify::selected', () => {
            const selected = modifierRow.get_selected();
            const modifiers = ['Alt', 'Super', 'Ctrl'];
            settings.set_string('workspace-modifier', modifiers[selected]);
        });

        keybindingsGroup.add(modifierRow);

        // Cycle focus shortcuts
        const cycleFocusForwardRow = new ShortcutRow(
            settings,
            'mmw-cycle-focus-forward',
            'Cycle Focus Forward',
            'Focus next window in current workspace'
        );
        keybindingsGroup.add(cycleFocusForwardRow);

        const cycleFocusBackwardRow = new ShortcutRow(
            settings,
            'mmw-cycle-focus-backward',
            'Cycle Focus Backward',
            'Focus previous window in current workspace'
        );
        keybindingsGroup.add(cycleFocusBackwardRow);

        // Swap window position forward
        const swapWindowForwardRow = new ShortcutRow(
            settings,
            'mmw-swap-window-forward',
            'Swap Window Forward',
            'Swap position/size with next window'
        );
        keybindingsGroup.add(swapWindowForwardRow);

        // Swap window position backward
        const swapWindowBackwardRow = new ShortcutRow(
            settings,
            'mmw-swap-window-backward',
            'Swap Window Backward',
            'Swap position/size with previous window'
        );
        keybindingsGroup.add(swapWindowBackwardRow);

        // Warp pointer to monitor section
        const warpGroup = new Adw.PreferencesGroup({
            title: 'Warp Pointer to Monitor',
            description: 'Set shortcuts to move pointer to monitor center and focus window there',
        });
        page.add(warpGroup);

        // Get current number of monitors
        const gdkDisplay = Gdk.Display.get_default();
        const monitors = gdkDisplay.get_monitors();
        const nMonitors = monitors.get_n_items();

        // Add shortcut rows for connected monitors only (using system index)
        for (let i = 0; i < nMonitors; i++) {
            const row = new ShortcutRow(
                settings,
                `mmw-warp-to-monitor-${i}`,
                `Monitor ${i}`,
                `Warp pointer to center of monitor ${i}`
            );
            warpGroup.add(row);
        }

        // Window Highlight group
        const windowHighlightGroup = new Adw.PreferencesGroup({
            title: 'Window Highlight',
            description: 'Draw colored lines on edges of the focused window',
        });
        page.add(windowHighlightGroup);

        // Window highlight edge toggles
        const windowTopRow = new Adw.SwitchRow({
            title: 'Top Edge',
            subtitle: 'Highlight top edge of focused window',
        });
        windowHighlightGroup.add(windowTopRow);
        settings.bind('window-highlight-top', windowTopRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const windowBottomRow = new Adw.SwitchRow({
            title: 'Bottom Edge',
            subtitle: 'Highlight bottom edge of focused window',
        });
        windowHighlightGroup.add(windowBottomRow);
        settings.bind('window-highlight-bottom', windowBottomRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const windowLeftRow = new Adw.SwitchRow({
            title: 'Left Edge',
            subtitle: 'Highlight left edge of focused window',
        });
        windowHighlightGroup.add(windowLeftRow);
        settings.bind('window-highlight-left', windowLeftRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const windowRightRow = new Adw.SwitchRow({
            title: 'Right Edge',
            subtitle: 'Highlight right edge of focused window',
        });
        windowHighlightGroup.add(windowRightRow);
        settings.bind('window-highlight-right', windowRightRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Window highlight thickness
        const windowThicknessRow = new Adw.ActionRow({
            title: 'Line Thickness',
            subtitle: 'Thickness of highlight lines in pixels',
        });
        const windowThicknessSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 20,
                step_increment: 1,
            }),
            valign: Gtk.Align.CENTER,
        });
        windowThicknessSpin.set_value(settings.get_int('window-highlight-thickness'));
        windowThicknessSpin.connect('value-changed', () => {
            settings.set_int('window-highlight-thickness', windowThicknessSpin.get_value());
        });
        windowThicknessRow.add_suffix(windowThicknessSpin);
        windowHighlightGroup.add(windowThicknessRow);

        // Window highlight color
        const windowColorRow = new Adw.ActionRow({
            title: 'Color',
            subtitle: 'Color of highlight lines',
        });
        const windowColorButton = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
        });
        const windowColor = new Gdk.RGBA();
        windowColor.parse(settings.get_string('window-highlight-color'));
        windowColorButton.set_rgba(windowColor);
        windowColorButton.connect('color-set', () => {
            const rgba = windowColorButton.get_rgba();
            const hex = '#' +
                Math.round(rgba.red * 255).toString(16).padStart(2, '0') +
                Math.round(rgba.green * 255).toString(16).padStart(2, '0') +
                Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
            settings.set_string('window-highlight-color', hex);
        });
        windowColorRow.add_suffix(windowColorButton);
        windowHighlightGroup.add(windowColorRow);

        // Display Highlight group
        const displayHighlightGroup = new Adw.PreferencesGroup({
            title: 'Display Highlight',
            description: 'Draw colored lines on edges of the current display (where pointer is)',
        });
        page.add(displayHighlightGroup);

        // Display highlight edge toggles
        const displayTopRow = new Adw.SwitchRow({
            title: 'Top Edge',
            subtitle: 'Highlight top edge of current display',
        });
        displayHighlightGroup.add(displayTopRow);
        settings.bind('display-highlight-top', displayTopRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const displayBottomRow = new Adw.SwitchRow({
            title: 'Bottom Edge',
            subtitle: 'Highlight bottom edge of current display',
        });
        displayHighlightGroup.add(displayBottomRow);
        settings.bind('display-highlight-bottom', displayBottomRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const displayLeftRow = new Adw.SwitchRow({
            title: 'Left Edge',
            subtitle: 'Highlight left edge of current display',
        });
        displayHighlightGroup.add(displayLeftRow);
        settings.bind('display-highlight-left', displayLeftRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const displayRightRow = new Adw.SwitchRow({
            title: 'Right Edge',
            subtitle: 'Highlight right edge of current display',
        });
        displayHighlightGroup.add(displayRightRow);
        settings.bind('display-highlight-right', displayRightRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Display highlight thickness
        const displayThicknessRow = new Adw.ActionRow({
            title: 'Line Thickness',
            subtitle: 'Thickness of highlight lines in pixels',
        });
        const displayThicknessSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 20,
                step_increment: 1,
            }),
            valign: Gtk.Align.CENTER,
        });
        displayThicknessSpin.set_value(settings.get_int('display-highlight-thickness'));
        displayThicknessSpin.connect('value-changed', () => {
            settings.set_int('display-highlight-thickness', displayThicknessSpin.get_value());
        });
        displayThicknessRow.add_suffix(displayThicknessSpin);
        displayHighlightGroup.add(displayThicknessRow);

        // Display highlight color
        const displayColorRow = new Adw.ActionRow({
            title: 'Color',
            subtitle: 'Color of highlight lines',
        });
        const displayColorButton = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
        });
        const displayColor = new Gdk.RGBA();
        displayColor.parse(settings.get_string('display-highlight-color'));
        displayColorButton.set_rgba(displayColor);
        displayColorButton.connect('color-set', () => {
            const rgba = displayColorButton.get_rgba();
            const hex = '#' +
                Math.round(rgba.red * 255).toString(16).padStart(2, '0') +
                Math.round(rgba.green * 255).toString(16).padStart(2, '0') +
                Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
            settings.set_string('display-highlight-color', hex);
        });
        displayColorRow.add_suffix(displayColorButton);
        displayHighlightGroup.add(displayColorRow);

        // Debug group
        const debugGroup = new Adw.PreferencesGroup({
            title: 'Debug',
            description: 'Debug and logging options',
        });
        page.add(debugGroup);

        // Debug mode toggle
        const debugRow = new Adw.SwitchRow({
            title: 'Debug Mode',
            subtitle: 'Enable debug logging to /tmp/mmw-debug.log',
        });
        debugGroup.add(debugRow);

        settings.bind(
            'debug-mode',
            debugRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // ===========================================
        // Wallpapers Page
        // ===========================================
        const wallpapersPage = new Adw.PreferencesPage({
            title: 'Wallpapers',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(wallpapersPage);

        // Enable wallpapers group
        const wallpapersEnableGroup = new Adw.PreferencesGroup({
            title: 'Per-Workspace Wallpapers',
            description: 'Display different wallpapers for each workspace on all monitors',
        });
        wallpapersPage.add(wallpapersEnableGroup);

        const enableWallpapersRow = new Adw.SwitchRow({
            title: 'Enable Per-Workspace Wallpapers',
            subtitle: 'Each workspace can have its own wallpaper',
        });
        wallpapersEnableGroup.add(enableWallpapersRow);

        settings.bind(
            'enable-workspace-wallpapers',
            enableWallpapersRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Wallpaper groups
        const wallpaperGroupsContainer = new Adw.PreferencesGroup({
            title: 'Wallpaper Groups',
            description: 'Configure wallpapers for specific workspaces. Unassigned workspaces use the system wallpaper.',
        });
        wallpapersPage.add(wallpaperGroupsContainer);

        // Track group rows for rebuilding
        let groupRows = [];

        const rebuildGroupRows = () => {
            // Remove existing rows
            for (const row of groupRows) {
                wallpaperGroupsContainer.remove(row);
            }
            groupRows = [];

            // Load groups from settings
            let groups = [];
            try {
                groups = JSON.parse(settings.get_string('wallpaper-groups'));
            } catch (e) {
                groups = [];
            }

            // Create rows for existing groups
            for (let i = 0; i < groups.length; i++) {
                const row = new WallpaperGroupRow(
                    settings,
                    i,
                    (index) => deleteGroup(index),
                    () => {} // onUpdate callback (for future use)
                );
                groupRows.push(row);
                wallpaperGroupsContainer.add(row);
            }
        };

        const deleteGroup = (index) => {
            try {
                let groups = JSON.parse(settings.get_string('wallpaper-groups'));
                groups.splice(index, 1);
                settings.set_string('wallpaper-groups', JSON.stringify(groups));
                rebuildGroupRows();
            } catch (e) {
                log(`[NamakeWM] Failed to delete wallpaper group: ${e.message}`);
            }
        };

        const addGroup = () => {
            try {
                let groups = JSON.parse(settings.get_string('wallpaper-groups'));
                groups.push({ path: '', workspaces: [] });
                settings.set_string('wallpaper-groups', JSON.stringify(groups));
                rebuildGroupRows();
            } catch (e) {
                log(`[NamakeWM] Failed to add wallpaper group: ${e.message}`);
            }
        };

        // Initial build
        rebuildGroupRows();

        // Add group button
        const addGroupRow = new Adw.ActionRow({
            title: 'Add Wallpaper Group',
            subtitle: 'Create a new wallpaper configuration',
            activatable: true,
        });

        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', () => addGroup());
        addGroupRow.add_suffix(addBtn);
        addGroupRow.connect('activated', () => addGroup());

        wallpaperGroupsContainer.add(addGroupRow);
    }
}
