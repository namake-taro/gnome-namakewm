# NamakeWM

A GNOME Shell extension that enables independent workspace management for each monitor, inspired by Spectrwm/Herbstluftwm-style workspace handling.

![Screenshot](./screenshot/screenshot.png)

![Workspace Indicator](./screenshot/screenshot_indicator.png)

## Features

- **Independent Workspaces per Monitor**: Each monitor can display a different workspace simultaneously
- **Workspace Swap**: When switching to a workspace already shown on another monitor, workspaces are swapped between monitors
- **Per-Workspace Wallpapers**: Set different wallpapers for each workspace, with scaling and tiling options, optionally reusing the Bing wallpaper of a given day
- **Per-App Startup Workspace**: Send a window of a chosen app to a chosen workspace without switching to it
- **Workspace Indicator**: Shows current workspace number for each monitor in the top panel
- **Popup Banner**: Brief notification when switching workspaces or displays
- **Focus Management**: Automatically focuses windows under the pointer, with focus restoration on workspace switch
- **Window/Display Highlight**: Draw colored lines on edges of focused window or current display
- **Customizable Keybindings**: Configure modifier keys (Alt/Super/Ctrl) and custom shortcuts

## Supported Versions

- GNOME Shell 45, 46, 47, 48, 49, 50

Note: GNOME Shell 50 is Wayland-only, so the X11 shell-restart workflow below is
not available there.

## Prerequisites

This extension requires the following GNOME settings:

| Setting | Required Value | Description |
|---------|---------------|-------------|
| `workspaces-only-on-primary` | `true` | Workspaces on primary display only |
| `dynamic-workspaces` | `false` | Fixed number of workspaces |

The extension will prompt to apply these settings automatically on first enable.

## Installation

### From GNOME Extensions (Recommended)

<!-- Add URL after publishing
Install with one click from [GNOME Extensions](https://extensions.gnome.org/extension/XXXX/namakewm/).
-->

*Coming soon*

### Manual Installation

1. Clone the repository

```bash
git clone https://github.com/namake-taro/gnome-namakewm.git
cd gnome-namakewm
```

2. Copy to extensions directory

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/gnome-namakewm@namake-taro.github.io
cp -r ./* ~/.local/share/gnome-shell/extensions/gnome-namakewm@namake-taro.github.io/
```

3. Compile schemas

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/gnome-namakewm@namake-taro.github.io/schemas/
```

4. Restart GNOME Shell
   - **Wayland** (GNOME 45–49): Log out and log back in
   - **X11** (GNOME 45–49): Press `Alt+F2`, type `r`, press `Enter` (see [Known Limitations](#known-limitations) if already enabled)
   - **GNOME 50**: Wayland-only — log out and log back in

5. Enable the extension

```bash
gnome-extensions enable gnome-namakewm@namake-taro.github.io
```

Or enable it from the Extensions app.

## Usage

### Default Keybindings

| Key | Action |
|-----|--------|
| `Alt+1` ~ `Alt+9`, `Alt+0` | Switch workspace on current monitor (WS1-WS9, WS10) |
| `Alt+Shift+1` ~ `Alt+Shift+0` | Move focused window to workspace |

### Workspace Behavior

- **Simple Switch**: When target workspace is not displayed on any monitor, simply switch to it
- **Swap**: When target workspace is already shown on another monitor, swap workspaces between the two monitors

Example:
```
Initial:  Monitor0=WS1, Monitor1=WS2, Monitor2=WS3
Action:   On Monitor0, press Alt+2 (switch to WS2)
Result:   Monitor0=WS2, Monitor1=WS1, Monitor2=WS3 (WS1 and WS2 swapped)
```

## Configuration

Open settings from the Extensions app, or run:

```bash
gnome-extensions prefs gnome-namakewm@namake-taro.github.io
```

### Workspaces & Apps Tab

Both workspace assignment rules live in their own tab:

- **Startup Workspace per Monitor** - which workspace each monitor shows after
  login. `Auto` gives the primary monitor the currently active workspace and the
  other monitors the next free ones; two monitors can never share a workspace.
- **Startup App on Workspace** - described below.
### Startup App on Workspace

Sends a window of a chosen application to a chosen workspace **without ever
switching to it** - the view stays exactly where you are, the window simply
waits on the other workspace until you go there. This is meant for autostarted
apps, which otherwise all end up on the workspace that happens to be active at
login (usually WS1).

Each rule has a scope:

| Scope | Behaviour |
|-------|-----------|
| **Only at startup** | Applies within the first 30 seconds after login, which covers autostarted apps and nothing else. |
| **Always** | Applies every time the app opens. |

**Open Maximized** is a switch per rule: that app's window is maximized right
after the move, so it fills the monitor it landed on. **Maximize by Default**
above the rule list is what a newly added rule starts with - a rule that carries
its own answer ignores it, so existing rules can be flipped en masse by changing
the default and individually overruled afterwards. Maximizing only ever adds: a
window you maximized yourself is never touched, an app that refuses to be
maximized is left as it is, and switching the option off restores nothing.

A rule sets the workspace and nothing else. It never activates the window -
activating a window also activates its workspace, which is exactly what the rule
is meant to avoid. The window does move to the monitor that *shows* the target
workspace, because a workspace number on its own means nothing without the
per-monitor assignment: with workspacing mode "primary only" Mutter only binds
the primary monitor's windows to the active workspace, every window on a
secondary monitor is sticky and visible on whichever workspace is active. So a
rule for WS3 on a setup where M0 shows WS3 puts the window on M0, right next to
the windows already living in that workspace. A workspace that no monitor shows
has nowhere to go and falls back to the primary, where the window waits for you
to switch to that workspace.

Picking the application opens a searchable list of everything installed, the
way Auto Move Windows does it: type a few letters, the best match is
pre-selected, Enter takes it. Icons and display names come from the desktop
entries, and a search also matches the raw WM_CLASS, so both `naut` and
`org.gnome.Nautilus` find Files. Something that matches no installed app can be
entered as WM_CLASS as it is - that is the way to cover a Wine window or an app
that is only started at login.

Where the WM_CLASS comes from:

- **Declared**: the `StartupWMClass` of the `.desktop` file, which is what
  Firefox and most older apps ship. These entries say so in the list.
- **Guessed**: the desktop file id (`org.gnome.Nautilus.desktop` becomes
  `org.gnome.Nautilus`). Only a handful of apps declare `StartupWMClass`, so
  this is what most entries use, and it is what a `GApplication`-based app -
  i.e. every modern GNOME app - reports as its WM_CLASS. Guessed entries are
  marked as such in the list.

Matching is case-insensitive, and a rule for `org.gnome.Nautilus` also matches a
window that reports the bare `nautilus`, so a wrong guess about the id does not
silently do nothing.

Each window is moved at most once. If you move it somewhere else yourself
afterwards, it stays there.

This overlaps with [Auto Move Windows](https://extensions.gnome.org/extension/4312/):
if both are active they will both move the same window and the last one to act
wins. Disable one of them.

### Behavior Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Workspace Indicator | Show workspace numbers in top panel | On |
| Popup Banner | Show notification on workspace/display change | On |
| Warp Pointer to Focus | Move pointer to window center on focus change | On |
| Raise Window on Cycle Focus | Raise window when cycling focus | On |
| Warp to Workspace Instead of Swap | Move pointer instead of swapping workspaces | Off |

### Keybinding Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Modifier Key | Modifier for workspace shortcuts | Alt |
| Cycle Focus Forward/Backward | Cycle through windows in current workspace | - |
| Swap Window Forward/Backward | Swap window position with next/previous | - |
| Warp to Monitor N | Move pointer to monitor center | - |

### Highlight Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Window Highlight | Draw lines on focused window edges | Off |
| Display Highlight | Draw lines on current display edges | Off |
| Line Thickness | Thickness in pixels | 3 |
| Color | Line color | Red/Green |

### Wallpaper Settings (Wallpapers tab)

| Setting | Description | Default |
|---------|-------------|---------|
| Enable Per-Workspace Wallpapers | Enable workspace-specific wallpapers | Off |
| Wallpaper Groups | Configure wallpaper for specific workspaces | - |

#### Wallpaper Group Options

Each wallpaper group allows you to:
- **Select Workspaces**: Choose which workspaces use this wallpaper (multiple selection)
- **Choose Image**: Select any image file (JPEG, PNG, WebP, BMP)
- **Scale to Fit**: Scale image to cover the screen (maintains aspect ratio)
- **Tile**: Repeat the image to fill the screen (image center aligns with screen center)

When a workspace has no assigned wallpaper, the system wallpaper is displayed.

## Known Limitations

### GNOME Shell Restart (Alt+F2 → r)

When restarting GNOME Shell using `Alt+F2` → `r` (X11 only, so GNOME 45–49), windows on secondary monitors may not be restored correctly. This is because the extension's `disable()` function is not called before the shell restarts.

This does not apply to GNOME 50, which dropped X11 session support entirely.

**Workaround**: Before restarting GNOME Shell, disable the extension first:

```bash
gnome-extensions disable gnome-namakewm@namake-taro.github.io
# Then restart GNOME Shell (Alt+F2 → r)
# After restart, re-enable the extension
gnome-extensions enable gnome-namakewm@namake-taro.github.io
```

Note: Screen lock/unlock works correctly without any workaround.

## Debugging

Enable debug mode in settings to log to `/tmp/mmw-debug.log`:

```bash
tail -f /tmp/mmw-debug.log
```

## Uninstall

```bash
gnome-extensions disable gnome-namakewm@namake-taro.github.io
rm -rf ~/.local/share/gnome-shell/extensions/gnome-namakewm@namake-taro.github.io
```

## License

GPL-3.0

## Author

[@namake-taro](https://github.com/namake-taro)
