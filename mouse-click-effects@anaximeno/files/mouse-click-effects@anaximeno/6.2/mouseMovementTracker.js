/* mouseMovementTracker.js
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

const { St, Clutter } = imports.gi;
const Main = imports.ui.main;

const { getPointerWatcher } = require('./pointerWatcher.js');
const {
    POINTER_WATCH_MS,
    MOUSE_PARADE_DELAY_MS,
    MOUSE_PARADE_ANIMATION_MS
} = require('./constants.js');
const { Debouncer, logInfo } = require('./helpers.js');

/**
 * Tracks and visualizes mouse movement with an icon
 */
var MouseMovementTracker = class MouseMovementTracker {
    /**
     * Create a mouse movement tracker
     * @param {Object} extension - Parent extension reference
     * @param {Object} params - Configuration options
     * @param {Gio.Icon} params.icon - Icon to display
     * @param {number} params.opacity - Icon opacity (0-255)
     * @param {boolean} params.persist - Whether icon persists when stopped
     * @param {number} params.size - Icon size in pixels
     */
    constructor(extension, params) {
        this._extension = extension;
        this._icon = params.icon;
        this._opacity = params.opacity;
        this._persist = params.persist;
        this._size = params.size;
        this._halfIconSize = this._size * global.ui_scale * 0.5;

        this._iconActor = null;
        this._listener = null;
        this._paradeDebouncer = new Debouncer();
        this._started = false;
    }

    /**
     * Check if fullscreen mode should block the tracker
     * @returns {boolean}
     * @private
     */
    get _isFullscreenBlocked() {
        return this._extension.deactivate_in_fullscreen &&
            global.display.focus_window?.is_fullscreen();
    }

    /**
     * Update the icon size
     * @param {number} value - New size in pixels
     */
    set size(value) {
        this._size = value;
        this._halfIconSize = this._size * global.ui_scale * 0.5;
        if (this._iconActor) {
            this._iconActor.icon_size = value;
        }
    }

    get size() {
        return this._size;
    }

    /**
     * Update opacity
     * @param {number} value - New opacity (0-255)
     */
    set opacity(value) {
        this._opacity = value;
        if (this._iconActor && !this._isFullscreenBlocked) {
            this._iconActor.opacity = value;
        }
    }

    get opacity() {
        return this._opacity;
    }

    /**
     * Update icon
     * @param {Gio.Icon} value - New icon
     */
    set icon(value) {
        this._icon = value;
        if (this._iconActor) {
            this._iconActor.gicon = value;
        }
    }

    get icon() {
        return this._icon;
    }

    /**
     * Update persist setting
     * @param {boolean} value - New persist value
     */
    set persist(value) {
        this._persist = value;
    }

    get persist() {
        return this._persist;
    }

    /**
     * Handle fullscreen state changes
     */
    onFullscreenChanged() {
        const [x, y] = global.get_pointer();
        this._moveTo(x, y);
    }

    /**
     * Start tracking mouse movement
     */
    start() {
        if (this._started) {
            return;
        }

        this._started = true;

        this._iconActor = new St.Icon({
            reactive: false,
            can_focus: false,
            track_hover: false,
            icon_size: this._size,
            opacity: this._opacity,
            gicon: this._icon,
            style: 'pointer-events: none;',
        });

        Main.uiGroup.add_child(this._iconActor);

        const pointerWatcher = getPointerWatcher();
        this._listener = pointerWatcher.addWatch(POINTER_WATCH_MS, this._moveTo.bind(this));

        // Initialize position
        const [x, y] = global.get_pointer();
        this._moveTo(x, y);

        logInfo('Mouse movement tracker started');
    }

    /**
     * Restart the tracker with current settings
     */
    restart() {
        this.stop();
        this.start();
    }

    /**
     * Stop tracking and cleanup
     */
    stop() {
        if (!this._started) {
            return;
        }

        this._started = false;
        this._paradeDebouncer.clear();

        if (this._listener) {
            this._listener.remove();
            this._listener = null;
        }

        if (this._iconActor) {
            Main.uiGroup.remove_child(this._iconActor);
            this._iconActor.destroy();
            this._iconActor = null;
        }

        logInfo('Mouse movement tracker stopped');
    }

    /**
     * Move tracker icon to position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @private
     */
    _moveTo(x, y) {
        if (!this._iconActor) {
            return;
        }

        if (this._isFullscreenBlocked) {
            this._iconActor.hide();
            logInfo('Movement tracker hidden due to fullscreen');
            return;
        }

        // Use set_position for better performance than ease with duration: 0
        this._iconActor.set_position(x - this._halfIconSize, y - this._halfIconSize);
        this._iconActor.opacity = this._opacity;
        this._iconActor.show();

        this._handleParade();
    }

    /**
     * Handle the fade-out parade effect when mouse stops
     * @private
     */
    _handleParade() {
        this._paradeDebouncer.debounce(() => {
            if (!this._persist && this._iconActor) {
                this._iconActor.ease({
                    opacity: 0,
                    duration: MOUSE_PARADE_ANIMATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                    onComplete: () => {
                        if (this._iconActor) {
                            this._iconActor.hide();
                        }
                    },
                });
            }
        }, MOUSE_PARADE_DELAY_MS)();
    }

    /**
     * Cleanup all resources
     */
    destroy() {
        this.stop();
        this._paradeDebouncer.destroy();
        this._extension = null;
        this._icon = null;
    }
};
