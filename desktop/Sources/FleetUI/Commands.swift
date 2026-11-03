// Menu commands and keyboard shortcuts.

import SwiftUI

public struct FleetCommands: Commands {
    let store: FleetStore
    @Environment(\.openWindow) private var openWindow

    public init(store: FleetStore) {
        self.store = store
    }

    public var body: some Commands {
        // One main window; the File menu adds workers instead.
        CommandGroup(replacing: .newItem) {
            Button("Add Worker…") { store.sheet = .addWorker }
                .keyboardShortcut("n")
                .disabled(!store.connection.isConnected || store.serviceNeedsUpdate)
        }
        CommandMenu("Fleet") {
            Button("Check Now") { Task { await store.refreshNow() } }
                .keyboardShortcut("r")
                .disabled(!store.connection.isConnected)
            Divider()
            Button("Overview") { store.open(.overview) }.keyboardShortcut("1")
            Button("Work") { store.open(.work) }.keyboardShortcut("2")
            Button("Projects") { store.open(.projects) }.keyboardShortcut("3")
        }
        CommandGroup(replacing: .help) {
            Button("The Fleet Help") { openWindow(id: FleetWindowID.help) }
                .keyboardShortcut("?", modifiers: .command)
        }
    }
}

public enum FleetWindowID {
    public static let main = "main"
    public static let help = "help"
}
