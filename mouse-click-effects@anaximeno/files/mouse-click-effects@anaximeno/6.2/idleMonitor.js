/* idleMonitor.js
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

const { Meta } = imports.gi;
const { IDLE_TIME } = require('./constants.js');

/**
 * Monitor for user idle/active state
 */
var IdleMonitor = class IdleMonitor {
    /**
     * Create an idle monitor
     * @param {Object} params - Configuration options
     * @param {number} [params.idleDelay=IDLE_TIME] - Idle threshold in milliseconds
     * @param {Function} [params.onIdle] - Callback when user becomes idle
     * @param {Function} [params.onActive] - Callback when user becomes active
     * @param {Function} [params.onFinish] - Callback when monitor is stopped
     */
    constructor(params = {}) {
        this._idleMonitor = Meta.IdleMonitor.get_core();
        this._idleDelay = params.idleDelay ?? IDLE_TIME;
        this._onIdle = params.onIdle ?? null;
        this._onActive = params.onActive ?? null;
        this._onFinish = params.onFinish ?? null;

        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._started = false;
        this.idle = false;

        // Bind handlers once
        this._idleHandlerBound = this._idleHandler.bind(this);
        this._activeHandlerBound = this._activeHandler.bind(this);
    }

    /**
     * Start monitoring idle state
     */
    start() {
        if (this._started) {
            return;
        }

        this._started = true;
        this._idleWatchId = this._idleMonitor.add_idle_watch(
            this._idleDelay,
            this._idleHandlerBound
        );
        this.idle = this._idleMonitor.get_idletime() > this._idleDelay;
    }

    /**
     * Stop monitoring and cleanup
     */
    stop() {
        if (!this._started) {
            return;
        }

        this._started = false;

        if (this._onFinish) {
            this._onFinish();
        }

        if (this._idleWatchId > 0) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }

        if (this._activeWatchId > 0) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
    }

    /**
     * Handler called when user becomes idle
     * @private
     */
    _idleHandler() {
        this.idle = true;
        this._activeWatchId = this._idleMonitor.add_user_active_watch(this._activeHandlerBound);

        if (this._onIdle) {
            this._onIdle();
        }
    }

    /**
     * Handler called when user becomes active
     * @private
     */
    _activeHandler() {
        this.idle = false;
        this._activeWatchId = 0;

        if (this._onActive) {
            this._onActive();
        }
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.stop();
        this._onIdle = null;
        this._onActive = null;
        this._onFinish = null;
    }
};
