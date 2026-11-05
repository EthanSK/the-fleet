// Window structure: a sidebar of fleet sections and workers, and a detail area
// that shows the service's own state when it isn't reachable.

import SwiftUI
import FleetKit

public struct FleetRootView: View {
    @Bindable var store: FleetStore
    @Environment(\.scenePhase) private var scenePhase

    public init(store: FleetStore) {
        self.store = store
    }

    public var body: some View {
        NavigationSplitView {
            FleetSidebar(store: store)
                .navigationSplitViewColumnWidth(min: 200, ideal: 228, max: 320)
        } detail: {
            VStack(spacing: 0) {
                if let notice = store.notice { NoticeBanner(notice: notice) { store.notice = nil } }
                if store.serviceNeedsUpdate, store.connection.isConnected { OutdatedServiceBanner() }
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(item: $store.sheet) { sheet in
            switch sheet {
            case .addWorker: AddWorkerSheet(store: store)
            case .editWorker(let id): WorkerSettingsSheet(store: store, workerID: id)
            case .runProfile(let project, let profile): RunProfileSheet(store: store, projectID: project, profileName: profile)
            }
        }
        .onAppear {
            store.windowVisible = true
            store.start()
        }
        // A closed window removes this view without a scene-phase change, so
        // polling would otherwise continue at the visible cadence.
        .onDisappear { store.windowVisible = false }
        .onChange(of: scenePhase, initial: true) { _, phase in
            store.windowVisible = phase != .background
        }
    }

    @ViewBuilder private var detail: some View {
        switch store.connection {
        case .connecting:
            ProgressView("Connecting to The Fleet…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notRunning:
            ServiceDownView(store: store, problem: nil)
        case .failed(let message):
            ServiceDownView(store: store, problem: message)
        case .connected:
            switch store.selection ?? .overview {
            case .overview:
                NavigationStack(path: $store.overviewPath) { OverviewView(store: store).fleetDestinations(store) }
            case .work:
                NavigationStack(path: $store.workPath) { WorkView(store: store).fleetDestinations(store) }
            case .projects:
                NavigationStack(path: $store.projectsPath) { ProjectsView(store: store).fleetDestinations(store) }
            case .worker(let id):
                NavigationStack(path: $store.workerPath) { WorkerDetailView(store: store, workerID: id).fleetDestinations(store) }
                    .id(id)
            }
        }
    }
}

extension View {
    func fleetDestinations(_ store: FleetStore) -> some View {
        navigationDestination(for: FleetRoute.self) { route in
            switch route {
            case .worker(let id): WorkerDetailView(store: store, workerID: id)
            case .operation(let id): OperationDetailView(store: store, operationID: id)
            case .run(let jobID): RunDetailView(store: store, jobID: jobID)
            }
        }
    }
}

struct FleetSidebar: View {
    @Bindable var store: FleetStore

    var body: some View {
        List(selection: $store.selection) {
            Section("Fleet") {
                Label("Overview", systemImage: "square.grid.2x2").tag(SidebarItem.overview)
                Label("Work", systemImage: "list.bullet.rectangle.portrait")
                    .badge(store.runningWork.count)
                    .tag(SidebarItem.work)
                Label("Projects", systemImage: "shippingbox").tag(SidebarItem.projects)
            }
            Section {
                ForEach(store.workers) { worker in
                    WorkerSidebarRow(worker: worker).tag(SidebarItem.worker(worker.id))
                }
                if store.workers.isEmpty, store.connection.isConnected {
                    Text("No ships yet").foregroundStyle(.secondary)
                }
            } header: {
                HStack {
                    Text("Ships")
                    Spacer()
                    Button {
                        store.sheet = .addWorker
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                    .help("Add ship")
                    .accessibilityLabel("Add ship")
                    .disabled(!store.connection.isConnected || store.serviceNeedsUpdate)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) { ServiceFooter(store: store) }
    }
}

struct WorkerSidebarRow: View {
    let worker: WorkerItem

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: worker.kind.symbolName)
                .symbolRenderingMode(.hierarchical)
                .frame(width: 20)
            Text(worker.id)
                .lineLimit(1)
            if worker.isDefault {
                Image(systemName: "star.fill").font(.system(size: 8)).foregroundStyle(.secondary).help("Default ship")
            }
            Spacer(minLength: 4)
            StatusLamp(color: FleetPalette.color(for: worker.status.condition), size: 7, pulsing: worker.status.condition == .running)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(worker.id), \(worker.status.condition.title)\(worker.isDefault ? ", default ship" : "")")
    }
}

struct ServiceFooter: View {
    let store: FleetStore

    var body: some View {
        SettingsLink {
            HStack(spacing: 7) {
                StatusLamp(color: color, size: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.caption.weight(.medium))
                    if let version = store.connection.health?.version {
                        Text("Service \(version)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Image(systemName: "gearshape").foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .help("The Fleet settings")
    }

    private var title: String {
        switch store.connection {
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .notRunning: return "Not running"
        case .failed: return "Can't connect"
        }
    }

    private var color: Color {
        switch store.connection {
        case .connected: return store.serviceNeedsUpdate ? FleetPalette.hold : FleetPalette.cleared
        case .connecting: return FleetPalette.idle
        case .notRunning, .failed: return FleetPalette.stop
        }
    }
}

struct ServiceDownView: View {
    let store: FleetStore
    let problem: String?

    var body: some View {
        FleetScroll {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "antenna.radiowaves.left.and.right.slash")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.secondary)
                Text(problem == nil ? "The Fleet isn't running" : "Can't reach The Fleet")
                    .font(.nameplate(24))
                Text(problem ?? "Start the shared service to see your ships and their work.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let core = store.locations.core {
                    HStack(spacing: 12) {
                        Button {
                            Task { await store.startService() }
                        } label: {
                            Text("Start The Fleet").frame(minWidth: 120)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(store.isStartingService)
                        if store.isStartingService { ProgressView().controlSize(.small) }
                    }
                    Text("Uses \(FleetFormat.path(core.scriptPath))\(core.version.map { " (\($0))" } ?? "").")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        NoticeLine(text: "The Fleet's command wasn't found. Install it from its source folder:")
                        CommandBlock(command: "npm ci && npm link")
                        Text("Or choose its location in Settings.").font(.callout).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: 520, alignment: .leading)
                }
                if let error = store.serviceStartError {
                    NoticeLine(text: error, symbol: "xmark.octagon.fill", tint: FleetPalette.stop)
                        .textSelection(.enabled)
                        .frame(maxWidth: 560, alignment: .leading)
                }
                SettingsLink { Text("Settings…") }
                Divider().frame(maxWidth: 520)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Every app, agent and the command line share this one service. Quitting this app never stops it or its jobs.")
                    Text("Folder: \(FleetFormat.path(store.locations.home))").font(.data(11)).textSelection(.enabled)
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 520, alignment: .leading)
            }
            .padding(40)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct OutdatedServiceBanner: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(FleetPalette.hold)
            VStack(alignment: .leading, spacing: 6) {
                Text("The running service is older than this app. Restart it to show ship settings, projects and run history.")
                    .fixedSize(horizontal: false, vertical: true)
                Text("Stop it once its jobs finish; the login service or this app starts the current version.")
                    .font(.caption).foregroundStyle(.secondary)
                CommandBlock(command: "the-fleet service stop").frame(maxWidth: 360)
            }
            Spacer()
        }
        .font(.callout)
        .padding(12)
        .background(FleetPalette.hold.opacity(0.10))
    }
}

struct NoticeBanner: View {
    let notice: FleetNotice
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(FleetPalette.cleared)
            VStack(alignment: .leading, spacing: 4) {
                Text(notice.text)
                ForEach(notice.details, id: \.self) { detail in
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Dismiss", action: dismiss).buttonStyle(.borderless)
        }
        .font(.callout)
        .padding(12)
        .background(.bar)
        .task(id: notice.id) {
            try? await Task.sleep(nanoseconds: notice.details.isEmpty ? 6_000_000_000 : 14_000_000_000)
            dismiss()
        }
    }
}
