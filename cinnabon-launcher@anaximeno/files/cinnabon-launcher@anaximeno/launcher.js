const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Cinnamon = imports.gi.Cinnamon;
const Pango = imports.gi.Pango;
const Gettext = imports.gettext;

const ModalDialog = imports.ui.modalDialog;
const CinnamonEntry = imports.ui.cinnamonEntry;

const UUID = "cinnabon-launcher@anaximeno";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(str) {
    return Gettext.dgettext(UUID, str);
}

const ICON_SIZE = 32;
const LIST_WIDTH = 680;
const LIST_MAX_HEIGHT = 320;

function normalize(text) {
    if (!text)
        return "";
    return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

class AppRow {
    constructor(dialog, app) {
        this._dialog = dialog;
        this.app = app;
        this.name = app.get_name() || "";

        this.actor = new St.BoxLayout({
            style_class: "cinnabon-launcher-row",
            vertical: false,
            reactive: true,
            track_hover: true,
            width: LIST_WIDTH,
        });

        let icon = app.create_icon_texture(ICON_SIZE);
        if (!icon) {
            icon = new St.Icon({
                icon_name: "application-x-executable",
                icon_size: ICON_SIZE,
            });
        }
        this._iconBin = new St.Bin({ child: icon, y_align: St.Align.MIDDLE });
        this.actor.add_child(this._iconBin);

        this._label = new St.Label({
            text: this.name,
            style_class: "cinnabon-launcher-row-label",
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.clutter_text.line_wrap = false;
        this.actor.add_child(this._label);

        this.actor.connect("enter-event", () => {
            this.actor.add_style_pseudo_class("hover");
        });
        this.actor.connect("leave-event", () => {
            this.actor.remove_style_pseudo_class("hover");
        });
        this.actor.connect("button-release-event", () => {
            this.activate();
            return Clutter.EVENT_STOP;
        });

        this.searchText = normalize([
            this.name,
            app.get_keywords(),
            app.get_description(),
            app.get_id(),
        ].filter(Boolean).join(" "));
    }

    setSelected(selected) {
        if (selected)
            this.actor.add_style_pseudo_class("selected");
        else
            this.actor.remove_style_pseudo_class("selected");
    }

    activate() {
        this.app.open_new_window(-1);
        this._dialog.close();
    }

    destroy() {
        this.actor.destroy();
    }
}

var LauncherDialog = GObject.registerClass(
class LauncherDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({
            styleClass: "cinnabon-launcher-dialog",
            destroyOnClose: false,
        });

        this.buttonLayout.hide();

        this._searchEntry = new St.Entry({
            style_class: "cinnabon-launcher-search",
            hint_text: _("Type to search apps…"),
            can_focus: true,
            width: LIST_WIDTH,
        });
        CinnamonEntry.addContextMenu(this._searchEntry);

        this._searchInactiveIcon = new St.Icon({
            style_class: "cinnabon-launcher-search-icon",
            icon_name: "edit-find-symbolic",
            icon_size: 16,
        });
        this._searchActiveIcon = new St.Icon({
            style_class: "cinnabon-launcher-search-icon",
            icon_name: "edit-clear-symbolic",
            icon_size: 16,
        });
        this._searchEntry.set_secondary_icon(this._searchInactiveIcon);
        this._searchIconClickedId = this._searchEntry.connect("secondary-icon-clicked", () => {
            this._searchEntry.set_text("");
        });

        this.contentLayout.add_child(this._searchEntry);

        this._scrollView = new St.ScrollView({
            style_class: "cinnabon-launcher-scrollview",
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            clip_to_allocation: true,
            width: LIST_WIDTH,
            height: LIST_MAX_HEIGHT,
        });
        this._list = new St.BoxLayout({
            style_class: "cinnabon-launcher-list",
            vertical: true,
        });
        this._scrollView.add_actor(this._list);
        this.contentLayout.add_child(this._scrollView);

        this.setInitialKeyFocus(this._searchEntry.clutter_text);

        this._searchEntry.clutter_text.connect("text-changed", this._onSearchChanged.bind(this));
        this._searchEntry.clutter_text.connect("key-press-event", this._onKeyPress.bind(this));

        this._rows = [];
        this._visibleRows = [];
        this._selectedIndex = -1;

        // Building rows touches theme-node/size negotiation, which St only
        // resolves correctly once this dialog is mapped - so the very first
        // population is deferred to the first open() (see toggle()) rather
        // than done here.
        this._appsDirty = true;

        this._appSystem = Cinnamon.AppSystem.get_default();
        this._installedChangedId = this._appSystem.connect("installed-changed", () => {
            this._appsDirty = true;
        });
    }

    // Bound to the "open-launcher" setting by extension.js; kept here only
    // so callers have a stable place to look for the current accelerator.
    open_launcher() {}

    toggle() {
        if (this.state === ModalDialog.State.OPENED || this.state === ModalDialog.State.OPENING) {
            this.close();
            return;
        }

        if (!this.open(global.get_current_time()))
            return;

        if (this._appsDirty) {
            this._refreshApps();
            this._appsDirty = false;
        }
        this._searchEntry.set_text("");
    }

    _refreshApps() {
        this._rows.forEach(row => row.destroy());

        let apps = this._appSystem.get_all().filter(app => !app.get_nodisplay());
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

        this._rows = apps.map(app => new AppRow(this, app));

        this._applyFilter(this._searchEntry.get_text());
    }

    _onSearchChanged() {
        let hasText = this._searchEntry.get_text().length > 0;
        this._searchEntry.set_secondary_icon(hasText ? this._searchActiveIcon : this._searchInactiveIcon);
        this._applyFilter(this._searchEntry.get_text());
    }

    _applyFilter(rawQuery) {
        this._list.remove_all_children();

        let query = normalize(rawQuery.trim());
        let visible;

        if (query.length === 0) {
            visible = this._rows.slice();
        } else {
            visible = this._rows
                .filter(row => row.searchText.includes(query))
                .map(row => {
                    let nameNorm = normalize(row.name);
                    let rank = nameNorm.startsWith(query) ? 0 : (nameNorm.includes(query) ? 1 : 2);
                    return { row, rank };
                })
                .sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name))
                .map(entry => entry.row);
        }

        this._visibleRows = visible;
        this._selectedIndex = visible.length > 0 ? 0 : -1;

        for (let row of visible)
            this._list.add_child(row.actor);

        this._updateSelection();
    }

    _updateSelection() {
        this._visibleRows.forEach((row, i) => row.setSelected(i === this._selectedIndex));

        let selected = this._visibleRows[this._selectedIndex];
        if (selected)
            this._ensureRowVisible(selected);
    }

    _ensureRowVisible(row) {
        let adjustment = this._scrollView.vscroll ? this._scrollView.vscroll.adjustment : null;
        if (!adjustment)
            return;

        let box = row.actor.get_allocation_box();
        if (!box || (box.y1 === 0 && box.y2 === 0))
            return;

        let value = adjustment.value;
        let pageSize = adjustment.page_size;

        if (box.y1 < value)
            adjustment.value = box.y1;
        else if (box.y2 > value + pageSize)
            adjustment.value = box.y2 - pageSize;
    }

    _onKeyPress(actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (this._visibleRows.length === 0)
            return Clutter.EVENT_PROPAGATE;

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_ISO_Enter) {
            let row = this._visibleRows[this._selectedIndex >= 0 ? this._selectedIndex : 0];
            if (row)
                row.activate();
            return Clutter.EVENT_STOP;
        }

        let newIndex = this._selectedIndex;

        if (symbol === Clutter.KEY_Down)
            newIndex = Math.min(this._selectedIndex + 1, this._visibleRows.length - 1);
        else if (symbol === Clutter.KEY_Up)
            newIndex = Math.max(this._selectedIndex - 1, 0);
        else
            return Clutter.EVENT_PROPAGATE;

        if (newIndex !== this._selectedIndex) {
            this._selectedIndex = newIndex;
            this._updateSelection();
        }

        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._searchIconClickedId)
            this._searchEntry.disconnect(this._searchIconClickedId);
        this._appSystem.disconnect(this._installedChangedId);
        super.destroy();
    }
});

module.exports = { LauncherDialog };
