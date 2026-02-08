/* clickAnimations.js
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
const { Clutter } = imports.gi;
const St = imports.gi.St;
const { AnimationMode } = require('./constants.js');

/**
 * Base class for click animations
 * @abstract
 */
var ClickAnimationMode = class ClickAnimationMode {
    constructor(mode) {
        this.mode = mode;
    }

    /**
     * Creates and configures an St.Icon actor for animation
     * @param {Gio.Icon} icon - The icon to display
     * @param {Object} options - Animation options
     * @param {number} mouseX - Mouse X position
     * @param {number} mouseY - Mouse Y position
     * @returns {St.Icon} Configured actor
     * @protected
     */
    _createActor(icon, options, mouseX, mouseY) {
        return new St.Icon({
            x: mouseX,
            y: mouseY,
            reactive: false,
            can_focus: false,
            track_hover: false,
            icon_size: options.icon_size,
            opacity: options.opacity,
            gicon: icon,
        });
    }

    /**
     * Cleanup callback for removing and destroying actor
     * @param {St.Icon} actor - Actor to cleanup
     * @protected
     */
    _cleanupActor(actor) {
        if (actor) {
            Main.uiGroup.remove_child(actor);
            actor.destroy();
        }
    }

    /**
     * Animates a click at the current mouse position
     * @param {Gio.Icon} icon - The icon to animate
     * @param {Object} options - Animation options
     * @param {number} options.opacity - Icon opacity (0-255)
     * @param {number} options.icon_size - Icon size in pixels
     * @param {number} options.timeout - Animation duration in ms
     * @abstract
     */
    animateClick(icon, options) {
        throw new Error('animateClick must be implemented by subclass');
    }
};

/**
 * Expansion animation - icon appears small and grows outward
 */
var ExpansionClickAnimationMode = class ExpansionClickAnimationMode extends ClickAnimationMode {
    animateClick(icon, options) {
        const [mouseX, mouseY] = global.get_pointer();
        const actorScale = options.icon_size > 20 ? 1.15 : 3;
        const scaledOffset = options.icon_size * actorScale * global.ui_scale * 0.5;

        const actor = this._createActor(icon, options, mouseX, mouseY);
        actor.set_scale(0, 0);

        Main.uiGroup.add_child(actor);

        actor.ease({
            opacity: Math.floor(options.opacity * 0.08),
            x: mouseX - scaledOffset,
            y: mouseY - scaledOffset,
            scale_x: actorScale,
            scale_y: actorScale,
            duration: options.timeout,
            mode: Clutter.AnimationMode.EASE_OUT_SINE,
            onComplete: () => this._cleanupActor(actor),
        });
    }
};

/**
 * Retraction animation - icon appears at full size and shrinks
 */
var RetractionClickAnimationMode = class RetractionClickAnimationMode extends ClickAnimationMode {
    animateClick(icon, options) {
        const [mouseX, mouseY] = global.get_pointer();
        const offset = options.icon_size * global.ui_scale * 0.5;

        const actor = this._createActor(icon, options, mouseX - offset, mouseY - offset);
        Main.uiGroup.add_child(actor);

        actor.ease({
            opacity: Math.floor(options.opacity * 0.1),
            x: mouseX,
            y: mouseY,
            scale_x: 0,
            scale_y: 0,
            duration: options.timeout,
            mode: Clutter.AnimationMode.EASE_OUT_SINE,
            onComplete: () => this._cleanupActor(actor),
        });
    }
};

/**
 * Bounce animation - icon appears, grows, then bounces back
 */
var BounceBackClickAnimationMode = class BounceBackClickAnimationMode extends ClickAnimationMode {
    animateClick(icon, options) {
        const [mouseX, mouseY] = global.get_pointer();
        const offset = options.icon_size * global.ui_scale * 0.5;
        const expandDuration = Math.floor(options.timeout * 0.4);
        const contractDuration = Math.floor(options.timeout * 0.6);

        const actor = this._createActor(icon, options, mouseX, mouseY);
        actor.set_scale(0, 0);
        actor.opacity = Math.floor(options.opacity * 0.1);

        Main.uiGroup.add_child(actor);

        actor.ease({
            x: mouseX - offset,
            y: mouseY - offset,
            scale_x: 1,
            scale_y: 1,
            opacity: options.opacity,
            duration: expandDuration,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => {
                actor.ease({
                    opacity: 0,
                    x: mouseX,
                    y: mouseY,
                    scale_x: 0,
                    scale_y: 0,
                    duration: contractDuration,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                    onComplete: () => this._cleanupActor(actor),
                });
            },
        });
    }
};

/**
 * Blink animation - simple fade out
 */
var BlinkClickAnimationMode = class BlinkClickAnimationMode extends ClickAnimationMode {
    animateClick(icon, options) {
        const [mouseX, mouseY] = global.get_pointer();
        const offset = options.icon_size * global.ui_scale * 0.5;

        const actor = this._createActor(icon, options, mouseX - offset, mouseY - offset);
        Main.uiGroup.add_child(actor);

        actor.ease({
            opacity: Math.floor(options.opacity * 0.1),
            duration: options.timeout,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => this._cleanupActor(actor),
        });
    }
};

// Animation mode registry for efficient lookup
const ANIMATION_REGISTRY = Object.freeze({
    [AnimationMode.BOUNCE]: BounceBackClickAnimationMode,
    [AnimationMode.RETRACT]: RetractionClickAnimationMode,
    [AnimationMode.EXPAND]: ExpansionClickAnimationMode,
    [AnimationMode.BLINK]: BlinkClickAnimationMode,
});

/**
 * Factory for creating click animation instances
 */
var ClickAnimationFactory = class ClickAnimationFactory {
    /**
     * Creates an animation mode instance for the given mode name
     * @param {string} mode - Animation mode name
     * @returns {ClickAnimationMode} Animation mode instance
     */
    static createForMode(mode) {
        const AnimClass = ANIMATION_REGISTRY[mode] || BlinkClickAnimationMode;
        return new AnimClass(mode);
    }
};
