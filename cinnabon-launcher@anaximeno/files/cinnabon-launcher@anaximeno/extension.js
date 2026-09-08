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

    settingsTarget = { open_launcher: "<Super>space" };
    settings = new Settings.ExtensionSettings(settingsTarget, uuid);
    settings.bind("open-launcher", "open_launcher", setKeybinding);

    setKeybinding();
}

function setKeybinding() {
    Main.keybindingManager.removeHotKey(HOTKEY_ID);
    Main.keybindingManager.addHotKey(HOTKEY_ID, settingsTarget.open_launcher, () => dialog.toggle());
}

function disable() {
    Main.keybindingManager.removeHotKey(HOTKEY_ID);

    settings.finalize();
    settings = null;
    settingsTarget = null;

    dialog.destroy();
    dialog = null;
}
