/* extension.js
 * Super Scale — macOS Mission Control-like window overview for Cinnamon.
 *
 * Shows all open windows from every workspace on the current monitor
 * in a clean, tiled grid layout. Replaces the built-in Scale (overview)
 * view while active.
 */

const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext = imports.gettext;

const Main = imports.ui.main;
const Overview = imports.ui.overview;
const WindowUtils = imports.misc.windowUtils;
const GridNavigator = imports.misc.gridNavigator;

// ─── Constants ───────────────────────────────────────────────────────────────

const ANIMATION_TIME = 250;       // ms – main show/hide transition
const CLOSE_FADE_TIME = 150;      // ms – border & close-button fade
const ICON_SIZE = 20;             // px – app icon in caption

// ─── Gettext helper ──────────────────────────────────────────────────────────

let UUID;

function _(text) {
    let translation = Gettext.dgettext(UUID, text);
    if (translation !== text) return translation;
    return Gettext.gettext(text);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  WindowTile – a single window thumbnail with overlay chrome
// ═══════════════════════════════════════════════════════════════════════════════

function WindowTile() { this._init.apply(this, arguments); }

WindowTile.prototype = {

    _init: function(windowActor, monitorView) {
        this.realWindow = windowActor;
        this.metaWindow = windowActor.meta_window;
        this._monitorView = monitorView;
        this.closedFromView = false;

        // Original on-screen geometry (for zoom-back animation)
        let rect = this.metaWindow.get_frame_rect();
        this.origX = rect.x;
        this.origY = rect.y;
        this.origWidth = rect.width;
        this.origHeight = rect.height;

        // Reactive actor that holds the Clutter.Clone tree
        this.actor = new Clutter.Actor({ reactive: true });
        this.actor._delegate = this;

        this._createClone();

        // Chrome (border, caption, close button) placed in a shared group
        this._createChrome(monitorView._chromeGroup);

        // Input – absorb press so it doesn't fall through to the shade
        this.actor.connect('button-press-event', () => Clutter.EVENT_STOP);
        this.actor.connect('button-release-event', this._onButtonRelease.bind(this));
        this.actor.connect('motion-event', this._onMotion.bind(this));
        this.actor.connect('leave-event', this._onLeave.bind(this));
        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._selected = false;
        this._hovering = false;
        this._idleHideId = 0;
        this._layoutSlot = null;
    },

    // ── Clone ────────────────────────────────────────────────────────────────

    _createClone: function() {
        this.actor.destroy_all_children();

        let rect = this.metaWindow.get_frame_rect();

        // Drop-shadow backing (inside the tile actor, scales with it)
        this._shadowInner = new St.Bin({ style_class: 'super-scale-shadow' });
        let sp = 12;
        this._shadowInner.set_position(-sp, -sp);
        this._shadowInner.set_size(rect.width + 2 * sp, rect.height + 2 * sp);
        this.actor.add_actor(this._shadowInner);

        let clones = WindowUtils.createWindowClone(this.metaWindow, 0, 0, true);

        for (let clone of clones) {
            let leftGap = rect.x - clone.x;
            let topGap  = rect.y - clone.y;
            if (clone !== clones[0]) {
                clone.actor.set_clip(leftGap, topGap, rect.width, rect.height);
            }
            clone.actor.set_position(-leftGap, -topGap);
            this.actor.add_actor(clone.actor);
        }
        this.actor.set_size(rect.width, rect.height);
    },

    // ── Chrome (border · caption · close button) ─────────────────────────────

    _createChrome: function(chromeGroup) {
        let tracker = Cinnamon.WindowTracker.get_default();
        let app = tracker.get_window_app(this.metaWindow);
        let icon = null;
        if (app) {
            icon = app.create_icon_texture_for_window(ICON_SIZE, this.metaWindow);
        }
        if (!icon) {
            icon = new St.Icon({ icon_name: 'application-default-icon',
                                 icon_type: St.IconType.FULLCOLOR,
                                 icon_size: ICON_SIZE });
        }

        // Border (highlight outline)
        this.border = new St.Widget({
            style_class: 'super-scale-window-border',
            important: true
        });
        this.border.hide();

        // Caption: icon + title
        this.caption = new St.BoxLayout({ style_class: 'super-scale-window-caption' });
        this._titleLabel = new St.Label({
            text: this.metaWindow.title || '',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.caption.add_actor(icon);
        this.caption.add_actor(this._titleLabel);
        this.caption.hide();

        this._titleChangedId = this.metaWindow.connect('notify::title', w => {
            this._titleLabel.set_text(w.title || '');
        });

        // Close button
        this.closeButton = new St.Button({ style_class: 'super-scale-close-button' });
        this.closeButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_type: St.IconType.SYMBOLIC,
            style_class: 'super-scale-close-icon'
        }));
        this.closeButton.connect('clicked', () => this.closeWindow());
        this.closeButton.hide();

        chromeGroup.add_actor(this.border);
        chromeGroup.add_actor(this.caption);
        chromeGroup.add_actor(this.closeButton);
    },

    /**
     * updatePositions:
     * Position chrome elements relative to the window clone's
     * current on-screen coordinates and scaled size.
     */
    updatePositions: function(x, y, width, height, maxWidth) {
        // Border
        let bw = 3;
        this.border.set_position(Math.round(x - bw), Math.round(y - bw));
        this.border.set_size(Math.round(width + 2 * bw), Math.round(height + 2 * bw));

        // Caption – centred below the clone
        let [, captionNatW] = this.caption.get_preferred_width(-1);
        let captionW = Math.min(maxWidth, captionNatW);
        this.caption.set_position(
            Math.round(x + (width - captionW) / 2),
            Math.round(y + height + 10)
        );
        this.caption.width = captionW;

        // Close button – always top-left (macOS style)
        this.closeButton.set_position(Math.round(x - 8), Math.round(y - 8));
    },

    // ── Selection ────────────────────────────────────────────────────────────

    setSelected: function(selected) {
        if (this._selected === selected) return;
        this._selected = selected;

        if (this._idleHideId > 0) {
            Mainloop.source_remove(this._idleHideId);
            this._idleHideId = 0;
        }

        if (selected) {
            this._raiseChrome();
            for (let item of [this.border, this.closeButton]) {
                item.show();
                item.opacity = 0;
                item.ease({
                    opacity: 255,
                    duration: CLOSE_FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD
                });
            }
            this.caption.add_style_pseudo_class('focus');
        } else {
            for (let item of [this.border, this.closeButton]) {
                item.ease({
                    opacity: 0,
                    duration: CLOSE_FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => item.hide()
                });
            }
            this.caption.remove_style_pseudo_class('focus');
        }
    },

    /** Raise this tile's chrome above other tiles' chrome in the shared group. */
    _raiseChrome: function() {
        for (let a of [this.border, this.caption, this.closeButton]) {
            a.raise_top();
        }
    },

    hideChrome: function() {
        this.caption.hide();
        this.border.hide();
        this.closeButton.hide();
    },

    showCaption: function() {
        this.caption.show();
    },

    // ── Actions ──────────────────────────────────────────────────────────────

    closeWindow: function() {
        this.closedFromView = true;
        this.metaWindow.delete(global.get_current_time());
    },

    destroy: function() {
        if (this.actor.is_finalized()) return;
        this.actor.destroy();
    },

    // ── Event handlers ───────────────────────────────────────────────────────

    _onButtonRelease: function(actor, event) {
        switch (event.get_button()) {
            case 1:
                this._selected = true;
                this.emit('activated', global.get_current_time());
                return Clutter.EVENT_STOP;
            case 2:
                this.closeWindow();
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _onMotion: function() {
        if (!this._hovering) {
            this._hovering = true;
            this._animateHover();
            this.emit('hover-changed', true);
        }
    },

    /** Scale the tile up slightly on hover for depth feedback. */
    _animateHover: function() {
        if (!this._layoutSlot) return;
        let s = this._layoutSlot;
        let grow = 1.05;
        let newScale = s.scale * grow;
        let dw = this.origWidth * (newScale - s.scale);
        let dh = this.origHeight * (newScale - s.scale);

        this.actor.ease({
            x: s.x - dw / 2,
            y: s.y - dh / 2,
            scale_x: newScale,
            scale_y: newScale,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        let sW = this.origWidth * newScale;
        let sH = this.origHeight * newScale;
        this.updatePositions(s.x - dw / 2, s.y - dh / 2, sW, sH, s.cellW);
    },

    _animateUnhover: function() {
        if (!this._layoutSlot) return;
        let s = this._layoutSlot;

        this.actor.ease({
            x: s.x,
            y: s.y,
            scale_x: s.scale,
            scale_y: s.scale,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        let sW = this.origWidth * s.scale;
        let sH = this.origHeight * s.scale;
        this.updatePositions(s.x, s.y, sW, sH, s.cellW);
    },

    _onLeave: function() {
        if (!this._hovering) return;
        this._hovering = false;
        this._animateUnhover();
        if (this.closeButton.has_pointer) return;
        this._scheduleDeselect();
    },

    _scheduleDeselect: function() {
        if (this._idleHideId > 0) return;
        this._idleHideId = Mainloop.timeout_add(500, () => {
            this._idleHideId = 0;
            if (!this._hovering && !this.closeButton.has_pointer) {
                this.setSelected(false);
            }
            return GLib.SOURCE_REMOVE;
        });
    },

    _onDestroy: function() {
        if (this._titleChangedId) {
            this.metaWindow.disconnect(this._titleChangedId);
            this._titleChangedId = 0;
        }
        if (this._idleHideId > 0) {
            Mainloop.source_remove(this._idleHideId);
            this._idleHideId = 0;
        }
        this.border.destroy();
        this.caption.destroy();
        this.closeButton.destroy();
        this.disconnectAll();
    }
};
Signals.addSignalMethods(WindowTile.prototype);


// ═══════════════════════════════════════════════════════════════════════════════
//  MonitorView – manages tiles for one physical monitor
// ═══════════════════════════════════════════════════════════════════════════════

function MonitorView() { this._init.apply(this, arguments); }

MonitorView.prototype = {

    _init: function(monitor, monitorIndex, scaleView) {
        this._monitor = monitor;
        this.monitorIndex = monitorIndex;
        this._scaleView = scaleView;
        this._kbIndex = -1;
        this._selectedTile = null;
        this._animating = false;

        this.actor = new Clutter.Actor();
        this._chromeGroup = new Clutter.Actor();
        this._chromeGroup.set_size(0, 0);

        // Collect windows from ALL workspaces for this monitor
        this._tiles = [];
        this._collectWindows();

        // "No open windows" placeholder
        this._emptyPlaceholder = new St.Bin({
            style_class: 'super-scale-empty-placeholder',
            child: new St.Label({ text: _("No open windows") }),
            important: true
        });
        this.actor.add_actor(this._emptyPlaceholder);
        this._updateEmptyPlaceholder();
    },

    // ── Window collection ────────────────────────────────────────────────────

    _collectWindows: function() {
        let windows = global.get_window_actors().filter(actor => {
            let metaWin = actor.get_meta_window();
            if (!metaWin) return false;
            if (metaWin.get_monitor() !== this.monitorIndex) return false;
            return Main.isInteresting(metaWin);
        });

        // Sort by stacking order (stable sequence)
        windows.sort((a, b) =>
            a.get_meta_window().get_stable_sequence() -
            b.get_meta_window().get_stable_sequence()
        );

        for (let win of windows) {
            this._addTile(win);
        }
    },

    _addTile: function(windowActor) {
        let tile = new WindowTile(windowActor, this);

        tile.connect('activated', (t, time) => {
            this._scaleView.activateWindow(t.metaWindow, time);
        });

        tile.connect('hover-changed', (t, hovering) => {
            if (hovering) this._selectTile(t);
        });

        this.actor.add_actor(tile.actor);
        this._tiles.push(tile);

        // React to the window being destroyed while the view is open
        tile._windowDestroyId = windowActor.connect('destroy', () => {
            this._removeTile(tile);
        });

        return tile;
    },

    _removeTile: function(tile) {
        let index = this._tiles.indexOf(tile);
        if (index === -1) return;

        if (tile._windowDestroyId && !tile.realWindow.is_finalized()) {
            tile.realWindow.disconnect(tile._windowDestroyId);
            tile._windowDestroyId = 0;
        }

        this._tiles.splice(index, 1);
        if (this._selectedTile === tile) this._selectedTile = null;
        if (this._kbIndex >= this._tiles.length) {
            this._kbIndex = Math.max(0, this._tiles.length - 1);
        }

        tile.destroy();

        if (this.isEmpty()) {
            this._updateEmptyPlaceholder();
            if (tile.closedFromView) this._scaleView.hide();
        } else {
            this._positionTiles(true);
        }
    },

    isEmpty: function() { return this._tiles.length === 0; },

    _updateEmptyPlaceholder: function() {
        if (this._tiles.length > 0) {
            this._emptyPlaceholder.hide();
            return;
        }
        let mon = this._monitor;
        let [, natW] = this._emptyPlaceholder.get_preferred_width(-1);
        let [, natH] = this._emptyPlaceholder.get_preferred_height(-1);
        this._emptyPlaceholder.set_position(
            mon.x + (mon.width - natW) / 2,
            mon.y + (mon.height - natH) / 2
        );
        this._emptyPlaceholder.show();
    },

    // ── Keyboard / pointer selection ─────────────────────────────────────────

    _selectTile: function(tile) {
        let index = this._tiles.indexOf(tile);
        if (index >= 0) {
            this.selectIndex(index);
            tile.actor.raise_top();
        }
    },

    selectIndex: function(index) {
        if (this._selectedTile) this._selectedTile.setSelected(false);

        this._kbIndex = index;
        if (index >= 0 && index < this._tiles.length) {
            this._selectedTile = this._tiles[index];
            this._selectedTile.setSelected(true);
        } else {
            this._selectedTile = null;
        }
    },

    selectAnotherWindow: function(symbol) {
        if (this._tiles.length === 0) return false;
        let cols = Math.ceil(Math.sqrt(this._tiles.length));
        let nextIdx = GridNavigator.nextIndex(
            this._tiles.length, cols, Math.max(0, this._kbIndex), symbol);
        if (nextIdx < 0) return false;
        this.selectIndex(nextIdx);
        return true;
    },

    activateSelectedWindow: function() {
        if (this._kbIndex >= 0 && this._kbIndex < this._tiles.length) {
            this._scaleView.activateWindow(
                this._tiles[this._kbIndex].metaWindow,
                global.get_current_time());
            return true;
        }
        return false;
    },

    closeSelectedWindow: function() {
        if (this._kbIndex >= 0 && this._kbIndex < this._tiles.length) {
            this._tiles[this._kbIndex].closeWindow();
        }
    },

    // ── Natural layout ─────────────────────────────────────────────────────

    /**
     * _computeLayout:
     * Computes a natural, macOS Mission Control-style layout.
     *
     * Windows keep their rough relative desktop positions and are
     * iteratively pushed apart to eliminate overlaps, producing an
     * organic, non-grid arrangement.
     */
    _computeLayout: function() {
        let n = this._tiles.length;
        if (n === 0) return [];

        let mon = this._monitor;
        let padX = mon.width * 0.05;
        let padY = mon.height * 0.06;
        let captionReserve = 44;

        let area = {
            x: mon.x + padX,
            y: mon.y + padY,
            w: mon.width - 2 * padX,
            h: mon.height - 2 * padY - captionReserve
        };

        // Single window – centred generously
        if (n === 1) {
            let t = this._tiles[0];
            let sc = Math.min(area.w * 0.6 / t.origWidth,
                              area.h * 0.6 / t.origHeight, 1.0);
            return [{ x: area.x + (area.w - t.origWidth * sc) / 2,
                      y: area.y + (area.h - t.origHeight * sc) / 2,
                      scale: sc,
                      cellW: t.origWidth * sc + 40 }];
        }

        // Base scale – windows should cover ~targetCoverage of available area
        let totalArea = this._tiles.reduce(
            (s, t) => s + t.origWidth * t.origHeight, 0);
        let coverage = n <= 3 ? 0.55 : n <= 6 ? 0.48 : n <= 10 ? 0.42 : 0.36;
        let baseScale = Math.sqrt(area.w * area.h * coverage / totalArea);
        baseScale = Math.min(baseScale, 0.95);

        // No single window may exceed 80% of the area
        for (let t of this._tiles) {
            baseScale = Math.min(baseScale,
                area.w * 0.80 / t.origWidth,
                area.h * 0.80 / t.origHeight);
        }

        // Map original desktop centres into the overview area
        let centres = this._tiles.map(t => ({
            x: t.origX + t.origWidth / 2,
            y: t.origY + t.origHeight / 2
        }));
        let cMinX = Infinity, cMaxX = -Infinity;
        let cMinY = Infinity, cMaxY = -Infinity;
        for (let c of centres) {
            cMinX = Math.min(cMinX, c.x); cMaxX = Math.max(cMaxX, c.x);
            cMinY = Math.min(cMinY, c.y); cMaxY = Math.max(cMaxY, c.y);
        }
        let cRangeX = cMaxX - cMinX;
        let cRangeY = cMaxY - cMinY;

        let slots = [];
        for (let i = 0; i < n; i++) {
            let t = this._tiles[i];
            let w = t.origWidth * baseScale;
            let h = t.origHeight * baseScale;

            // When windows are tightly grouped, start from the centre
            let normX = cRangeX > 50 ? (centres[i].x - cMinX) / cRangeX : 0.5;
            let normY = cRangeY > 50 ? (centres[i].y - cMinY) / cRangeY : 0.5;

            let x = area.x + normX * (area.w - w);
            let y = area.y + normY * (area.h - h);

            slots.push({ x, y, scale: baseScale, w, h,
                         cellW: w + 30 });
        }

        // Iterative overlap resolution (force-directed push-apart)
        let gap = Math.min(area.w, area.h) * 0.018 + 10;

        for (let iter = 0; iter < 80; iter++) {
            let maxPush = 0;
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    let a = slots[i], b = slots[j];
                    let dx = (a.x + a.w / 2) - (b.x + b.w / 2);
                    let dy = (a.y + a.h / 2) - (b.y + b.h / 2);
                    let overlapX = (a.w + b.w) / 2 + gap - Math.abs(dx);
                    let overlapY = (a.h + b.h) / 2 + gap - Math.abs(dy);

                    if (overlapX > 0 && overlapY > 0) {
                        let f = 0.45;
                        if (overlapX < overlapY) {
                            let push = overlapX * f * (dx >= 0 ? 1 : -1);
                            a.x += push; b.x -= push;
                            maxPush = Math.max(maxPush, Math.abs(push));
                        } else {
                            let push = overlapY * f * (dy >= 0 ? 1 : -1);
                            a.y += push; b.y -= push;
                            maxPush = Math.max(maxPush, Math.abs(push));
                        }
                    }
                }
            }
            // Clamp to area bounds
            for (let s of slots) {
                s.x = Math.max(area.x, Math.min(area.x + area.w - s.w, s.x));
                s.y = Math.max(area.y, Math.min(area.y + area.h - s.h, s.y));
            }
            if (maxPush < 1) break;
        }

        return slots;
    },

    _positionTiles: function(animate) {
        let slots = this._computeLayout();
        this._animating = animate;

        for (let i = 0; i < this._tiles.length; i++) {
            let tile = this._tiles[i];
            let slot = slots[i];
            tile._layoutSlot = slot;
            tile.hideChrome();

            if (animate) {
                tile.actor.ease({
                    x: slot.x, y: slot.y,
                    scale_x: slot.scale, scale_y: slot.scale,
                    duration: ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        this._animating = false;
                        this._showTileChrome(tile, slot);
                    }
                });
            } else {
                tile.actor.set_position(slot.x, slot.y);
                tile.actor.set_scale(slot.scale, slot.scale);
                this._showTileChrome(tile, slot);
            }
        }
    },

    _showTileChrome: function(tile, slot) {
        if (this._animating) return;
        let sW = tile.origWidth  * slot.scale;
        let sH = tile.origHeight * slot.scale;
        tile.updatePositions(slot.x, slot.y, sW, sH, slot.cellW);
        tile.showCaption();
    },

    // ── Zoom animations ──────────────────────────────────────────────────────

    /** Animate tiles from original screen positions into the view. */
    zoomToOverview: function() {
        let slots = this._computeLayout();
        let animate = Main.animations_enabled;

        for (let i = 0; i < this._tiles.length; i++) {
            let tile = this._tiles[i];
            let slot = slots[i];
            tile._layoutSlot = slot;
            tile.hideChrome();

            if (animate) {
                if (tile.metaWindow.showing_on_its_workspace()) {
                    // Visible window: start at real position
                    tile.actor.set_position(tile.origX, tile.origY);
                    tile.actor.set_scale(1.0, 1.0);
                    tile.actor.opacity = 255;
                } else {
                    // Hidden / minimised: fade in from centre of slot
                    tile.actor.opacity = 0;
                    tile.actor.set_scale(0.3, 0.3);
                    tile.actor.set_position(
                        slot.x + tile.origWidth  * slot.scale * 0.35,
                        slot.y + tile.origHeight * slot.scale * 0.35
                    );
                }

                tile.actor.ease({
                    x: slot.x, y: slot.y,
                    scale_x: slot.scale, scale_y: slot.scale,
                    opacity: 255,
                    duration: ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => this._showTileChrome(tile, slot)
                });
            } else {
                tile.actor.set_position(slot.x, slot.y);
                tile.actor.set_scale(slot.scale, slot.scale);
                tile.actor.opacity = 255;
                this._showTileChrome(tile, slot);
            }
        }
    },

    /** Animate tiles from grid → original screen positions. */
    zoomFromOverview: function() {
        let animate = Main.animations_enabled;

        for (let tile of this._tiles) {
            tile.hideChrome();

            if (!animate) continue;

            if (tile.metaWindow.showing_on_its_workspace()) {
                tile.actor.ease({
                    x: tile.origX, y: tile.origY,
                    scale_x: 1.0, scale_y: 1.0,
                    opacity: 255,
                    duration: ANIMATION_TIME * 0.45,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            } else {
                tile.actor.ease({
                    scale_x: 0, scale_y: 0,
                    opacity: 0,
                    duration: ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
        }

        if (this._emptyPlaceholder.visible) {
            this._emptyPlaceholder.ease({
                opacity: 0,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
    },

    // ── Teardown ─────────────────────────────────────────────────────────────

    destroy: function() {
        for (let tile of this._tiles) {
            if (tile._windowDestroyId && !tile.realWindow.is_finalized()) {
                tile.realWindow.disconnect(tile._windowDestroyId);
                tile._windowDestroyId = 0;
            }
            tile.destroy();
        }
        this._tiles = [];
        this._emptyPlaceholder.destroy();
        this._chromeGroup.destroy();
        this.actor.destroy();
    }
};


// ═══════════════════════════════════════════════════════════════════════════════
//  ScaleView – the fullscreen overlay that replaces Cinnamon's overview
// ═══════════════════════════════════════════════════════════════════════════════

function ScaleView() { this._init(); }

ScaleView.prototype = {

    _init: function() {
        this._visible = false;
        this._shown = false;
        this._modal = false;
        this._animating = false;
        this._monitors = [];

        // Main overlay widget – lives in global.overlay_group
        this._overlay = new St.Widget({
            name: 'super-scale-overlay',
            reactive: true,
            visible: false
        });
        global.overlay_group.add_actor(this._overlay);

        this._keyPressId   = 0;
        this._keyReleaseId = 0;
        this._background   = null;
        this._shade        = null;
        this._coverPane    = null;
        this._currentMonitorIndex = 0;
    },

    // ── Public API ───────────────────────────────────────────────────────────

    show: function() {
        if (this._shown || this._animating) return;
        if (Main.expo.visible) return;

        if (!Main.pushModal(this._overlay)) return;
        this._modal = true;
        this._shown = true;

        // Keep Main.overview flags in sync so the rest of Cinnamon
        // knows an overview-like view is active.
        Main.overview._shown = true;
        Main.overview.visible = true;

        this._animateVisible();
    },

    hide: function() {
        if (!this._shown) return;
        this._shown = false;
        Main.overview._shown = false;
        this._animateNotVisible();
    },

    toggle: function() {
        if (this._shown) this.hide();
        else this.show();
    },

    // ── Show transition ──────────────────────────────────────────────────────

    _animateVisible: function() {
        if (this._visible || this._animating) return;

        this._visible   = true;
        this._animating = true;
        Main.overview.visible = true;
        Main.overview.animationInProgress = true;

        // Desktop background clone + dark shade
        this._background = new Clutter.Actor();
        this._background.set_position(0, 0);
        this._overlay.add_actor(this._background);

        let bgActor;
        if (!Meta.is_wayland_compositor()) {
            bgActor = Meta.X11BackgroundActor.new_for_display(global.display);
        } else {
            bgActor = new Clutter.Actor();
        }
        this._background.add_actor(bgActor);

        this._shade = new St.Bin({
            style_class: 'super-scale-background-shade',
            reactive: true       // clicks on shade → close the view
        });
        this._shade.set_size(global.screen_width, global.screen_height);
        this._shade.connect('button-press-event', () => {
            this.hide();
            return Clutter.EVENT_STOP;
        });
        this._background.add_actor(this._shade);

        // Cover pane – blocks mouse events during animations
        this._coverPane = new Clutter.Actor({
            opacity: 0, reactive: true,
            width: global.screen_width, height: global.screen_height
        });
        this._coverPane.connect('event', () => Clutter.EVENT_STOP);
        this._overlay.add_actor(this._coverPane);

        // Disable full-screen unredirect so we can draw over everything
        Meta.disable_unredirect_for_display(global.display);

        // Build per-monitor tile views
        this._createMonitorViews();

        // Hide panels during the view
        Main.panelManager.disablePanels();

        // Keyboard input
        this._keyPressId = this._overlay.connect(
            'key-press-event', this._onKeyPress.bind(this));
        this._keyReleaseId = this._overlay.connect(
            'key-release-event', this._onKeyRelease.bind(this));

        // Start fade-in
        this._overlay.show();
        this._coverPane.raise_top();
        this._coverPane.show();

        Main.overview.emit('showing');

        this._overlay.opacity = 0;
        this._overlay.ease({
            opacity: 255,
            duration: ANIMATION_TIME * 0.5,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._showDone()
        });

        // Animate tiles from original positions to grid
        this._monitors.forEach(m => m.zoomToOverview());
    },

    _showDone: function() {
        this._animating = false;
        Main.overview.animationInProgress = false;
        this._coverPane.hide();
        Main.overview.emit('shown');
        global.sync_pointer();

        // Set initial keyboard selection on the current monitor
        this._currentMonitorIndex = Main.layoutManager.currentMonitor.index;
        let mon = this._monitors[this._currentMonitorIndex];
        if (mon && !mon.isEmpty()) {
            mon.selectIndex(0);
        }
    },

    // ── Hide transition ──────────────────────────────────────────────────────

    _animateNotVisible: function() {
        if (!this._visible || this._animating) return;

        this._animating = true;
        Main.overview.animationInProgress = true;

        Main.panelManager.enablePanels();
        this._monitors.forEach(m => m.zoomFromOverview());

        this._coverPane.raise_top();
        this._coverPane.show();
        Main.overview.emit('hiding');

        this._overlay.ease({
            opacity: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this._hideDone()
        });
    },

    _hideDone: function() {
        this._disconnectInput();
        this._destroyMonitorViews();

        if (this._coverPane) { this._coverPane.destroy(); this._coverPane = null; }
        if (this._shade)     { this._shade = null; /* destroyed with background */ }
        if (this._background){ this._background.destroy(); this._background = null; }

        Meta.enable_unredirect_for_display(global.display);

        if (this._modal) {
            Main.popModal(this._overlay);
            this._modal = false;
        }

        this._overlay.hide();
        this._visible   = false;
        this._animating = false;

        Main.overview.visible = false;
        Main.overview.animationInProgress = false;
        Main.overview._hideInProgress = false;

        Main.overview.emit('hidden');
        Main.layoutManager._chrome.updateRegions();
    },

    // ── Monitor views ────────────────────────────────────────────────────────

    _createMonitorViews: function() {
        Main.layoutManager.monitors.forEach((monitor, index) => {
            let monView = new MonitorView(monitor, index, this);
            this._monitors.push(monView);
            this._overlay.add_actor(monView.actor);
            this._overlay.add_actor(monView._chromeGroup);
        });
    },

    _destroyMonitorViews: function() {
        this._monitors.forEach(m => m.destroy());
        this._monitors = [];
    },

    // ── Input ────────────────────────────────────────────────────────────────

    _disconnectInput: function() {
        if (this._keyPressId)   { this._overlay.disconnect(this._keyPressId);   this._keyPressId = 0;   }
        if (this._keyReleaseId) { this._overlay.disconnect(this._keyReleaseId); this._keyReleaseId = 0; }
    },

    _onKeyPress: function(actor, event) {
        let symbol    = event.get_key_symbol();
        let modifiers = Cinnamon.get_event_state(event);

        // Ctrl+W – close selected window
        if (symbol === Clutter.KEY_w &&
            (modifiers & Clutter.ModifierType.CONTROL_MASK)) {
            let mon = this._monitors[this._currentMonitorIndex];
            if (mon) mon.closeSelectedWindow();
            return Clutter.EVENT_STOP;
        }

        // Tab / Shift+Tab – cycle monitors
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            let inc = symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1;
            this._switchMonitor(inc);
            return Clutter.EVENT_STOP;
        }

        // Arrow keys / Home / End – navigate tiles
        if ([Clutter.KEY_Left, Clutter.KEY_Right,
             Clutter.KEY_Up,   Clutter.KEY_Down,
             Clutter.KEY_Home, Clutter.KEY_End].indexOf(symbol) !== -1) {
            let mon = this._monitors[this._currentMonitorIndex];
            if (mon) mon.selectAnotherWindow(symbol);
            return Clutter.EVENT_STOP;
        }

        // Enter / Space – activate selected window
        if (symbol === Clutter.KEY_Return ||
            symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_space) {
            let mon = this._monitors[this._currentMonitorIndex];
            if (mon && mon.activateSelectedWindow()) return Clutter.EVENT_STOP;
            this.hide();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onKeyRelease: function(actor, event) {
        let symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape ||
            symbol === Clutter.KEY_Super_L ||
            symbol === Clutter.KEY_Super_R) {
            this.hide();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _switchMonitor: function(increment) {
        let count = this._monitors.length;
        if (count < 2) return;
        for (let i = 0; i < count; i++) {
            let next = (this._currentMonitorIndex + count + increment * (i + 1)) % count;
            if (!this._monitors[next].isEmpty()) {
                this._currentMonitorIndex = next;
                this._monitors[next].selectIndex(0);
                return;
            }
        }
    },

    // ── Window activation ────────────────────────────────────────────────────

    /**
     * activateWindow:
     * Brings @metaWindow to focus, switching workspace if necessary,
     * then closes the view.
     */
    activateWindow: function(metaWindow, time) {
        if (!time) time = global.get_current_time();

        let windowWorkspace = metaWindow.get_workspace();
        let activeWorkspace = global.workspace_manager.get_active_workspace();

        if (windowWorkspace && windowWorkspace !== activeWorkspace) {
            windowWorkspace.activate_with_focus(metaWindow, time);
        } else {
            metaWindow.activate(time);
        }

        this.hide();
    },

    // ── Full teardown ────────────────────────────────────────────────────────

    destroy: function() {
        if (this._shown) {
            this._disconnectInput();
            if (this._modal) { Main.popModal(this._overlay); this._modal = false; }
            Main.panelManager.enablePanels();
            Meta.enable_unredirect_for_display(global.display);
        }

        this._destroyMonitorViews();

        if (this._coverPane)  { this._coverPane.destroy();  this._coverPane = null;  }
        if (this._background) { this._background.destroy(); this._background = null; }
        if (this._overlay)    { this._overlay.destroy();     this._overlay = null;    }

        Main.overview.visible = false;
        Main.overview._shown  = false;
        Main.overview.animationInProgress = false;
    }
};


// ═══════════════════════════════════════════════════════════════════════════════
//  Extension entry points
// ═══════════════════════════════════════════════════════════════════════════════

let origShow, origHide, origToggle, origShowTemp, origHideTemp;
let scaleView = null;

function init(extensionMeta) {
    UUID = extensionMeta.uuid;
    Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
}

function enable() {
    scaleView = new ScaleView();

    origShow     = Overview.Overview.prototype.show;
    origHide     = Overview.Overview.prototype.hide;
    origToggle   = Overview.Overview.prototype.toggle;
    origShowTemp = Overview.Overview.prototype.showTemporarily;
    origHideTemp = Overview.Overview.prototype.hideTemporarily;

    Overview.Overview.prototype.show             = function() { scaleView.show(); };
    Overview.Overview.prototype.hide             = function() { scaleView.hide(); };
    Overview.Overview.prototype.toggle           = function() { scaleView.toggle(); };
    Overview.Overview.prototype.showTemporarily   = function() { scaleView.show(); };
    Overview.Overview.prototype.hideTemporarily    = function() { scaleView.hide(); };
}

function disable() {
    if (scaleView) {
        scaleView.destroy();
        scaleView = null;
    }

    Overview.Overview.prototype.show             = origShow;
    Overview.Overview.prototype.hide             = origHide;
    Overview.Overview.prototype.toggle           = origToggle;
    Overview.Overview.prototype.showTemporarily   = origShowTemp;
    Overview.Overview.prototype.hideTemporarily    = origHideTemp;
}
