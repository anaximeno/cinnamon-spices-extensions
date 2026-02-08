/* helpers.js
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

const { GLib } = imports.gi;
const { UUID, DEBUG } = require('./constants.js');

/**
 * Debouncer class for rate-limiting function calls
 * Uses GLib.timeout_add for better integration with the main loop
 */
var Debouncer = class Debouncer {
    constructor() {
        this._sourceId = 0;
    }

    /**
     * Clear any pending debounced call
     */
    clear() {
        if (this._sourceId > 0) {
            GLib.source_remove(this._sourceId);
            this._sourceId = 0;
        }
    }

    /**
     * Create a debounced version of a function
     * @param {Function} fn - Function to debounce
     * @param {number} timeout - Debounce delay in milliseconds
     * @returns {Function} Debounced function
     */
    debounce(fn, timeout) {
        return (...args) => {
            this.clear();
            this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._sourceId = 0;
                fn.apply(this, args);
                return GLib.SOURCE_REMOVE;
            });
        };
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.clear();
    }
};

/**
 * Throttler class for rate-limiting with guaranteed execution
 * Ensures function executes at most once per interval
 */
var Throttler = class Throttler {
    constructor() {
        this._lastCall = 0;
        this._sourceId = 0;
    }

    /**
     * Clear any pending throttled call
     */
    clear() {
        if (this._sourceId > 0) {
            GLib.source_remove(this._sourceId);
            this._sourceId = 0;
        }
    }

    /**
     * Create a throttled version of a function
     * @param {Function} fn - Function to throttle
     * @param {number} interval - Minimum interval between calls
     * @returns {Function} Throttled function
     */
    throttle(fn, interval) {
        return (...args) => {
            const now = GLib.get_monotonic_time() / 1000;
            const remaining = interval - (now - this._lastCall);

            if (remaining <= 0) {
                this._lastCall = now;
                fn.apply(this, args);
            } else if (this._sourceId === 0) {
                this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining, () => {
                    this._sourceId = 0;
                    this._lastCall = GLib.get_monotonic_time() / 1000;
                    fn.apply(this, args);
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.clear();
    }
};

/**
 * Log info message (only in debug mode)
 * @param {...any} args - Arguments to log
 */
function logInfo(...args) {
    if (DEBUG) {
        global.log(`[${UUID}] ${args.join(' ')}`);
    }
}

/**
 * Log error message
 * @param {...any} args - Arguments to log
 */
function logError(...args) {
    global.logError(`[${UUID}] ${args.join(' ')}`);
}

/**
 * Safely destroy an object if it has a destroy method
 * @param {Object} obj - Object to destroy
 */
function safeDestroy(obj) {
    if (obj && typeof obj.destroy === 'function') {
        try {
            obj.destroy();
        } catch (e) {
            logError(`Error destroying object: ${e.message}`);
        }
    }
}
