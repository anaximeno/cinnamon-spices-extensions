const Main = imports.ui.main;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

let originalIsMyWindow = null;
let originalOnCloneActivated = null;
let originalOnMappedChanged = null;
let originalActiveWorkspaceChanged = null;

function init() {
    originalIsMyWindow = Workspace.WorkspaceMonitor.prototype._isMyWindow;
    originalOnCloneActivated = Workspace.WorkspaceMonitor.prototype._onCloneActivated;
    originalOnMappedChanged = WorkspacesView.WorkspacesView.prototype._onMappedChanged;
    originalActiveWorkspaceChanged = WorkspacesView.WorkspacesView.prototype._activeWorkspaceChanged;
}

function enable() {
    // Override _isMyWindow to show windows from all workspaces
    Workspace.WorkspaceMonitor.prototype._isMyWindow = function(win) {
        return (!win.get_meta_window() || win.get_meta_window().get_monitor() == this.monitorIndex);
    };

    // Override _onCloneActivated to properly activate a window, switching to its
    // workspace if needed, and always closing the scale view afterwards.
    Workspace.WorkspaceMonitor.prototype._onCloneActivated = function(clone, time) {
        let metaWindow = clone.metaWindow;
        if (!metaWindow) return;

        let windowWorkspace = metaWindow.get_workspace();
        let activeWorkspace = global.workspace_manager.get_active_workspace();

        if (windowWorkspace && windowWorkspace !== activeWorkspace) {
            // Window lives on a different workspace: switch to it and give it focus.
            // We do this manually because Main.activateWindow() returns early in this
            // case and never calls overview.hide(), leaving the scale view open.
            windowWorkspace.activate_with_focus(metaWindow, time);
        } else {
            // Same workspace (or sticky window): activate directly.
            metaWindow.activate(time);
        }

        Main.overview.hide();
        Main.expo.hide();
    };

    // Override _onMappedChanged to disable swipe scrolling between workspaces.
    WorkspacesView.WorkspacesView.prototype._onMappedChanged = function() {
        if (this.actor.mapped) {
            let direction = 0; // SwipeScrollDirection.NONE
            Main.overview.setScrollAdjustment(this._scrollAdjustment, direction);
            this._swipeScrollBeginId = Main.overview.connect('swipe-scroll-begin',
                                              this._swipeScrollBegin.bind(this));
            this._swipeScrollEndId = Main.overview.connect('swipe-scroll-end',
                                              this._swipeScrollEnd.bind(this));
        }
    };

    // Override _activeWorkspaceChanged to prevent workspace-switch signals from
    // scrolling the view or hiding other workspaces' windows. Since _isMyWindow
    // already shows all workspaces' windows, a workspace switch has no visual
    // meaning in this view.
    WorkspacesView.WorkspacesView.prototype._activeWorkspaceChanged = function(wm, from, to, direction) {
        // intentional no-op
    };
}

function disable() {
    if (originalIsMyWindow) {
        Workspace.WorkspaceMonitor.prototype._isMyWindow = originalIsMyWindow;
    }
    if (originalOnCloneActivated) {
        Workspace.WorkspaceMonitor.prototype._onCloneActivated = originalOnCloneActivated;
    }
    if (originalOnMappedChanged) {
        WorkspacesView.WorkspacesView.prototype._onMappedChanged = originalOnMappedChanged;
    }
    if (originalActiveWorkspaceChanged) {
        WorkspacesView.WorkspacesView.prototype._activeWorkspaceChanged = originalActiveWorkspaceChanged;
    }
}
