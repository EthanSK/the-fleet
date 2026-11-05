// App settings: the shared service's status and where The Fleet lives.
// Connection preferences belong to this app; the results folder is shared by
// every client through the controller API. Agent Bridge owns SSH details.

import SwiftUI
import AppKit
import FleetKit

public struct FleetSettingsView: View {
    @Bindable var store: FleetStore
    private let updater: FleetAppUpdater?

    public init(store: FleetStore, updater: FleetAppUpdater? = nil) {
        self.store = store
        self.updater = updater
    }

    public var body: some View {
        TabView {
            ServiceSettings(store: store)
                .tabItem { Label("Service", systemImage: "antenna.radiowaves.left.and.right") }
            LocationSettings(store: store, preferences: store.preferences)
                .tabItem { Label("Locations", systemImage: "folder") }
            if let updater {
                AppUpdateSettings(updater: updater)
                    .tabItem { Label("Updates", systemImage: "arrow.down.circle") }
            }
        }
        .frame(width: 600, height: 590)
    }
}

struct AppUpdateSettings: View {
    @ObservedObject var updater: FleetAppUpdater
    @Environment(\.fleetInlineScroll) private var inline

    var body: some View {
        Group {
            if inline { VStack(alignment: .leading, spacing: 16) { fields }.padding() }
            else { Form { fields }.formStyle(.grouped) }
        }
    }

    @ViewBuilder private var fields: some View {
            Section("App Updates") {
                Toggle("Check for updates automatically", isOn: Binding(
                    get: { updater.automaticChecks }, set: { updater.automaticChecks = $0 }))
                Toggle("Download updates automatically", isOn: Binding(
                    get: { updater.automaticDownloads }, set: { updater.automaticDownloads = $0 }))
                    .disabled(!updater.automaticChecks)
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheck)
            }
            Text("Updates restart this app. The service and its jobs keep running.")
                .font(.caption).foregroundStyle(.secondary)
    }
}

struct ServiceSettings: View {
    let store: FleetStore

    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("Service") {
                    HStack(spacing: 6) {
                        StatusLamp(color: store.connection.isConnected ? FleetPalette.cleared : FleetPalette.stop, size: 7)
                        Text(statusText)
                    }
                }
                if let health = store.connection.health {
                    LabeledContent("Version", value: health.version ?? "Older than this app")
                    LabeledContent("Process", value: String(health.pid))
                    if let started = FleetDate.parse(health.startedAt) {
                        LabeledContent("Started", value: FleetFormat.ago(started, now: store.now))
                    }
                } else if store.locations.core != nil {
                    HStack {
                        Button("Start The Fleet") { Task { await store.startService() } }.disabled(store.isStartingService)
                        if store.isStartingService { ProgressView().controlSize(.small) }
                    }
                    if let error = store.serviceStartError { Text(error).font(.caption).foregroundStyle(FleetPalette.stop).textSelection(.enabled) }
                }
                LabeledContent("Socket") { Text(FleetFormat.path(store.locations.socketPath)).font(.data(11)).textSelection(.enabled) }
                LabeledContent("Log") { Text(FleetFormat.path(store.locations.serviceLog)).font(.data(11)).textSelection(.enabled) }
            }
            Section {
                if let agent = store.locations.launchAgent {
                    LabeledContent("Login service", value: "Installed")
                    LabeledContent("Configuration") { Text(FleetFormat.path(agent.plistPath)).font(.data(11)).textSelection(.enabled) }
                } else {
                    LabeledContent("Login service", value: "Not installed")
                    Text("Install the login service from Terminal, then load it with the command it prints:").font(.callout)
                    CommandBlock(command: "the-fleet service install")
                }
            } header: {
                Text("Login")
            } footer: {
                Text("Quitting this app leaves the service and its jobs running. Every app, agent and the command line share this one service.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private var statusText: String {
        switch store.connection {
        case .connected: return store.serviceNeedsUpdate ? "Running an older version" : "Running"
        case .connecting: return "Connecting…"
        case .notRunning: return "Not running"
        case .failed(let message): return message
        }
    }
}

struct LocationSettings: View {
    let store: FleetStore
    @Bindable var preferences: FleetPreferences
    @Environment(\.fleetInlineScroll) private var inline

    var body: some View {
        Group {
            // ImageRenderer cannot draw AppKit-backed forms. The same fields
            // are laid out inline by the existing headless rendering mode.
            if inline { VStack(alignment: .leading, spacing: 16) { fields }.padding() }
            else { Form { fields }.formStyle(.grouped) }
        }
        .onChange(of: preferences.fleetHome) { _, _ in store.applyLocations() }
        .onChange(of: preferences.scriptPath) { _, _ in store.applyLocations() }
        .onChange(of: preferences.nodePath) { _, _ in store.applyLocations() }
    }

    @ViewBuilder private var fields: some View {
            ResultsFolderSettings(store: store)
            Section {
                PathField(title: "Fleet folder", text: $preferences.fleetHome, placeholder: FleetFormat.path(store.locations.home), choosesDirectories: true)
                Text(store.locations.homeSource.title).font(.caption).foregroundStyle(.secondary)
            } header: {
                Text("State")
            } footer: {
                Text("Ship settings, registrations, reservations and run history live here. Use the same folder as the service and your other apps.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                PathField(title: "The Fleet command", text: $preferences.scriptPath, placeholder: store.locations.core.map { FleetFormat.path($0.scriptPath) } ?? "bin/the-fleet.js", choosesDirectories: false)
                PathField(title: "Node", text: $preferences.nodePath, placeholder: store.locations.core.map { FleetFormat.path($0.nodePath) } ?? "node", choosesDirectories: false)
                if let core = store.locations.core {
                    Text("Found \(core.version.map { "version \($0)" } ?? "it") · \(core.source)").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Not found. Install The Fleet with npm ci && npm link in its source folder, or choose its bin/the-fleet.js.")
                        .font(.caption).foregroundStyle(FleetPalette.hold)
                }
                Button("Find again") { store.applyLocations() }
            } header: {
                Text("Starting the Service")
            } footer: {
                Text("Used only to start the shared service when it isn't running. Needs Node 22.18 or newer, Python 3 and SSH.")
                    .font(.caption).foregroundStyle(.secondary)
            }
    }
}

struct PathField: View {
    let title: String
    @Binding var text: String
    let placeholder: String
    let choosesDirectories: Bool
    var resetHelp = "Use the found location"

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                TextField("", text: $text, prompt: Text(placeholder))
                    .font(.data(11))
                    .textFieldStyle(.roundedBorder)
                Button("Choose…") { choose() }
                if !text.isEmpty {
                    Button { text = "" } label: { Image(systemName: "arrow.uturn.backward") }
                        .buttonStyle(.borderless)
                        .help(resetHelp)
                }
            }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = choosesDirectories
        panel.canChooseFiles = !choosesDirectories
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { text = url.path }
    }
}

/// A draft stays local until the revision-checked shared setting is saved.
struct ResultsFolderSettings: View {
    let store: FleetStore
    @State private var baseline: FleetConfiguration.Controller?
    @State private var folder = ""
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false
    @State private var confirmRestore = false

    init(store: FleetStore) {
        self.store = store
        _baseline = State(initialValue: store.configuration?.controller)
        _folder = State(initialValue: store.configuration?.controller?.runsDirectory ?? "")
    }

    private var dirty: Bool { folder != (baseline?.runsDirectory ?? "") }
    private var changedElsewhere: Bool { dirty && baseline?.revision != store.configuration?.controller?.revision }

    var body: some View {
        Section {
            if baseline != nil {
                PathField(title: "Folder", text: $folder,
                          placeholder: store.configuration.map { FleetFormat.path($0.paths.runsDirectory) } ?? "",
                          choosesDirectories: true, resetHelp: "Use the default folder")
                    .disabled(saving)
                if let path = store.configuration?.paths.runsDirectory {
                    LabeledContent("In use") { Text(FleetFormat.path(path)).font(.data(11)).textSelection(.enabled) }
                }
                HStack {
                    Button("Save") { Task { await save() } }
                        .disabled(!dirty || saving)
                    if saving { ProgressView().controlSize(.small) }
                    if saved { Label("Saved", systemImage: "checkmark").foregroundStyle(FleetPalette.cleared) }
                    Spacer()
                    if changedElsewhere {
                        Button("Restore server values") { confirmRestore = true }
                    }
                }
                if changedElsewhere {
                    Text("These settings changed somewhere else.").font(.caption).foregroundStyle(FleetPalette.hold)
                }
                if let error { Text(error).font(.caption).foregroundStyle(FleetPalette.stop).textSelection(.enabled) }
            } else {
                Text(store.connection.isConnected ? "Update The Fleet service to change this folder." : "Connect to The Fleet to change this folder.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        } header: {
            Text("Results")
        } footer: {
            Text("Default folder for returned files from all apps. Choose an existing folder ending in .noindex. A run or service setting can override this default. Existing results stay in their current folders.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { restore() }
        .onChange(of: store.configuration?.controller) { _, _ in if !dirty && !saving { restore() } }
        .onChange(of: store.locations.home) { _, _ in restore() }
        .onChange(of: folder) { _, _ in if dirty { saved = false }; error = nil }
        .confirmationDialog("Discard changes?", isPresented: $confirmRestore) {
            Button("Discard", role: .destructive) { restore() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func restore() {
        baseline = store.configuration?.controller
        folder = baseline?.runsDirectory ?? ""
        error = nil
        saved = false
    }

    private func save() async {
        guard let baseline else { return }
        saving = true
        defer { saving = false }
        do {
            let result = try await store.saveControllerSettings(revision: baseline.revision, runsDirectory: folder.isEmpty ? nil : folder)
            self.baseline = result.controller
            folder = result.controller?.runsDirectory ?? ""
            error = nil
            saved = true
        } catch is CancellationError {
            restore()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
