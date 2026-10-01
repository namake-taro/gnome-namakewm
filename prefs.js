// GNOME Shell 46 Extension Preferences
// ESModules format (required for GNOME 45+)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as BingWallpaper from './lib/bingWallpaper.js';

// System keybinding schemas to check for conflicts
const SYSTEM_KEYBINDING_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
];

// How many app rows the chooser shows at most. The list is rebuilt on every
// keystroke, and no one scrolls past a few hundred entries anyway.
const APP_CHOOSER_LIMIT = 150;

// Every installed application, as
// [{ name, genericName, wmClass, icon, declared, searchText }], sorted by
// display name and deduplicated by WM_CLASS.
//
// The apps come from Gio.AppInfo.get_all(), which walks XDG_DATA_DIRS and
// therefore also sees everything installed as flatpak or snap. Scanning
// /usr/share/applications by hand, as this used to do, missed those entirely.
//
// WM_CLASS is the string a running window reports, so getting it right is the
// whole point of the list. It is taken from StartupWMClass when the desktop file
// declares one, but only a handful of the installed apps bother: a list built
// from that key alone held ~20 entries and no Files at all. So the desktop file
// id is the fallback ("org.gnome.Nautilus.desktop" -> "org.gnome.Nautilus"),
// which is exactly what a GApplication-based app - i.e. nearly every modern
// GNOME app - reports as its WM_CLASS. Rows built that way are flagged with
// declared: false so the chooser can say where the value came from.
//
// Dedup keeps the declared WM_CLASS over a derived one, because several .desktop
// files can share an id-derived value (a "bin" variant of the same app, say)
// and the same app listed twice is just confusing.
function listInstalledApps() {
    const byWmClass = new Map();

    for (const info of Gio.AppInfo.get_all()) {
        const id = info.get_id();
        if (!id || !id.endsWith('.desktop')) continue;

        // NoDisplay and Hidden are not exposed as properties, so the desktop
        // file itself is read for them - and for StartupWMClass, which is not a
        // property either.
        const keyFile = new GLib.KeyFile();
        try {
            keyFile.load_from_file(info.get_filename(), GLib.KeyFileFlags.NONE);
        } catch (e) {
            continue; // Not a readable key file
        }

        const readString = (key) => {
            try {
                return keyFile.get_string('Desktop Entry', key);
            } catch (e) {
                return null;
            }
        };

        if (readString('NoDisplay') === 'true') continue;
        if (readString('Hidden') === 'true') continue;

        const name = info.get_display_name() || readString('Name') || id;
        const genericName = readString('GenericName') || '';

        const declaredWmClass = readString('StartupWMClass');
        const wmClass = declaredWmClass || id.replace(/\.desktop$/, '');
        const key = wmClass.toLowerCase();

        const app = {
            name,
            genericName,
            wmClass,
            icon: info.get_icon(),
            declared: Boolean(declaredWmClass),
            // Everything the search runs against, so "naut", "files" and the
            // raw WM_CLASS all find the same app.
            searchText: `${name} ${genericName} ${wmClass}`.toLowerCase(),
        };

        const existing = byWmClass.get(key);
        if (existing) {
            // Several desktop files can declare the same WM_CLASS - Emacs
            // ships emacs.desktop and emacsclient.desktop, both with
            // StartupWMClass=Emacs - and Gio.AppInfo.get_all() hands them back
            // in an unspecified order, so "first one wins" would pick the
            // client wrapper over the editor on some systems and the other way
            // round on others. Score the candidates instead:
            //
            //   2: the WM_CLASS is the desktop file id, i.e. the canonical app
            //      (emacs.desktop declares Emacs, emacsclient.desktop declares
            //      Emacs too but is called emacsclient)
            //   1: a WM_CLASS was actually declared rather than derived
            //   0: everything else
            //
            // The id is the final tiebreak so the result never depends on the
            // order the desktop files came in.
            const idBase = id.replace(/\.desktop$/, '').toLowerCase();
            const score = (candidate) => (candidate.wmClass.toLowerCase() === idBase ? 2 : 0) +
                (candidate.declared ? 1 : 0);

            if (score(app) > score(existing) ||
                (score(app) === score(existing) && id < existing.id)) {
                app.id = id;
                byWmClass.set(key, app);
            }
            continue;
        }
        app.id = id;
        byWmClass.set(key, app);
    }

    return [...byWmClass.values()].sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// How well `needle` matches `haystack`, higher is better, or null when it does
// not match at all.
//
// Substring matches always beat scattered ones ("fire" finding "Firefox" rather
// than "FreeCAD Remote"), and an earlier hit beats a later one, so the obvious
// answer floats to the top. Everything else is a subsequence match, which is
// what makes "nttl" or "ffx" find Nautilus and Firefox.
function fuzzyScore(haystack, needle) {
    if (needle === '') return 0;

    const direct = haystack.indexOf(needle);
    if (direct >= 0) {
        // A match at a word boundary is worth more than one in the middle of a
        // word, hence the extra bonus for starting right after a space.
        const boundary = direct === 0 || haystack[direct - 1] === ' ';
        return 1000 - direct + (boundary ? 100 : 0);
    }

    let score = 200;
    let at = 0;
    for (const char of needle) {
        const found = haystack.indexOf(char, at);
        if (found < 0) return null;

        // Consecutive characters and word starts are what a human means, so
        // they are worth more than hopping over the rest of the name.
        if (found === at) score += 5;
        else if (found === 0 || haystack[found - 1] === ' ') score += 3;
        else score -= Math.min(2, found - at - 1);

        at = found + 1;
    }

    // A long name that barely matches is worse than a short one that matches
    // just as well.
    return score - haystack.length * 0.05;
}

// Ask the user for an application and resolve with its WM_CLASS, or null when
// the dialog was cancelled.
//
// The app picker is a dialog with a search field rather than a dropdown on
// purpose: a plain list of 200 entries cannot be scanned, let alone searched.
// Typing something that matches no installed app offers it as-is, which is the
// way to enter a WM_CLASS for an app that is not installed (a Wine window, or
// one that is only started at login).
function chooseApplication(parent, apps, currentWmClass) {
    return new Promise(resolve => {
        const dialog = new Gtk.Dialog({
            transient_for: parent,
            modal: true,
            title: 'Choose Application',
            default_width: 480,
            default_height: 560,
        });
        const selectButton = dialog.add_button('Select', Gtk.ResponseType.OK);
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.set_default_response(Gtk.ResponseType.OK);
        selectButton.set_sensitive(false);

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search by name or WM_CLASS',
            hexpand: true,
        });

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['boxed-list'],
        });
        listBox.connect('row-activated', (_box, row) => {
            dialog.response(Gtk.ResponseType.OK);
        });
        // Double-click confirmation, independent of GtkListBox's own
        // row-activated, which does not come through when this dialog is hosted
        // in the shell's preferences popup. The gesture is non-exclusive so the
        // list keeps handling single clicks for selecting; only n_press >= 2
        // acts, and the row that is selected at that moment is accepted.
        const accept = () => {
            if (closed) return;
            if (selected === null) return; // Nothing chosen yet
            dialog.response(Gtk.ResponseType.OK);
        };
        const doubleClick = new Gtk.GestureClick();
        doubleClick.set_button(Gdk.BUTTON_PRIMARY);
        doubleClick.set_exclusive(false);
        doubleClick.connect('released', (_gesture, nPress) => {
            if (nPress >= 2) accept();
        });
        listBox.add_controller(doubleClick);

        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
            min_content_height: 360,
        });
        scroller.set_child(listBox);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        content.append(searchEntry);
        content.append(scroller);
        dialog.get_content_area().append(content);

        let selected = null;
        const clearList = () => {
            let child = listBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                listBox.remove(child);
                child = next;
            }
        };

        const setSelected = (wmClass) => {
            selected = wmClass;
            selectButton.set_sensitive(Boolean(wmClass));
        };

        const addRow = (app) => {
            const row = new Adw.ActionRow({
                title: app.name,
                // The WM_CLASS is what actually gets matched, and it is the one
                // thing about the row the user cannot see otherwise, so it is
                // spelled out here. Derived values say so, since those are the
                // ones worth double-checking.
                subtitle: app.declared === false
                    ? `${app.wmClass} (guessed from the desktop file id)`
                    : app.wmClass,
            });
            if (app.icon) {
                const image = new Gtk.Image({
                    gicon: app.icon,
                    pixel_size: 32,
                });
                image.set_valign(Gtk.Align.CENTER);
                row.add_prefix(image);
            }
            // The list rows are plain widgets, so the WM_CLASS they stand for
            // rides along as a property. A model would be the tidier way but
            // then the rows have to be rebuilt on every keystroke anyway.
            row._wmClass = app.wmClass;
            listBox.append(row);
            return row;
        };

        const applyFilter = () => {
            const query = searchEntry.get_text().trim();
            clearList();
            setSelected(null);

            let matches;
            if (query === '') {
                matches = apps.slice(0, APP_CHOOSER_LIMIT);
            } else {
                matches = apps
                    .map((app) => ({ app, score: fuzzyScore(app.searchText, query) }))
                    .filter((m) => m.score !== null)
                    .sort((a, b) => b.score - a.score ||
                a.app.name.localeCompare(b.app.name, undefined, { sensitivity: 'base' }))
                    .slice(0, APP_CHOOSER_LIMIT)
                    .map((m) => m.app);

                // A WM_CLASS typed by hand is a legitimate answer even when no
                // installed app carries it. It goes last so it never hides the
                // app the query was really about.
                if (!apps.some((a) => a.wmClass.toLowerCase() === query.toLowerCase())) {
                    matches.push({
                        name: `Use "${query}" as WM_CLASS`,
                        wmClass: query,
                        icon: null,
                        declared: true,
                    });
                }
            }

            for (const app of matches) addRow(app);

            // Only reachable with an empty query and nothing installed, since a
            // non-empty query always ends up with at least its own "use this"
            // row.
            if (matches.length === 0) {
                listBox.append(new Adw.ActionRow({
                    title: 'No applications found',
                    subtitle: 'Type a WM_CLASS above to use it as it is',
                }));
                return;
            }

            // The best match is pre-selected, so Enter picks it without the user
            // having to click a row first. Selecting does not take the focus,
            // which stays in the search field for the next character.
            listBox.select_row(listBox.get_row_at_index(0));
        };

        // Fill the list right away, while the dialog is still unmapped, and
        // only preselect later: focusing a row of a list that has not been
        // allocated yet does not scroll to it, so the app the rule points at
        // would sit below the fold with the list still showing the top.
        // Grabbing focus a second time does not help either - that is a no-op on
        // a row that already has the focus.
        const preselect = () => {
            if (!currentWmClass) return;

            const index = apps.findIndex(
                (a) => a.wmClass.toLowerCase() === currentWmClass.toLowerCase());
            if (index < 0) {
                // Not installed (any more): show it so it stays visible and
                // selectable instead of silently jumping to the first app.
                const row = addRow({
                    name: currentWmClass,
                    wmClass: currentWmClass,
                    icon: null,
                    declared: true,
                });
                listBox.select_row(row);
                row.grab_focus();
                return;
            }

            // The search field is still empty, so the rows are the app list in
            // order and the index is the row.
            const row = listBox.get_row_at_index(index);
            if (row) {
                listBox.select_row(row);
                row.grab_focus();
            }
        };

        // Connected before the first applyFilter(), because that call preselects
        // the best-matching row. A row-selected that fires before this handler
        // exists is lost, which left `selected` at null: the Select button stayed
        // insensitive and accepting the already-selected row answered with no
        // app at all.
        listBox.connect('row-selected', (_box, row) => {
            setSelected(row?._wmClass ?? null);
        });
        applyFilter();

        searchEntry.connect('search-changed', applyFilter);

        // The first idle after the dialog is mapped is early enough that the
        // list is allocated by then, and late enough that this is still before
        // the user can do anything.
        let closed = false;
        let scheduled = false;
        dialog.connect('map', () => {
            if (scheduled) return; // Not on an unmap/map cycle
            scheduled = true;
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                if (closed) return GLib.SOURCE_REMOVE;
                preselect();
                return GLib.SOURCE_REMOVE;
            });
        });

        dialog.connect('response', (_dialog, response) => {
            closed = true;
            const wmClass = response === Gtk.ResponseType.OK ? selected : null;
            dialog.destroy();
            resolve(wmClass);
        });

        dialog.present();
    });
}

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
        // Add relative monitor navigation keys
        for (const direction of ['left', 'right', 'up', 'down']) {
            extensionKeys.push(`mmw-warp-to-adjacent-${direction}`);
            extensionKeys.push(`mmw-move-window-to-adjacent-${direction}`);
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
                // A numeric "bing" selects the Bing wallpaper of the day,
                // counted back from today. Absent means a plain image file.
                if (groups[this._groupIndex].bing !== undefined &&
                    groups[this._groupIndex].bing !== null) {
                    this._source = 'bing';
                    this._bing = groups[this._groupIndex].bing;
                } else {
                    this._source = 'file';
                    this._bing = 0;
                }
            } else {
                this._path = '';
                this._workspaces = [];
                this._scale = true;
                this._tile = false;
                this._source = 'file';
                this._bing = 0;
            }
        } catch (e) {
            this._path = '';
            this._workspaces = [];
            this._scale = true;
            this._tile = false;
            this._source = 'file';
            this._bing = 0;
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

            const group = {
                path: this._path,
                workspaces: this._workspaces,
                scale: this._scale,
                tile: this._tile,
            };
            // Only persist "bing" for Bing groups, so switching a group back to
            // a plain file leaves no stale field behind.
            if (this._source === 'bing') {
                group.bing = this._bing;
                group.path = '';
            }
            groups[this._groupIndex] = group;

            this._settings.set_string('wallpaper-groups', JSON.stringify(groups));
            this._onUpdate();
        } catch (e) {
            log(`[NamakeWM] Failed to save wallpaper group: ${e.message}`);
        }
    }

    _updateSubtitle() {
        const wsDisplay = this._workspaces.map(ws => ws === 9 ? 0 : ws + 1).join(', ');
        let what;
        if (this._source === 'bing') {
            what = `Bing: ${BingWallpaper.dayLabel(this._bing)}`;
        } else {
            what = this._path ? this._path.split('/').pop() : 'No image';
        }
        this.set_subtitle(`WS: ${wsDisplay || 'None'} | ${what}`);
    }

    _openSettingsDialog() {
        const parentWindow = this.get_root();

        // Use Adw.Dialog for GNOME 46+ (works regardless of attach-modal-dialogs setting)
        //
        // Kept narrow on purpose. The preferences window is itself a popup, and a
        // dialog wider than that window gets clipped, which would put the right
        // hand side of every row - including whatever a row opens - out of reach.
        // The workspace buttons wrap onto two rows so the content itself stays
        // narrow enough for this width to actually take effect.
        // The height is left to the content instead of being pinned, so the dialog
        // cannot outgrow a short window either.
        const dialog = new Adw.Dialog({
            title: `Wallpaper Group ${this._groupIndex + 1}`,
            content_width: 300,
            content_height: -1,
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

        // Two rows of five. A single row of ten toggle buttons forces a minimum
        // width of roughly 390px, which is wider than the preferences window and
        // got the dialog clipped until it was dragged smaller by hand.
        const wsRows = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });

        for (let start = 0; start < 10; start += 5) {
            const wsRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 4,
                homogeneous: true,
            });

            for (let i = start; i < start + 5; i++) {
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
                wsRow.append(btn);
            }

            wsRows.append(wsRow);
        }
        wsSection.append(wsRows);
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

        const bingAvailable = BingWallpaper.isAvailable();

        // --- Source picker: plain file or Bing wallpaper of the day ---
        // Bing is only offered when that extension has actually downloaded
        // something, so the option never leads to an empty workspace.
        //
        // Toggle buttons rather than an Adw.ComboRow on purpose. A ComboRow is a
        // GtkPopover, and the preferences window is itself a popup, so the row's
        // popover ended up nested inside another popup and never came up. The
        // preferences get a plain window in a normal session, where the same code
        // looks fine, which is why this only ever showed up here.
        const sourceBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 0,
            homogeneous: true,
        });
        const fileSourceBtn = new Gtk.ToggleButton({
            label: 'Image File',
            active: !(bingAvailable && this._source === 'bing'),
        });
        const bingSourceBtn = new Gtk.ToggleButton({
            label: 'Bing of the Day',
            active: bingAvailable && this._source === 'bing',
            sensitive: bingAvailable,
        });
        sourceBox.append(fileSourceBtn);
        sourceBox.append(bingSourceBtn);
        imageSection.append(sourceBox);
        if (!bingAvailable) {
            imageSection.append(new Gtk.Label({
                label: 'Bing unavailable - no wallpapers found in the download folder',
                xalign: 0,
                wrap: true,
                css_classes: ['dim-label'],
            }));
        }

        const applySource = () => {
            // Toggle buttons report "activate" for the one clicked and "activate"
            // again for the one released, so the explicit active states are
            // read instead of trusting the signal.
            const wantBing = bingSourceBtn.get_active();
            fileSourceBtn.set_active(!wantBing);
            bingSourceBtn.set_active(wantBing);
            this._source = wantBing ? 'bing' : 'file';
            this._saveGroupData();
            this._updateSubtitle();
            updateBingVisibility();
        };
        fileSourceBtn.connect('toggled', applySource);
        bingSourceBtn.connect('toggled', applySource);

        // --- Bing day picker ---
        // A spin button, again for the same reason: a numeric choice needs no
        // popover, and it also makes an offset that has no download yet visible
        // instead of hiding it.
        let bingDayRow = null;
        let bingInfo = null;
        if (bingAvailable) {
            const maxOffset = BingWallpaper.maxBingOffset();

            bingDayRow = new Adw.SpinRow({
                title: 'Days ago',
                subtitle: '0 is today, 1 is yesterday',
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: maxOffset,
                    step_increment: 1,
                    page_increment: 1,
                    value: this._bing,
                }),
            });

            bingInfo = new Gtk.Label({
                label: '',
                ellipsize: Pango.EllipsizeMode.END,
                xalign: 0,
                wrap: true,
                css_classes: ['dim-label'],
            });
            const refreshBingInfo = () => {
                const offset = this._bing;
                const resolved = BingWallpaper.resolveBingWallpaper(offset);
                if (!resolved) {
                    bingInfo.set_label(
                        'No image downloaded for this day yet - it appears once BingWallpaper fetches it'
                    );
                } else if (resolved.exact) {
                    bingInfo.set_label(`${BingWallpaper.dayLabel(offset)} - ${resolved.path.split('/').pop()}`);
                } else {
                    // The requested day has no download yet, so the newest older
                    // image is used. Saying "today" while showing yesterday's image
                    // is misleading, so name the image's real age instead.
                    const age = resolved.ageDays ?? 1;
                    bingInfo.set_label(
                        `${BingWallpaper.dayLabel(offset)} has no image yet, using ` +
                        `${BingWallpaper.dayLabel(age).toLowerCase()} - ${resolved.path.split('/').pop()}`);
                }
            };
            refreshBingInfo();

            bingDayRow.connect('notify::value', () => {
                this._bing = Math.round(bingDayRow.get_value());
                refreshBingInfo();
                this._saveGroupData();
                this._updateSubtitle();
            });

            imageSection.append(bingDayRow);
            imageSection.append(bingInfo);
        }

        // Only one of the two sources' rows is ever useful at a time. Driven
        // from one place so the file picker and the day picker cannot disagree
        // about what is showing. fileRow does not exist yet at this point, so
        // the first call happens further down once it has been built.
        const updateBingVisibility = () => {
            const isBing = bingAvailable && this._source === 'bing';
            fileRow.visible = !isBing;
            if (bingDayRow) bingDayRow.visible = isBing;
            if (bingInfo) bingInfo.visible = isBing;
        };

        const fileRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        const imageLabel = new Gtk.Label({
            label: this._path ? this._path.split('/').pop() : 'No image selected',
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            xalign: 0,
        });

        const chooseBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Select image',
        });
        chooseBtn.connect('clicked', () => {
            this._chooseFile(parentWindow, imageLabel);
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

        fileRow.append(imageLabel);
        fileRow.append(chooseBtn);
        fileRow.append(clearBtn);
        imageSection.append(fileRow);
        updateBingVisibility();
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
        dialog.present(parentWindow);
    }

    _chooseFile(parentWindow, imageLabel) {
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

        fileDialog.open(parentWindow, null, (dlg, result) => {
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

        // Flat single-row layout for the panel indicator
        const flatIndicatorRow = new Adw.SwitchRow({
            title: 'Flat Panel Indicator',
            subtitle: 'Show all monitors in one row, left to right. Turn this off to ' +
                'group them into several panel rows by vertical position',
        });
        behaviorGroup.add(flatIndicatorRow);

        settings.bind(
            'flat-panel-indicator',
            flatIndicatorRow,
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

        // Focus follows mouse
        const focusFollowsRow = new Adw.SwitchRow({
            title: 'Focus Follows Mouse',
            subtitle: 'Focus a window as soon as the mouse moves over it, no click needed. ' +
                'Switching Mutter\'s focus-mode; the old value is restored when the ' +
                'extension is disabled',
        });
        behaviorGroup.add(focusFollowsRow);

        settings.bind(
            'focus-follows-mouse',
            focusFollowsRow,
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

        // ===========================================
        // Workspaces & Apps Page
        //
        // Everything that decides where a window ends up: which workspace a
        // monitor shows after login, and which workspace a given application's
        // window is sent to. Kept apart from the keybinding and highlight
        // groups on the General page, because these are assignment rules
        // rather than navigation.
        // ===========================================
        const workspacesPage = new Adw.PreferencesPage({
            title: 'Workspaces & Apps',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(workspacesPage);

        // Which workspace each monitor shows after login
        const startupGroup = new Adw.PreferencesGroup({
            title: 'Startup Workspace per Monitor',
            description: 'Which workspace each monitor shows after logging in. "Auto" gives the primary ' +
                'monitor the workspace that is currently active and the other monitors the next free ones. ' +
                'Two monitors can never end up on the same workspace.',
        });
        workspacesPage.add(startupGroup);

        // Read the current assignment so we can pre-select the rows
        let configuredMap = new Map();
        try {
            const stored = settings.get_strv('monitor-workspace-map');
            if (stored.length > 0) {
                const parsed = JSON.parse(stored[0]);
                if (Array.isArray(parsed)) {
                    for (const entry of parsed) {
                        if (Number.isInteger(entry?.monitor) && Number.isInteger(entry?.workspace)) {
                            configuredMap.set(entry.monitor, entry.workspace);
                        }
                    }
                }
            }
        } catch (e) {
            // Broken value: start over with everything on Auto
            configuredMap = new Map();
        }

        // Workspace names: index 0 is "Workspace 1" for the user.
        // NOTE: build the list with append() - new Gtk.StringList([...]) tries to
        // interpret the array as construct properties and throws.
        const workspaceLabels = ['Auto'];
        for (let w = 1; w <= 10; w++) workspaceLabels.push(`Workspace ${w}`);

        // A combo row per connected monitor. "Auto" means index -1 internally.
        const rowsForMonitors = [];
        for (const monitor of Array.from({length: nMonitors}, (_, idx) => idx)) {
            const workspaceModel = new Gtk.StringList();
            for (const label of workspaceLabels) workspaceModel.append(label);

            const row = new Adw.ComboRow({
                title: `Monitor ${monitor}`,
                subtitle: monitor === 0
                    ? 'Leftmost by default. "Auto" keeps the workspace you are on when you log in'
                    : 'Leave on "Auto" to be assigned the next free workspace',
                model: workspaceModel,
            });

            const configured = configuredMap.get(monitor);
            row.set_selected(configured === undefined ? 0 : configured + 1);

            row.connect('notify::selected', () => {
                const selected = row.get_selected();

                // Rebuild the whole map from the current row values so removing
                // an assignment on one monitor does not clobber the others
                const next = new Map(configuredMap);
                if (selected === 0) {
                    next.delete(monitor);
                } else {
                    next.set(monitor, selected - 1);
                }

                // Two monitors may not share a workspace. The monitor the user
                // just changed wins, any other monitor holding that workspace
                // falls back to Auto.
                const seen = new Set();
                const ordered = [[monitor, next.get(monitor)], ...[...next]
                    .filter(([mon]) => mon !== monitor)
                    .sort((a, b) => a[0] - b[0])];
                for (const [mon, ws] of ordered) {
                    if (next.get(mon) === undefined) continue;
                    if (seen.has(ws)) {
                        next.delete(mon);
                    } else {
                        seen.add(ws);
                    }
                }

                const payload = JSON.stringify(
                    [...next].sort((a, b) => a[0] - b[0]).map(([mon, ws]) => ({ monitor: mon, workspace: ws }))
                );
                settings.set_strv('monitor-workspace-map', payload);

                // Keep the in-memory copy in sync and reflect the change in the
                // other rows, since one of them may have been dropped above
                configuredMap.clear();
                for (const [mon, ws] of next) configuredMap.set(mon, ws);
                for (const other of rowsForMonitors) {
                    if (other.monitor === monitor) continue;
                    const ws = configuredMap.get(other.monitor);
                    other.row.set_selected(ws === undefined ? 0 : ws + 1);
                }
            });

            rowsForMonitors.push({ monitor, row });
            startupGroup.add(row);
        }

        // ------------------------------------------------------------------
        // Per-application startup workspace
        // ------------------------------------------------------------------
        const appGroup = new Adw.PreferencesGroup({
            title: 'Startup App on Workspace',
            description: 'Send a window to a chosen workspace without ever switching to it, so the ' +
                'view stays where you are. The window goes to the monitor that shows that workspace, ' +
                'or stays on the primary if no monitor shows it. ' +
                '"Only at startup" applies within the first 30 seconds after ' +
                'login, which covers autostarted apps; "Always" applies every time the app opens. ' +
                'Each window is moved once, so a window you move yourself afterwards stays where you put it. ' +
                '"Add Application Rule" opens a searchable list of everything installed; the WM_CLASS of a ' +
                'rule is the string a window has to report to be matched.',
        });
        workspacesPage.add(appGroup);

        // Default for rules that do not carry their own answer. Reading it once
        // here keeps the per-rule switches below independent of the global one.
        const maximizeDefault = () => settings.get_boolean('maximize-app-windows');

        const maximizeDefaultRow = new Adw.SwitchRow({
            title: 'Maximize by Default',
            subtitle: 'What a newly added rule starts with. Each rule can override this on its own',
        });
        appGroup.add(maximizeDefaultRow);
        settings.bind(
            'maximize-app-windows',
            maximizeDefaultRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Current rules, kept as a plain array so a change can rewrite the
        // whole list instead of trying to patch one entry in place.
        let appRules = [];
        try {
            const stored = settings.get_string('app-workspace-map');
            if (stored && stored.trim() !== '') {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    appRules = parsed.filter(
                        (e) => typeof e?.wmClass === 'string' && e.wmClass.trim() !== '' &&
                            Number.isInteger(e?.workspace) && e.workspace >= 0 && e.workspace <= 9);
                }
            }
        } catch (e) {
            appRules = [];
        }

        const knownApps = listInstalledApps();

        const persistAppRules = () => {
            settings.set_string('app-workspace-map', JSON.stringify(appRules));
        };

        // The display name of an app, falling back to the WM_CLASS for apps
        // that are not installed - the header of a rule is read far more often
        // than it is set, so it gets the name rather than the internal string.
        const appLabel = (wmClass) =>
            knownApps.find((a) => a.wmClass.toLowerCase() === wmClass.toLowerCase())?.name ?? wmClass;

        // Build one rule as an Adw.ExpanderRow, i.e. a real Adw.PreferencesRow
        // whose children are added through add_row().
        //
        // The shape matters: a ComboRow nested in a raw Gtk.Box inside the
        // group did not open its popover in the preferences dialog, while
        // ComboRows added straight to a group do. Expanding by default keeps
        // all three choices visible without a second click.
        const addAppRuleRow = (rule) => {
            const header = new Adw.ExpanderRow({
                title: appLabel(rule.wmClass),
                subtitle: 'Startup rule',
                expanded: true,
            });

            // --- Application ---
            // A button opening the searchable chooser, not a dropdown: the
            // installed list is ~200 apps long, and a dropdown that long is
            // unusable no matter how it scrolls.
            const appRow = new Adw.ActionRow({
                title: 'Application',
                subtitle: rule.wmClass,
            });

            const chooseBtn = new Gtk.Button({
                label: 'Choose…',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            appRow.add_suffix(chooseBtn);
            appRow.set_activatable_widget(chooseBtn);

            // --- Workspace ---
            const wsModel = new Gtk.StringList();
            for (let w = 1; w <= 10; w++) wsModel.append(`Workspace ${w}`);

            const wsRow = new Adw.ComboRow({
                title: 'Workspace',
                subtitle: 'The window opens here',
                model: wsModel,
            });
            wsRow.selected = rule.workspace;

            // --- Scope ---
            const scopeModel = new Gtk.StringList();
            scopeModel.append('Only at startup');
            scopeModel.append('Always');

            const scopeRow = new Adw.ComboRow({
                title: 'Applies',
                subtitle: 'Only at startup covers autostarted apps after login',
                model: scopeModel,
            });
            scopeRow.selected = rule.scope === 'always' ? 1 : 0;

            // --- Maximize ---
            // Starts out at the default, but the field is only written once the
            // user actually touches the switch: a rule that carries no "maximize"
            // follows "Maximize by Default", so changing the default later still
            // moves the rules that never expressed an opinion.
            const maximizeRow = new Adw.SwitchRow({
                title: 'Open Maximized',
                subtitle: 'Fill the monitor it was moved to',
            });
            maximizeRow.active = rule.maximize ?? maximizeDefault();

            // Writing back on every change keeps the stored list in sync with
            // the widgets without an explicit save button.
            const writeBack = () => {
                rule.workspace = wsRow.selected;
                rule.scope = scopeRow.selected === 1 ? 'always' : 'startup';
                header.set_title(appLabel(rule.wmClass));
                header.set_subtitle(
                    `Workspace ${rule.workspace + 1} · ${rule.scope === 'always' ? 'Always' : 'Only at startup'}` +
                    `${maximizeRow.active ? ' · maximized' : ''}`);
                persistAppRules();
            };

            const writeBackMaximize = () => {
                rule.maximize = maximizeRow.active;
                writeBack();
            };

            chooseBtn.connect('clicked', async () => {
                const picked = await chooseApplication(chooseBtn.get_root(), knownApps, rule.wmClass);
                if (!picked) return; // Cancelled
                rule.wmClass = picked;
                appRow.set_subtitle(picked);
                writeBack();
            });

            wsRow.connect('notify::selected', writeBack);
            scopeRow.connect('notify::selected', writeBack);
            maximizeRow.connect('notify::active', writeBackMaximize);
            writeBack();

            header.add_row(appRow);
            header.add_row(wsRow);
            header.add_row(scopeRow);
            header.add_row(maximizeRow);

            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove this rule',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeBtn.connect('clicked', () => {
                const idx = appRules.indexOf(rule);
                if (idx >= 0) appRules.splice(idx, 1);
                persistAppRules();
                header.get_parent()?.remove(header);
            });
            header.add_suffix(removeBtn);

            appGroup.add(header);
        };

        for (const rule of appRules) addAppRuleRow(rule);

        const addRuleBtn = new Gtk.Button({
            label: 'Add Application Rule',
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            css_classes: ['suggested-action'],
        });
        // The app is picked before the row exists, so cancelling the chooser
        // leaves no half-configured rule behind.
        addRuleBtn.connect('clicked', async () => {
            const picked = await chooseApplication(addRuleBtn.get_root(), knownApps, '');
            if (!picked) return;
            const rule = {
                wmClass: picked,
                workspace: 0,
                scope: 'startup',
                // No "maximize" yet: the rule inherits the default until the
                // user says otherwise on its own switch.
            };
            appRules.push(rule);
            persistAppRules();
            addAppRuleRow(rule);
        });
        appGroup.add(addRuleBtn);

        // Relative navigation: warp pointer and focus to the neighbouring monitor
        const adjacentWarpGroup = new Adw.PreferencesGroup({
            title: 'Warp to Adjacent Monitor',
            description: 'Move pointer and focus to the neighbouring monitor in a direction',
        });
        page.add(adjacentWarpGroup);

        const DIRECTION_LABELS = { left: 'Left', right: 'Right', up: 'Up', down: 'Down' };
        for (const [direction, label] of Object.entries(DIRECTION_LABELS)) {
            adjacentWarpGroup.add(new ShortcutRow(
                settings,
                `mmw-warp-to-adjacent-${direction}`,
                `Monitor ${label}`,
                `Move pointer and focus to the monitor to the ${direction}`
            ));
        }

        // Relative navigation: move the focused window to the neighbour's workspace
        const adjacentMoveGroup = new Adw.PreferencesGroup({
            title: 'Move Window to Adjacent Monitor',
            description: 'Move the focused window to the workspace shown on the neighbouring monitor',
        });
        page.add(adjacentMoveGroup);

        for (const [direction, label] of Object.entries(DIRECTION_LABELS)) {
            adjacentMoveGroup.add(new ShortcutRow(
                settings,
                `mmw-move-window-to-adjacent-${direction}`,
                `Window to ${label}`,
                `Move focused window to the workspace on the monitor to the ${direction}`
            ));
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
