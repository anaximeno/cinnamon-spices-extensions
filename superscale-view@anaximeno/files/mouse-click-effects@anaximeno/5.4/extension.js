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
const Gettext = imports.gettext;
const { GLib, Gio } = imports.gi;
const { Debouncer, logInfo, logError } = require("./helpers.js");

const UUID = "superscale-view@anaximeno";

Gettext.bindtextdomain(UUID, `${GLib.get_home_dir()}/.local/share/locale`);


function _(text) {
	let localized = Gettext.dgettext(UUID, text);
	return localized != text ? localized : window._(text);
}


class SuperscaleView {
	constructor(metadata) {
		this.metadata = metadata;
	}

	enable() {

	}

	destroy() {

	}
}


let extension = null;

function enable() {
	extension.enable();
}

function disable() {
	extension.disable();
	extension = null;
}

function init(metadata) {
	if (!extension) {
		extension = new MouseClickEffects(metadata);
	}
}