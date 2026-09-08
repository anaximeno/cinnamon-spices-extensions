const Main = imports.ui.main;
const Settings = imports.ui.settings;

const { LauncherDialog } = require('./launcher.js');

const HOTKEY_ID = "cinnabon-launcher-open";

let uuid = null;
let dialog = null;
let settings = null;
let settingsTarget = null;

function init(metadata) {
    uuid = metadata.uuid;
}

function enable() {
    dialog = new LauncherDialog();

    settingsTarget = { open_launcher: "<Control>Super_L::<Control>space", show_frequent_apps: true };
    settings = new Settings.ExtensionSettings(settingsTarget, uuid);
    settings.bind("open-launcher", "open_launcher", setKeybinding);
    settings.bind("show-frequent-apps", "show_frequent_apps", setShowFrequentApps);

    setKeybinding();
    setShowFrequentApps();
}

function setKeybinding() {
    Main.keybindingManager.removeHotKey(HOTKEY_ID);
    Main.keybindingManager.addHotKey(HOTKEY_ID, settingsTarget.open_launcher, () => dialog.toggle());
}

function setShowFrequentApps() {
    dialog.setShowFrequentApps(settingsTarget.show_frequent_apps);
}

function disable() {
    Main.keybindingManager.removeHotKey(HOTKEY_ID);

    settings.finalize();
    settings = null;
    settingsTarget = null;

    dialog.destroy();
    dialog = null;
}
