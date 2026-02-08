/* pointerWatcher.js
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

const { GLib, Meta } = imports.gi;
const { IDLE_TIME, UUID } = require('./constants.js');

// Singleton instance
let _pointerWatcher = null;

/**
 * Gets the singleton PointerWatcher instance
 * @returns {PointerWatcher}
 */
function getPointerWatcher() {
    if (_pointerWatcher === null) {
        _pointerWatcher = new PointerWatcher();
    }
    return _pointerWatcher;
}

/**
 * Represents a single pointer watch subscription
 */
var PointerWatch = class PointerWatch {
    constructor(watcher, interval, callback) {
        this.watcher = watcher;
        this.interval = interval;
        this.callback = callback;
        this._removed = false;
    }

    /**
     * Remove this watch subscription
     * Safe to call while callback is executing
     */
    remove() {
        if (!this._removed) {
            this._removed = true;
            this.watcher._removeWatch(this);
        }
    }
};

/**
 * Efficiently tracks mouse pointer position
 * Automatically pauses polling when user is idle
 */
var PointerWatcher = class PointerWatcher {
    constructor() {
        this._idleMonitor = Meta.IdleMonitor.get_core();
        this._idle = this._idleMonitor.get_idletime() > IDLE_TIME;
        this._watches = [];
        this._timeoutId = 0;
        this._activeWatchId = 0;
        this.pointerX = -1;
        this.pointerY = -1;

        // Bind handlers once to avoid creating new functions
        this._onIdleBound = this._onIdleMonitorBecameIdle.bind(this);
        this._onActiveBound = this._onIdleMonitorBecameActive.bind(this);
        this._onTimeoutBound = this._onTimeout.bind(this);

        // Set up idle watch
        this._idleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIME, this._onIdleBound);
    }

    /**
     * Add a pointer position watch
     * @param {number} interval - Polling interval in milliseconds
     * @param {Function} callback - Called with (x, y) when position changes
     * @returns {PointerWatch} Watch handle for removal
     */
    addWatch(interval, callback) {
        // Initialize position before adding watch
        this._updatePointer();

        const watch = new PointerWatch(this, interval, callback);
        this._watches.push(watch);
        this._updateTimeout();
        return watch;
    }

    /**
     * Remove a watch from the list
     * @param {PointerWatch} watch - Watch to remove
     * @private
     */
    _removeWatch(watch) {
        const index = this._watches.indexOf(watch);
        if (index !== -1) {
            this._watches.splice(index, 1);
            this._updateTimeout();
        }
    }

    /**
     * Handler for when user becomes active
     * @private
     */
    _onIdleMonitorBecameActive() {
        this._idle = false;
        this._activeWatchId = 0;
        this._updatePointer();
        this._updateTimeout();
    }

    /**
     * Handler for when user becomes idle
     * @private
     */
    _onIdleMonitorBecameIdle() {
        this._idle = true;
        this._activeWatchId = this._idleMonitor.add_user_active_watch(this._onActiveBound);
        this._updateTimeout();
    }

    /**
     * Update the polling timeout based on watches
     * @private
     */
    _updateTimeout() {
        // Clear existing timeout
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        // Don't poll if idle or no watches
        if (this._idle || this._watches.length === 0) {
            return;
        }

        // Find minimum interval among all watches
        let minInterval = this._watches[0].interval;
        for (let i = 1; i < this._watches.length; i++) {
            if (this._watches[i].interval < minInterval) {
                minInterval = this._watches[i].interval;
            }
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, minInterval, this._onTimeoutBound);
        GLib.Source.set_name_by_id(this._timeoutId, `[${UUID}] PointerWatcher._updateTimeout`);
    }

    /**
     * Timeout callback
     * @returns {boolean} GLib.SOURCE_CONTINUE
     * @private
     */
    _onTimeout() {
        this._updatePointer();
        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Update pointer position and notify watches if changed
     * @private
     */
    _updatePointer() {
        const [x, y] = global.get_pointer();

        // Only notify if position changed
        if (this.pointerX === x && this.pointerY === y) {
            return;
        }

        this.pointerX = x;
        this.pointerY = y;

        // Notify all watches, handling potential self-removal
        const watches = this._watches.slice(); // Copy to handle removals during iteration
        for (const watch of watches) {
            if (!watch._removed) {
                watch.callback(x, y);
            }
        }
    }

    /**
     * Cleanup resources
     */
    destroy() {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (this._idleWatchId > 0) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }

        if (this._activeWatchId > 0) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }

        this._watches = [];
        _pointerWatcher = null;
    }
};
