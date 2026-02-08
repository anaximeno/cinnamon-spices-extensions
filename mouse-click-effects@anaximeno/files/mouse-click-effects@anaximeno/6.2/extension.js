/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const Main = imports.ui.main;
const Settings = imports.ui.settings;
const DND = imports.ui.dnd;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;
const { Atspi, GLib, Gio } = imports.gi;

const { ClickAnimationFactory } = require('./clickAnimations.js');
const { Debouncer, logInfo, logError, safeDestroy } = require('./helpers.js');
const {
    UUID,
    PAUSE_EFFECTS_KEY,
    CLICK_DEBOUNCE_MS,
    ClickType,
    AnimationMode,
    MOUSE_BUTTON_EVENTS,
} = require('./constants.js');
const { MouseMovementTracker } = require('./mouseMovementTracker.js');

// Localization setup
Gettext.bindtextdomain(UUID, `${GLib.get_home_dir()}/.local/share/locale`);

/**
 * Get localized string
 * @param {string} text - Text to localize
 * @returns {string} Localized text
 */
function _(text) {
    const localized = Gettext.dgettext(UUID, text);
    return localized !== text ? localized : window._(text);
}

/**
 * Settings binding configuration
 * @typedef {Object} SettingBinding
 * @property {string} key - Settings key name
 * @property {string} value - Property name on extension
 * @property {Function|null} cb - Callback on change
 */

/**
 * Main extension class for mouse click effects
 */
class MouseClickEffects {
    constructor(metadata) {
        this.metadata = metadata;
        this._appIconsDir = `${metadata.path}/../icons`;
        this._pauseIconPath = `${this._appIconsDir}/extra/pause.svg`;

        // Initialize state
        this._coloredIconCache = new Map();
        this._clickAnimator = null;
        this._mouseMovementTracker = null;
        this._enableOnDragEnd = false;
        this._enabled = false;

        // Initialize data directory
        this._dataDir = this._initDataDir(metadata.uuid);

        // Setup settings
        this.settings = this._setupSettings(metadata.uuid);

        // Initialize animator
        this._clickAnimator = ClickAnimationFactory.createForMode(this.animation_mode);

        // Setup Atspi listener
        this._listener = Atspi.EventListener.new(this._onMouseClick.bind(this));

        // Setup debouncers
        this._displayClickDebouncer = new Debouncer();
        this._trackerUpdateDebouncer = new Debouncer();

        // Setup drag monitor
        DND.addDragMonitor(this);

        this._setActive(false);
    }

    /**
     * Initialize the cache data directory
     * @param {string} uuid - Extension UUID
     * @returns {string} Data directory path
     * @private
     */
    _initDataDir(uuid) {
        const dataDir = `${GLib.get_user_cache_dir()}/${uuid}`;
        const iconsDir = `${dataDir}/icons`;

        if (GLib.mkdir_with_parents(iconsDir, 0o777) < 0) {
            logError(`Failed to create cache dir at ${iconsDir}`);
            throw new Error(`Failed to create cache dir at ${iconsDir}`);
        }

        return dataDir;
    }

    /**
     * Setup extension settings bindings
     * @param {string} uuid - Extension UUID
     * @returns {Settings.ExtensionSettings} Settings instance
     * @private
     */
    _setupSettings(uuid) {
        const settings = new Settings.ExtensionSettings(this, uuid);

        /** @type {SettingBinding[]} */
        const bindings = [
            { key: 'animation-time', value: 'animation_time', cb: null },
            {
                key: 'icon-mode',
                value: 'icon_mode',
                cb: () => {
                    this._updateColoredIcons();
                    this._handleTrackerPropertyUpdate();
                },
            },
            {
                key: 'size',
                value: 'size',
                cb: () => this._handleTrackerPropertyUpdate(),
            },
            { key: 'idle-animation-mode', value: 'idle_animation_mode', cb: null },
            { key: 'idle-animation-period', value: 'idle_animation_period', cb: null },
            { key: 'idle-animation-delay', value: 'idle_animation_delay', cb: null },
            { key: 'left-click-effect-enabled', value: 'left_click_effect_enabled', cb: null },
            { key: 'right-click-effect-enabled', value: 'right_click_effect_enabled', cb: null },
            { key: 'middle-click-effect-enabled', value: 'middle_click_effect_enabled', cb: null },
            { key: 'pause-animation-effects-enabled', value: 'pause_animation_effects_enabled', cb: null },
            {
                key: 'mouse-movement-tracker-enabled',
                value: 'mouse_movement_tracker_enabled',
                cb: () => this._setActive(this._enabled),
            },
            {
                key: 'mouse-movement-tracker-persist-on-stopped-enabled',
                value: 'mouse_movement_tracker_persist_on_stopped_enabled',
                cb: () => this._handleTrackerPropertyUpdate(),
            },
            { key: 'mouse-idle-watcher-enabled', value: 'mouse_idle_watcher_enabled', cb: null },
            { key: 'left-click-color', value: 'left_click_color', cb: () => this._updateColoredIcons() },
            { key: 'middle-click-color', value: 'middle_click_color', cb: () => this._updateColoredIcons() },
            { key: 'right-click-color', value: 'right_click_color', cb: () => this._updateColoredIcons() },
            {
                key: 'mouse-movement-color',
                value: 'mouse_movement_color',
                cb: () => {
                    this._updateColoredIcons();
                    this._handleTrackerPropertyUpdate();
                },
            },
            { key: 'mouse-idle-watcher-color', value: 'mouse_idle_watcher_color', cb: () => this._updateColoredIcons() },
            {
                key: 'general-opacity',
                value: 'general_opacity',
                cb: () => this._handleTrackerPropertyUpdate(),
            },
            { key: 'animation-mode', value: 'animation_mode', cb: () => this._updateAnimationMode() },
            { key: 'pause-effects-binding', value: 'pause_effects_binding', cb: () => this._setKeybindings() },
            { key: 'deactivate-in-fullscreen', value: 'deactivate_in_fullscreen', cb: null },
        ];

        for (const binding of bindings) {
            settings.bind(
                binding.key,
                binding.value,
                binding.cb ? (...args) => binding.cb.call(this, ...args) : null
            );
        }

        return settings;
    }

    // Drag monitor interface
    dragMotion(event) {
        if (this._enabled) {
            this._enableOnDragEnd = true;
            this._setActive(false);
        }
    }

    dragDrop(event) {
        if (this._enableOnDragEnd) {
            this._enableOnDragEnd = false;
            this._setActive(true);
        }
    }

    /**
     * Enable the extension
     */
    enable() {
        this._updateColoredIcons();
        this._setKeybindings();
        this._setActive(true);
    }

    /**
     * Remove keybindings
     * @private
     */
    _unsetKeybindings() {
        Main.keybindingManager.removeHotKey(PAUSE_EFFECTS_KEY);
    }

    /**
     * Setup keybindings
     * @private
     */
    _setKeybindings() {
        this._unsetKeybindings();
        Main.keybindingManager.addHotKey(
            PAUSE_EFFECTS_KEY,
            this.pause_effects_binding,
            this._onPauseToggled.bind(this)
        );
    }

    /**
     * Handle pause toggle keybinding
     * @private
     */
    _onPauseToggled() {
        this._setActive(!this._enabled);
        if (this.pause_animation_effects_enabled) {
            this._displayClick(this._enabled ? ClickType.PAUSE_OFF : ClickType.PAUSE_ON);
        }
    }

    /**
     * Update animation mode if changed
     * @private
     */
    _updateAnimationMode() {
        if (!this._clickAnimator || this._clickAnimator.mode !== this.animation_mode) {
            this._clickAnimator = ClickAnimationFactory.createForMode(this.animation_mode);
        }
    }

    /**
     * Get click icon from cache or create it
     * @param {number} mode - Icon mode
     * @param {string} clickType - Click type
     * @param {string} color - Color hex string
     * @returns {Gio.Icon|null} Icon or null if not found
     * @private
     */
    _getClickIcon(mode, clickType, color) {
        const name = `${mode}_${clickType}_${color}.svg`;
        const path = `${this._dataDir}/icons/${name}`;
        return this._getIconCached(path);
    }

    /**
     * Get icon from cache or load from path
     * @param {string} path - Icon file path
     * @returns {Gio.Icon|null} Icon or null if not found
     * @private
     */
    _getIconCached(path) {
        if (this._coloredIconCache.has(path)) {
            return this._coloredIconCache.get(path);
        }

        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            const icon = Gio.icon_new_for_string(path);
            this._coloredIconCache.set(path, icon);
            return icon;
        }

        return null;
    }

    /**
     * Disable the extension
     */
    disable() {
        this._destroy();
    }

    /**
     * Cleanup all resources
     * @private
     */
    _destroy() {
        DND.removeDragMonitor(this);
        this._setActive(false);
        this._unsetKeybindings();

        // Cleanup debouncers
        safeDestroy(this._displayClickDebouncer);
        safeDestroy(this._trackerUpdateDebouncer);
        this._displayClickDebouncer = null;
        this._trackerUpdateDebouncer = null;

        // Cleanup settings
        if (this.settings) {
            this.settings.finalize();
            this.settings = null;
        }

        // Cleanup caches
        this._coloredIconCache.clear();
        this._coloredIconCache = null;

        this._clickAnimator = null;
    }

    /**
     * Update all colored icons
     * @private
     */
    _updateColoredIcons() {
        this._createIconData(ClickType.LEFT, this.left_click_color);
        this._createIconData(ClickType.MIDDLE, this.middle_click_color);
        this._createIconData(ClickType.RIGHT, this.right_click_color);
        this._createIconData(ClickType.MOUSE_IDLE, this.mouse_idle_watcher_color);
        this._createIconData(ClickType.MOUSE_MOV, this.mouse_movement_color);
    }

    /**
     * Handle mouse movement tracker property updates
     * @private
     */
    _handleTrackerPropertyUpdate() {
        if (!this._trackerUpdateDebouncer) return;

        this._trackerUpdateDebouncer.debounce(() => {
            if (this._mouseMovementTracker) {
                // Update properties directly instead of restarting
                this._mouseMovementTracker.icon = this._getClickIcon(
                    this.icon_mode,
                    ClickType.MOUSE_MOV,
                    this.mouse_movement_color
                );
                this._mouseMovementTracker.opacity = this.general_opacity;
                this._mouseMovementTracker.persist = this.mouse_movement_tracker_persist_on_stopped_enabled;
                this._mouseMovementTracker.size = this.size;
            }
        }, 100)();
    }

    /**
     * Set extension active state
     * @param {boolean} enabled - Whether to enable
     * @private
     */
    _setActive(enabled) {
        this._enabled = enabled;

        // Deregister listener
        this._listener.deregister('mouse');

        // Stop mouse movement tracker
        if (this._mouseMovementTracker) {
            this._mouseMovementTracker.destroy();
            this._mouseMovementTracker = null;
        }

        if (enabled) {
            this._listener.register('mouse');

            if (this.mouse_movement_tracker_enabled) {
                this._mouseMovementTracker = new MouseMovementTracker(this, {
                    icon: this._getClickIcon(this.icon_mode, ClickType.MOUSE_MOV, this.mouse_movement_color),
                    opacity: this.general_opacity,
                    persist: this.mouse_movement_tracker_persist_on_stopped_enabled,
                    size: this.size,
                });
                this._mouseMovementTracker.start();
            }

            logInfo('Extension activated');
        } else {
            logInfo('Extension deactivated');
        }
    }

    /**
     * Create colored icon data
     * @param {string} clickType - Click type
     * @param {string} color - Color hex string
     * @returns {boolean} Success
     * @private
     */
    _createIconData(clickType, color) {
        if (this._getClickIcon(this.icon_mode, clickType, color)) {
            return true;
        }

        try {
            const sourcePath = `${this._appIconsDir}/${this.icon_mode}.svg`;
            const source = Gio.File.new_for_path(sourcePath);
            const [loadSuccess, contents] = source.load_contents(null);

            if (!loadSuccess) {
                logError(`Failed to load icon from ${sourcePath}`);
                return false;
            }

            // Replace color in SVG
            let svgContent = ByteArray.toString(contents);
            svgContent = svgContent.replace('fill="#000000"', `fill="${color}"`);

            const name = `${this.icon_mode}_${clickType}_${color}.svg`;
            const destPath = `${this._dataDir}/icons/${name}`;
            const dest = Gio.File.new_for_path(destPath);

            if (!dest.query_exists(null)) {
                dest.create(Gio.FileCreateFlags.NONE, null);
            }

            const [writeSuccess] = dest.replace_contents(
                svgContent,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            if (writeSuccess) {
                logInfo(`Created colored icon cache for ${name}`);
            }

            return writeSuccess;
        } catch (e) {
            logError(`Error creating icon data: ${e.message}`);
            return false;
        }
    }

    /**
     * Display click effect (debounced)
     * @param {string} clickType - Click type
     * @param {string} [color] - Color hex string
     * @private
     */
    _displayClick(clickType, color) {
        if (!this._displayClickDebouncer) return;

        this._displayClickDebouncer.debounce(() => {
            // Check fullscreen blocking
            if (this.deactivate_in_fullscreen &&
                global.display.focus_window?.is_fullscreen()) {
                logInfo('Click effects blocked due to fullscreen');
                return;
            }
            this._animateClick(clickType, color);
        }, CLICK_DEBOUNCE_MS)();
    }

    /**
     * Animate a click effect
     * @param {string} clickType - Click type
     * @param {string} [color] - Color hex string
     * @private
     */
    _animateClick(clickType, color) {
        this._updateAnimationMode();

        let icon = null;
        let animator = this._clickAnimator;

        if (clickType === ClickType.PAUSE_ON) {
            icon = this._getIconCached(this._pauseIconPath);
            animator = ClickAnimationFactory.createForMode(AnimationMode.BLINK);
        } else if (clickType === ClickType.PAUSE_OFF) {
            icon = this._getClickIcon(this.icon_mode, ClickType.LEFT, this.left_click_color);
            animator = ClickAnimationFactory.createForMode(AnimationMode.BLINK);
        } else if (color) {
            icon = this._getClickIcon(this.icon_mode, clickType, color);
        }

        if (icon) {
            animator.animateClick(icon, {
                opacity: this.general_opacity,
                icon_size: this.size,
                timeout: this.animation_time,
            });
        } else {
            logError(`Couldn't get Click Icon (mode=${this.icon_mode}, type=${clickType}, color=${color})`);
        }
    }

    /**
     * Handle mouse click events from Atspi
     * @param {Object} event - Atspi event
     * @private
     */
    _onMouseClick(event) {
        const clickType = MOUSE_BUTTON_EVENTS[event.type];
        if (!clickType) return;

        // Get corresponding settings and color
        const config = {
            [ClickType.LEFT]: { enabled: this.left_click_effect_enabled, color: this.left_click_color },
            [ClickType.MIDDLE]: { enabled: this.middle_click_effect_enabled, color: this.middle_click_color },
            [ClickType.RIGHT]: { enabled: this.right_click_effect_enabled, color: this.right_click_color },
        };

        const clickConfig = config[clickType];
        if (clickConfig?.enabled) {
            this._displayClick(clickType, clickConfig.color);
        }
    }
}

// Module-level state
let extension = null;

/**
 * Enable the extension
 */
function enable() {
    extension?.enable();
}

/**
 * Disable the extension
 */
function disable() {
    extension?.disable();
    extension = null;
}

/**
 * Initialize the extension
 * @param {Object} metadata - Extension metadata
 */
function init(metadata) {
    if (!extension) {
        Atspi.init();
        extension = new MouseClickEffects(metadata);
    }
}
