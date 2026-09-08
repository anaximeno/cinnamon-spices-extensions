const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Cinnamon = imports.gi.Cinnamon;
const Pango = imports.gi.Pango;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;

const ModalDialog = imports.ui.modalDialog;
const CinnamonEntry = imports.ui.cinnamonEntry;
const Main = imports.ui.main;
const GnomeSession = imports.misc.gnomeSession;
const Util = imports.misc.util;

const UUID = "cinnabon-launcher@anaximeno";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(str) {
    return Gettext.dgettext(UUID, str);
}

// Used for the results-viewport aspect ratio and the calculator's hero icon size.
const GOLDEN_RATIO = 1.618033988749895;

const BASE_DIALOG_WIDTH = 680;
const BASE_ICON_SIZE = 28;
const MAX_FREQUENT_APPS = 8;
const ROW_ANIMATION_STEP_MS = 12;
const ROW_ANIMATION_MAX_DELAY_MS = 120;
const ROW_ANIMATION_DURATION_MS = 140;
const SEARCH_DEBOUNCE_MS = 90;

function normalize(text) {
    if (!text)
        return "";
    return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Cinnamon scales explicit JS pixel sizes via global.ui_scale; CSS-driven
// sizes scale automatically, these don't.
function computeMetrics() {
    let scale = global.ui_scale || 1;
    let monitor = Main.layoutManager.primaryMonitor;
    let monitorWidth = monitor ? monitor.width : 1280;

    let width = Math.round(BASE_DIALOG_WIDTH * scale);
    // Never take up more of a small/projector-sized monitor than this.
    width = Math.min(width, Math.round(monitorWidth * 0.92));

    let iconSize = Math.round(BASE_ICON_SIZE * scale);
    let heroIconSize = Math.round(iconSize * GOLDEN_RATIO);
    let listMaxHeight = Math.round(width / GOLDEN_RATIO);

    return { scale, width, iconSize, heroIconSize, listMaxHeight };
}

// fzf-style subsequence scoring: rewards consecutive runs and word-start
// matches. Returns null when query isn't a subsequence of text.
function fuzzyMatch(query, text) {
    if (query.length === 0)
        return { score: 0, matches: [] };

    let qi = 0;
    let score = 0;
    let consecutive = 0;
    let prevMatched = false;
    let matches = [];

    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
        if (text[ti] !== query[qi])
            continue;

        let atWordStart = ti === 0 || /[\s\-_./]/.test(text[ti - 1]);

        score += 10;
        if (prevMatched) {
            consecutive++;
            score += 5 * consecutive;
        } else {
            consecutive = 0;
        }
        if (atWordStart)
            score += 15;

        matches.push(ti);
        prevMatched = true;
        qi++;
    }

    if (qi < query.length)
        return null;

    score -= Math.floor(text.length / 10);
    score -= matches[0];

    return { score, matches };
}

function buildHighlightMarkup(title, matches) {
    if (!matches || matches.length === 0)
        return GLib.markup_escape_text(title, -1);

    let matchSet = new Set(matches);
    let out = "";
    for (let i = 0; i < title.length; i++) {
        let ch = GLib.markup_escape_text(title[i], -1);
        out += matchSet.has(i) ? `<b>${ch}</b>` : ch;
    }
    return out;
}

// entry needs .nameNorm and .searchText (a broader haystack for recall
// even when the name itself doesn't fuzzy-match).
function matchEntry(query, entry, nameBonus) {
    let m = fuzzyMatch(query, entry.nameNorm);
    if (m)
        return { score: m.score + nameBonus, matches: m.matches };
    if (entry.searchText.includes(query))
        return { score: -1, matches: [] };
    return null;
}

const MATH_CHARS_RE = /^[\d\s+\-*/^%.()]+$/;

function looksLikeMathExpression(raw) {
    let t = raw.trim();
    if (!t || !MATH_CHARS_RE.test(t))
        return false;
    return /\d/.test(t) && /[+\-*/^%]/.test(t);
}

function tokenizeMathExpression(text) {
    let tokens = [];
    let re = /(\d+\.\d+|\d+|[+\-*/^%()])/y;
    let i = 0;
    while (i < text.length) {
        re.lastIndex = i;
        let m = re.exec(text);
        if (!m || m.index !== i)
            return null;
        tokens.push(m[1]);
        i = re.lastIndex;
    }
    return tokens;
}

// Hand-written recursive-descent evaluator; avoids eval()/Function() entirely.
function evaluateMathExpression(rawText) {
    let tokens = tokenizeMathExpression(rawText.replace(/\s+/g, ""));
    if (!tokens || tokens.length === 0)
        return null;

    let pos = { i: 0 };

    function parseExpr() {
        let value = parseTerm();
        while (tokens[pos.i] === "+" || tokens[pos.i] === "-") {
            let op = tokens[pos.i++];
            let rhs = parseTerm();
            value = op === "+" ? value + rhs : value - rhs;
        }
        return value;
    }

    function parseTerm() {
        let value = parseUnary();
        while (tokens[pos.i] === "*" || tokens[pos.i] === "/" || tokens[pos.i] === "%") {
            let op = tokens[pos.i++];
            let rhs = parseUnary();
            if (op === "*") value *= rhs;
            else if (op === "/") value /= rhs;
            else value %= rhs;
        }
        return value;
    }

    function parseUnary() {
        if (tokens[pos.i] === "-") {
            pos.i++;
            return -parseUnary();
        }
        if (tokens[pos.i] === "+") {
            pos.i++;
            return parseUnary();
        }
        return parsePower();
    }

    function parsePower() {
        let base = parsePrimary();
        if (tokens[pos.i] === "^") {
            pos.i++;
            let exp = parseUnary();
            return Math.pow(base, exp);
        }
        return base;
    }

    function parsePrimary() {
        let tok = tokens[pos.i];
        if (tok === undefined)
            throw new Error("unexpected end of expression");
        if (tok === "(") {
            pos.i++;
            let value = parseExpr();
            if (tokens[pos.i] !== ")")
                throw new Error("expected )");
            pos.i++;
            return value;
        }
        if (/^\d/.test(tok)) {
            pos.i++;
            return parseFloat(tok);
        }
        throw new Error(`unexpected token ${tok}`);
    }

    let value;
    try {
        value = parseExpr();
    } catch (e) {
        return null;
    }

    if (pos.i !== tokens.length || !isFinite(value))
        return null;

    return value;
}

function formatMathResult(value) {
    if (Object.is(value, -0))
        value = 0;
    return String(Math.round(value * 1e9) / 1e9);
}

class UsageTracker {
    constructor() {
        this._path = GLib.build_filenamev([GLib.get_user_cache_dir(), UUID, "usage.json"]);
        this._data = this._load();
    }

    _load() {
        try {
            let [ok, contents] = GLib.file_get_contents(this._path);
            if (!ok)
                return {};
            return JSON.parse(ByteArray.toString(contents));
        } catch (e) {
            return {};
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
            GLib.file_set_contents(this._path, JSON.stringify(this._data));
        } catch (e) {
            log(`cinnabon-launcher: failed to persist usage data: ${e}`);
        }
    }

    recordLaunch(appId) {
        let entry = this._data[appId] || { count: 0, last: 0 };
        entry.count += 1;
        entry.last = Date.now();
        this._data[appId] = entry;
        this._save();
    }

    score(appId) {
        let entry = this._data[appId];
        if (!entry)
            return 0;
        let ageDays = (Date.now() - entry.last) / 86400000;
        let recencyBoost = Math.max(0, 30 - ageDays);
        return entry.count * 3 + recencyBoost;
    }
}

// Matches the Cinnamon menu applet's own system buttons: instant, no
// confirmation dialog (see menu@cinnamon.org/applet.js).
function buildSystemActions() {
    let session = null;
    function getSession() {
        if (!session)
            session = new GnomeSession.SessionManager();
        return session;
    }

    return [
        {
            id: "lock-screen",
            name: _("Lock Screen"),
            keywords: normalize(_("lock screen screensaver")),
            iconName: "xsi-lock-screen-symbolic",
            run: () => Main.screensaverController.lockScreen(true),
        },
        {
            id: "log-out",
            name: _("Log Out"),
            keywords: normalize(_("logout sign out leave session")),
            iconName: "xsi-log-out-symbolic",
            run: () => getSession().LogoutRemote(0),
        },
        {
            id: "shut-down",
            name: _("Shut Down"),
            keywords: normalize(_("shutdown power off turn off")),
            iconName: "xsi-shutdown-symbolic",
            run: () => getSession().ShutdownRemote(),
        },
        {
            id: "settings",
            name: _("Open Settings"),
            keywords: normalize(_("preferences control panel")),
            iconName: "preferences-system-symbolic",
            run: () => Util.spawnCommandLine("cinnamon-settings"),
        },
    ];
}

function wireRowInteractions(actor, row) {
    actor.connect("enter-event", () => actor.add_style_pseudo_class("hover"));
    actor.connect("leave-event", () => actor.remove_style_pseudo_class("hover"));
    actor.connect("button-release-event", () => {
        row.activate();
        return Clutter.EVENT_STOP;
    });
}

// Shared shape for apps, system actions and the calculator "answer" row.
// Persistent rows (apps/actions) live for the dialog's lifetime; only their
// title markup is refreshed on re-filter, not the actor tree.
class ResultRow {
    constructor(opts) {
        this.kind = opts.kind;
        this.name = opts.name;
        this.nameNorm = normalize(opts.name);
        this.searchText = opts.searchText || this.nameNorm;
        this._onActivate = opts.onActivate;
        this._highlighted = false;

        this.actor = new St.BoxLayout({
            style_class: "cinnabon-launcher-row" + (opts.hero ? " cinnabon-launcher-row-hero" : ""),
            reactive: true,
            track_hover: true,
            width: opts.width,
        });

        let icon = opts.iconTexture || null;
        if (!icon) {
            icon = new St.Icon({
                icon_name: opts.iconName || "application-x-executable",
                icon_size: opts.iconSize,
            });
        }
        this.actor.add_child(new St.Bin({ child: icon, y_align: St.Align.MIDDLE }));

        let textBox = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });

        this.titleLabel = new St.Label({ text: this.name, style_class: "cinnabon-launcher-row-label" });
        this.titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.titleLabel.clutter_text.line_wrap = false;
        textBox.add_child(this.titleLabel);

        if (opts.subtitle) {
            this.subtitleLabel = new St.Label({ text: opts.subtitle, style_class: "cinnabon-launcher-row-subtitle" });
            this.subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(this.subtitleLabel);
        }

        this.actor.add_child(textBox);

        wireRowInteractions(this.actor, this);
    }

    setTitleHighlight(matches) {
        if (matches && matches.length > 0) {
            this.titleLabel.clutter_text.set_use_markup(true);
            this.titleLabel.clutter_text.set_markup(buildHighlightMarkup(this.name, matches));
            this._highlighted = true;
        } else if (this._highlighted) {
            this.titleLabel.clutter_text.set_use_markup(false);
            this.titleLabel.set_text(this.name);
            this._highlighted = false;
        }
    }

    setSelected(selected) {
        if (selected)
            this.actor.add_style_pseudo_class("selected");
        else
            this.actor.remove_style_pseudo_class("selected");
    }

    activate() {
        this._onActivate();
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

        this._metrics = computeMetrics();
        this._usage = new UsageTracker();

        this._searchEntry = new St.Entry({
            style_class: "cinnabon-launcher-search",
            hint_text: _("Search apps, actions, or type a sum…"),
            can_focus: true,
            width: this._metrics.width,
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
            width: this._metrics.width,
            height: this._metrics.listMaxHeight,
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

        this._appEntries = [];
        this._actionEntries = buildSystemActions().map(action => this._makeActionEntry(action));
        this._calculatorRow = null;
        this._visibleRows = [];
        this._selectedIndex = -1;
        this._filterTimeoutId = 0;

        // Building rows touches theme-node/size negotiation, which St only
        // resolves correctly once this dialog is mapped - so the very first
        // population is deferred to the first open() (see toggle()) rather
        // than done here.
        this._appsDirty = true;

        this._appSystem = Cinnamon.AppSystem.get_default();
        this._installedChangedId = this._appSystem.connect("installed-changed", () => {
            this._appsDirty = true;
        });

        this.dialogLayout.set_pivot_point(0.5, 0.5);
    }

    // Bound to the "open-launcher" setting by extension.js; kept here only
    // so callers have a stable place to look for the current accelerator.
    open_launcher() {}

    toggle() {
        if (this.state === ModalDialog.State.OPENED || this.state === ModalDialog.State.OPENING) {
            this.close();
            return;
        }

        this.dialogLayout.scale_x = 0.96;
        this.dialogLayout.scale_y = 0.96;

        if (!this.open(global.get_current_time()))
            return;

        this.dialogLayout.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (this._appsDirty) {
            this._refreshApps();
            this._appsDirty = false;
        }
        this._searchEntry.set_text("");
    }

    close(timestamp) {
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = 0;
        }
        this.dialogLayout.ease({
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        super.close(timestamp);
    }

    _makeAppEntry(app) {
        let name = app.get_name() || "";
        let searchText = normalize([name, app.get_keywords(), app.get_description(), app.get_id()]
            .filter(Boolean).join(" "));
        let description = app.get_description();
        let subtitle = (description && description !== name) ? description : null;

        let row = new ResultRow({
            kind: "app",
            name,
            searchText,
            subtitle,
            width: this._metrics.width,
            iconSize: this._metrics.iconSize,
            iconTexture: app.create_icon_texture(this._metrics.iconSize),
            onActivate: () => {
                this._usage.recordLaunch(app.get_id());
                app.open_new_window(-1);
                this.close();
            },
        });
        row.app = app;
        return row;
    }

    _makeActionEntry(action) {
        return new ResultRow({
            kind: "action",
            name: action.name,
            searchText: action.keywords,
            subtitle: _("System Action"),
            width: this._metrics.width,
            iconSize: this._metrics.iconSize,
            iconName: action.iconName,
            onActivate: () => {
                action.run();
                this.close();
            },
        });
    }

    _makeCalculatorRow(rawQuery) {
        if (!looksLikeMathExpression(rawQuery))
            return null;

        let value = evaluateMathExpression(rawQuery);
        if (value === null)
            return null;

        let resultText = formatMathResult(value);

        return new ResultRow({
            kind: "calculator",
            name: resultText,
            hero: true,
            subtitle: `${rawQuery.trim()} = ${resultText}  ·  ${_("Enter to copy")}`,
            width: this._metrics.width,
            iconSize: this._metrics.heroIconSize,
            iconName: "accessories-calculator-symbolic",
            onActivate: () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, resultText);
                this.close();
            },
        });
    }

    _makeSectionHeader(title) {
        return new St.Label({ text: title, style_class: "cinnabon-launcher-section-header" });
    }

    _refreshApps() {
        this._appEntries.forEach(entry => entry.destroy());

        let apps = this._appSystem.get_all().filter(app => !app.get_nodisplay());
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

        this._appEntries = apps.map(app => this._makeAppEntry(app));

        this._applyFilter(this._searchEntry.get_text(), true);
    }

    _onSearchChanged() {
        let hasText = this._searchEntry.get_text().length > 0;
        this._searchEntry.set_secondary_icon(hasText ? this._searchActiveIcon : this._searchInactiveIcon);

        // Rebuilding the list and re-scoring every entry on literally every
        // keystroke is what made typing feel laggy; debounce it instead.
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);

        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._filterTimeoutId = 0;
            this._applyFilter(this._searchEntry.get_text());
            return GLib.SOURCE_REMOVE;
        });
    }

    // Applies any debounced filter immediately, so Return/Up/Down always act
    // on the current text instead of whatever was last rendered.
    _flushPendingFilter() {
        if (!this._filterTimeoutId)
            return;
        GLib.source_remove(this._filterTimeoutId);
        this._filterTimeoutId = 0;
        this._applyFilter(this._searchEntry.get_text());
    }

    _animateRowIn(actor, index) {
        actor.opacity = 0;
        actor.translation_y = 6;
        actor.ease({
            opacity: 255,
            translation_y: 0,
            delay: Math.min(index * ROW_ANIMATION_STEP_MS, ROW_ANIMATION_MAX_DELAY_MS),
            duration: ROW_ANIMATION_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _applyFilter(rawQuery, animate = false) {
        this._list.remove_all_children();

        if (this._calculatorRow) {
            this._calculatorRow.destroy();
            this._calculatorRow = null;
        }

        let query = normalize(rawQuery.trim());
        let ordered = [];

        if (query.length === 0) {
            this._appEntries.forEach(entry => entry.setTitleHighlight(null));
            this._actionEntries.forEach(entry => entry.setTitleHighlight(null));

            let frequent = this._appEntries
                .map(entry => ({ entry, score: this._usage.score(entry.app.get_id()) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_FREQUENT_APPS)
                .map(x => x.entry);
            let frequentSet = new Set(frequent);
            let rest = this._appEntries.filter(entry => !frequentSet.has(entry));

            if (frequent.length > 0 && rest.length > 0) {
                ordered.push({ header: _("Frequently Used") });
                frequent.forEach(entry => ordered.push({ row: entry }));
                ordered.push({ header: _("All Applications") });
                rest.forEach(entry => ordered.push({ row: entry }));
            } else {
                this._appEntries.forEach(entry => ordered.push({ row: entry }));
            }
        } else {
            let appMatches = [];
            for (let entry of this._appEntries) {
                let m = matchEntry(query, entry, 1000);
                if (m)
                    appMatches.push({ entry, m });
            }
            appMatches.sort((a, b) => b.m.score - a.m.score || a.entry.name.localeCompare(b.entry.name));
            appMatches.forEach(({ entry, m }) => entry.setTitleHighlight(m.matches));

            let unmatchedApps = new Set(this._appEntries);
            appMatches.forEach(({ entry }) => unmatchedApps.delete(entry));
            unmatchedApps.forEach(entry => entry.setTitleHighlight(null));

            let actionMatches = [];
            for (let entry of this._actionEntries) {
                let m = matchEntry(query, entry, 500);
                if (m)
                    actionMatches.push({ entry, m });
            }
            actionMatches.sort((a, b) => b.m.score - a.m.score);
            actionMatches.forEach(({ entry, m }) => entry.setTitleHighlight(m.matches));

            let unmatchedActions = new Set(this._actionEntries);
            actionMatches.forEach(({ entry }) => unmatchedActions.delete(entry));
            unmatchedActions.forEach(entry => entry.setTitleHighlight(null));

            this._calculatorRow = this._makeCalculatorRow(rawQuery);
            if (this._calculatorRow)
                ordered.push({ row: this._calculatorRow });

            let showHeaders = appMatches.length > 0 && actionMatches.length > 0;
            if (showHeaders)
                ordered.push({ header: _("Applications") });
            appMatches.forEach(({ entry }) => ordered.push({ row: entry }));
            if (showHeaders)
                ordered.push({ header: _("Actions") });
            actionMatches.forEach(({ entry }) => ordered.push({ row: entry }));
        }

        this._visibleRows = [];
        let rowIndex = 0;
        for (let item of ordered) {
            if (item.header) {
                this._list.add_child(this._makeSectionHeader(item.header));
            } else {
                this._list.add_child(item.row.actor);
                this._visibleRows.push(item.row);
                if (animate) {
                    this._animateRowIn(item.row.actor, rowIndex++);
                } else {
                    item.row.actor.remove_all_transitions();
                    item.row.actor.opacity = 255;
                    item.row.actor.translation_y = 0;
                }
            }
        }

        this._selectedIndex = this._visibleRows.length > 0 ? 0 : -1;
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

        let isNavigationKey = symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_ISO_Enter || symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up;
        if (isNavigationKey)
            this._flushPendingFilter();

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
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);
        if (this._searchIconClickedId)
            this._searchEntry.disconnect(this._searchIconClickedId);
        this._appSystem.disconnect(this._installedChangedId);
        super.destroy();
    }
});

module.exports = { LauncherDialog };
