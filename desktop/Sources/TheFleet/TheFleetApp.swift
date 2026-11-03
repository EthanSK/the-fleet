// The Fleet: a Dock app for the one shared local coordinator.
// Quitting it stops only this app's polling; the service and its jobs keep running.

import SwiftUI
import AppKit
import FleetUI

@main
struct TheFleetApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = FleetStore.live()

    var body: some Scene {
        WindowGroup("The Fleet", id: FleetWindowID.main) {
            FleetRootView(store: store)
                .frame(minWidth: 780, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 780)
        .commands { FleetCommands(store: store) }

        Settings {
            FleetSettingsView(store: store)
        }

        Window("The Fleet Help", id: FleetWindowID.help) {
            FleetHelpView()
        }
        .defaultSize(width: 680, height: 760)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // A bundled app is already a regular Dock app; this also covers `swift run`.
        NSApp.setActivationPolicy(.regular)
        // Show the approved cutout at full Dock size. Asking LaunchServices for
        // the legacy ICNS adds a padded tile on newer macOS, shrinking the ships.
        // Read our bundled artwork directly; the PNG itself stays unchanged.
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
