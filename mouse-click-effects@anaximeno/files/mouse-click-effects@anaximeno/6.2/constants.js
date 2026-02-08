/* constants.js
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

var DEBUG = false;

var UUID = "mouse-click-effects@anaximeno";

var PAUSE_EFFECTS_KEY = `${UUID}-bind-pause-effects`;

var CLICK_DEBOUNCE_MS = 16;

var POINTER_WATCH_MS = 16;

var MOUSE_PARADE_DELAY_MS = 256;

var MOUSE_PARADE_ANIMATION_MS = 256;

var IDLE_TIME = 1024;

// Click types enum - frozen for immutability
var ClickType = Object.freeze({
    LEFT: "left_click",
    MIDDLE: "middle_click",
    RIGHT: "right_click",
    PAUSE_ON: "pause_on",
    PAUSE_OFF: "pause_off",
    MOUSE_IDLE: "mouse_idle",
    MOUSE_MOV: "mouse_mov",
});

// Animation modes enum
var AnimationMode = Object.freeze({
    BOUNCE: "bounce",
    RETRACT: "retract",
    EXPAND: "expand",
    BLINK: "blink",
});

// Mouse button event mappings for efficient lookup
var MOUSE_BUTTON_EVENTS = Object.freeze({
    'mouse:button:1p': ClickType.LEFT,
    'mouse:button:2p': ClickType.MIDDLE,
    'mouse:button:3p': ClickType.RIGHT,
});
