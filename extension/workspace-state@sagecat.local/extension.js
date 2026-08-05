import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// The previous extension module can remain loaded until this Wayland session
// ends. Keeping its UUID installed prevents GNOME from dropping that live
// bridge. On later logins this stub deliberately does nothing; the standalone
// gnome-winctl extension owns the current D-Bus API.
export default class WorkspaceStateMigrationStub extends Extension {
    enable() {}

    disable() {}
}
