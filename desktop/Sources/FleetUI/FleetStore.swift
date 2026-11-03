// The app's single source of UI state, fed only by the shared coordinator.
//
// Each feed (health, state, operations, settings, projects, runs, pairings)
// polls on its own cadence: brisk while the app is in front, slower behind
// other apps, paused when no window is visible, and only health while the
// service is down. Nothing here runs jobs or writes settings files; actions are
// requests to the service, which applies its own admission and revision rules.
// Quitting the app just stops polling: no job is cancelled on the way out.

import SwiftUI
import AppKit
import Observation
import FleetKit

public enum ServiceConnection: Equatable {
    case connecting
    case connected(ServiceHealth)
    case notRunning
    case failed(String)

    public var health: ServiceHealth? {
        if case .connected(let health) = self { return health }
        return nil
    }

    public var isConnected: Bool { health != nil }
}

public enum SidebarItem: Hashable {
    case overview, work, projects
    case worker(String)
}

public enum FleetRoute: Hashable {
    case worker(String)
    case operation(String)
    case run(String)
}

public enum FleetSheet: Identifiable, Equatable {
    case addWorker
    case editWorker(String)
    case runProfile(project: String, profile: String)

    public var id: String {
        switch self {
        case .addWorker: return "add"
        case .editWorker(let id): return "edit-\(id)"
        case .runProfile(let project, let profile): return "run-\(project)-\(profile)"
        }
    }
}

public struct FleetNotice: Identifiable, Equatable {
    public let id = UUID()
    public let text: String
    public var details: [String] = []
}

/// A registered worker merged with the coordinator's latest observation of it.
public struct WorkerItem: Identifiable, Equatable {
    public let id: String
    public let settings: WorkerSettings?
    public let observation: WorkerObservation?
    public let status: WorkerStatus
    public let kind: DeviceKind
    public let isDefault: Bool

    public var health: WorkerHealth? { observation?.health }

    public var systemName: String? {
        guard let health else { return nil }
        if health.os == "Darwin" { return health.osVersion.map { "macOS \($0)" } ?? "macOS" }
        return health.osVersion ?? health.os
    }

    /// The description if one is set, otherwise the chip and system.
    public var subtitle: String {
        if let description = settings?.description ?? observation?.description, !description.isEmpty { return description }
        let parts = [health?.cpuBrand, systemName].compactMap { $0 }
        return parts.isEmpty ? kind.title : parts.joined(separator: " · ")
    }

    public var observedAt: Date? { FleetDate.parse(observation?.observedAt) }
}

/// A finished entry in Work: a durable receipt, or an operation that ended before producing one.
public enum FinishedWork: Identifiable, Equatable {
    case run(RunSummary)
    case operation(OperationSummary)

    public var id: String {
        switch self {
        case .run(let run): return "run-\(run.jobId)"
        case .operation(let operation): return "op-\(operation.id)"
        }
    }

    public var finishedAt: Date? {
        switch self {
        case .run(let run): return FleetDate.parse(run.finishedAt)
        case .operation(let operation): return FleetDate.parse(operation.finishedAt)
        }
    }

    var searchText: String {
        switch self {
        case .run(let run): return [run.project, run.profile, run.machineId ?? "", run.outcome, run.summary, run.owner ?? ""].joined(separator: " ").lowercased()
        case .operation(let operation): return [operation.label, operation.owner, operation.lastLine ?? ""].joined(separator: " ").lowercased()
        }
    }
}

@MainActor
@Observable
public final class FleetPreferences {
    @ObservationIgnored private let defaults: UserDefaults
    private enum Key {
        static let home = "fleetHome", node = "nodePath", script = "cliScriptPath", kinds = "deviceKinds"
    }

    /// Empty means discover it.
    public var fleetHome: String { didSet { defaults.set(fleetHome, forKey: Key.home) } }
    public var nodePath: String { didSet { defaults.set(nodePath, forKey: Key.node) } }
    public var scriptPath: String { didSet { defaults.set(scriptPath, forKey: Key.script) } }
    /// Per-worker icon choices; presentation only, never sent to the service.
    public var deviceKinds: [String: String] { didSet { defaults.set(deviceKinds, forKey: Key.kinds) } }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        fleetHome = defaults.string(forKey: Key.home) ?? ""
        nodePath = defaults.string(forKey: Key.node) ?? ""
        scriptPath = defaults.string(forKey: Key.script) ?? ""
        deviceKinds = defaults.dictionary(forKey: Key.kinds) as? [String: String] ?? [:]
    }
}

@MainActor
@Observable
public final class FleetStore {
    public static let appOwner = "The Fleet app"

    public enum Activity: Equatable { case active, inactive, hidden }

    enum Feed: CaseIterable, Hashable { case health, state, operations, configuration, projects, runs, pairings }

    public let preferences: FleetPreferences
    public private(set) var locations: FleetLocations
    public private(set) var client: any FleetAPI

    // Connection
    public private(set) var connection: ServiceConnection = .connecting
    /// The running service predates the structured routes this app uses.
    public private(set) var serviceNeedsUpdate = false
    public private(set) var isStartingService = false
    public private(set) var serviceStartError: String?

    // Data from the service
    public private(set) var state: FleetState?
    public private(set) var stateError: String?
    public private(set) var isRefreshing = false
    public private(set) var configuration: FleetConfiguration?
    public private(set) var configurationError: String?
    public private(set) var pairings: PairingList?
    public private(set) var pairingsError: String?
    public private(set) var projects: ProjectList?
    public private(set) var projectsError: String?
    public private(set) var operations: [OperationSummary] = []
    public private(set) var runs: RunList?
    public private(set) var runsError: String?
    /// Advances every second for elapsed times and freshness.
    public private(set) var now = Date()

    // Navigation
    public var selection: SidebarItem? = .overview
    public var overviewPath: [FleetRoute] = []
    public var workPath: [FleetRoute] = []
    public var projectsPath: [FleetRoute] = []
    public var workerPath: [FleetRoute] = []
    public var sheet: FleetSheet?
    public var notice: FleetNotice?

    // Visibility drives polling cadence.
    public var windowVisible = true
    public var appActive = true
    public var workVisible = false
    public var pairingsWanted = false {
        didSet { if pairingsWanted { lastFetched[.pairings] = nil } }
    }

    @ObservationIgnored private let discovery: FleetDiscovery
    @ObservationIgnored private let makeClient: @Sendable (String) -> any FleetAPI
    @ObservationIgnored private let launcher: @Sendable (CoreInstallation, String) async throws -> String
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var lastFetched: [Feed: Date] = [:]
    @ObservationIgnored private var inFlight: Set<Feed> = []
    @ObservationIgnored private var healthFailures = 0
    /// A response belongs to the connection that requested it, even when its
    /// socket read cannot be cancelled during a settings change.
    @ObservationIgnored private var connectionVersion = 0
    @ObservationIgnored private var activationObservers: [NSObjectProtocol] = []

    public init(preferences: FleetPreferences,
                discovery: FleetDiscovery = FleetDiscovery(),
                makeClient: @escaping @Sendable (String) -> any FleetAPI = { LiveFleetClient(socketPath: $0) },
                launcher: @escaping @Sendable (CoreInstallation, String) async throws -> String = { try await ServiceLauncher.start(core: $0, home: $1) }) {
        self.preferences = preferences
        self.discovery = discovery
        self.makeClient = makeClient
        self.launcher = launcher
        let locations = discovery.locations(homeOverride: preferences.fleetHome, nodeOverride: preferences.nodePath, scriptOverride: preferences.scriptPath)
        self.locations = locations
        self.client = makeClient(locations.socketPath)
    }

    public static func live() -> FleetStore {
        FleetStore(preferences: FleetPreferences())
    }

    // MARK: - Polling

    public var activity: Activity {
        !windowVisible ? .hidden : appActive ? .active : .inactive
    }

    public func start() {
        guard loop == nil else { return }
        appActive = NSApp?.isActive ?? true
        let center = NotificationCenter.default
        activationObservers = [
            center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.appActive = true }
            },
            center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.appActive = false }
            },
        ]
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.tick()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
        activationObservers.forEach(NotificationCenter.default.removeObserver)
        activationObservers = []
    }

    /// Seconds between fetches of a feed, or nil when it should not poll now.
    static func pollInterval(_ feed: Feed, activity: Activity, connected: Bool, healthFailures: Int,
                             hasRunningWork: Bool, workVisible: Bool, pairingsWanted: Bool) -> TimeInterval? {
        guard connected else {
            guard feed == .health else { return nil }
            return activity == .hidden ? 30 : min(10, 2 + Double(healthFailures) * 2)
        }
        let slow = activity == .inactive
        switch (activity, feed) {
        case (.hidden, .health): return 30
        case (.hidden, _): return nil
        case (_, .health): return slow ? 60 : 15
        case (_, .state): return slow ? 30 : 10
        case (_, .operations): return hasRunningWork || workVisible ? (slow ? 6 : 2) : (slow ? 20 : 6)
        case (_, .configuration): return slow ? 60 : 20
        case (_, .projects): return slow ? 300 : 60
        case (_, .runs): return slow ? 90 : 20
        case (_, .pairings): return pairingsWanted ? 30 : nil
        }
    }

    func tick() {
        now = Date()
        for feed in Feed.allCases {
            guard !inFlight.contains(feed),
                  let interval = Self.pollInterval(feed, activity: activity, connected: connection.isConnected, healthFailures: healthFailures,
                                                   hasRunningWork: !runningWork.isEmpty, workVisible: workVisible, pairingsWanted: pairingsWanted)
            else { continue }
            if let last = lastFetched[feed], now.timeIntervalSince(last) < interval { continue }
            inFlight.insert(feed)
            lastFetched[feed] = now
            let version = connectionVersion
            Task { [weak self] in
                guard self?.connectionVersion == version else { return }
                await self?.fetch(feed)
                if self?.connectionVersion == version { self?.inFlight.remove(feed) }
            }
        }
    }

    func fetch(_ feed: Feed) async {
        let version = connectionVersion
        do {
            switch feed {
            case .health: await refreshHealth()
            case .state: try await loadState(fresh: false)
            case .operations: try await loadOperations()
            case .configuration: try await loadConfiguration()
            case .projects: try await loadProjects()
            case .runs: try await loadRuns()
            case .pairings: try await loadPairings()
            }
        } catch {
            if version == connectionVersion { record(error, for: feed) }
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func record(_ error: Error, for feed: Feed) {
        if let api = error as? FleetAPIError {
            if api == .serviceNotRunning { markNotRunning(); return }
            if api == .serviceOutdated { serviceNeedsUpdate = true; return }
        }
        let text = message(error)
        switch feed {
        case .state: stateError = text
        case .configuration: configurationError = text
        case .projects: projectsError = text
        case .runs: runsError = text
        case .pairings: pairingsError = text
        case .operations, .health: break
        }
    }

    private func markNotRunning() {
        if connection != .notRunning { connection = .notRunning }
    }

    func refreshHealth() async {
        let version = connectionVersion
        do {
            let health = try await client.health()
            guard version == connectionVersion else { return }
            guard health.application == "The Fleet", health.protocolVersion == 1 else {
                connection = .failed("Another program owns The Fleet's socket at \(locations.socketPath).")
                return
            }
            healthFailures = 0
            let previous = connection.health
            connection = .connected(health)
            serviceNeedsUpdate = health.version == nil
            if previous?.pid != health.pid {
                // A new or restarted service: load everything now.
                lastFetched = [.health: Date()]
            }
        } catch FleetAPIError.serviceNotRunning {
            guard version == connectionVersion else { return }
            healthFailures += 1
            markNotRunning()
        } catch {
            guard version == connectionVersion else { return }
            healthFailures += 1
            connection = .failed(message(error))
        }
    }

    func loadState(fresh: Bool) async throws {
        let version = connectionVersion
        let result = try await client.state(fresh: fresh)
        guard version == connectionVersion else { return }
        state = result
        stateError = nil
    }

    func loadOperations() async throws {
        let version = connectionVersion
        let list = try await client.operations()
        guard version == connectionVersion else { return }
        let wasRunning = Set(operations.filter(\.isRunning).map(\.id))
        operations = list
        if list.contains(where: { wasRunning.contains($0.id) && !$0.isRunning }) {
            // Work just finished: its receipt and the worker's lock changed.
            lastFetched[.runs] = nil
            lastFetched[.state] = nil
        }
    }

    func loadConfiguration() async throws {
        let version = connectionVersion
        let result = try await client.configuration()
        guard version == connectionVersion else { return }
        configuration = result
        configurationError = nil
    }

    func loadProjects() async throws {
        let version = connectionVersion
        let result = try await client.projects()
        guard version == connectionVersion else { return }
        projects = result
        projectsError = nil
    }

    func loadRuns() async throws {
        let version = connectionVersion
        let result = try await client.runs(limit: 150)
        guard version == connectionVersion else { return }
        runs = result
        runsError = nil
    }

    func loadPairings() async throws {
        let version = connectionVersion
        let result = try await client.pairings()
        guard version == connectionVersion else { return }
        pairings = result
        pairingsError = nil
    }

    /// Checks every worker now and reloads everything else.
    public func refreshNow() async {
        guard !isRefreshing else { return }
        let version = connectionVersion
        isRefreshing = true
        defer { if version == connectionVersion { isRefreshing = false } }
        await refreshHealth()
        guard version == connectionVersion, connection.isConnected else { return }
        do { try await loadState(fresh: true) } catch { if version == connectionVersion { record(error, for: .state) } }
        guard version == connectionVersion else { return }
        lastFetched[.state] = Date()
        for feed in [Feed.operations, .configuration, .runs, .projects] {
            await fetch(feed)
            guard version == connectionVersion else { return }
            lastFetched[feed] = Date()
        }
        if pairingsWanted { await fetch(.pairings) }
    }

    // MARK: - Derived data

    public var workers: [WorkerItem] {
        let observations = state?.workers ?? []
        let reservations = state?.reservations ?? []
        let settings = configuration?.machines
        var ids = settings?.map(\.id) ?? observations.map(\.id)
        for observation in observations where !ids.contains(observation.id) { ids.append(observation.id) }
        let items = ids.map { id -> WorkerItem in
            let setting = settings?.first { $0.id == id }
            let observation = observations.first { $0.id == id }
            return WorkerItem(id: id, settings: setting, observation: observation,
                              status: WorkerStatus.derive(observation, reservations: reservations, operations: operations),
                              kind: deviceKind(id: id, settings: setting, observation: observation),
                              isDefault: setting?.isDefault ?? (configuration?.defaultMachine == id))
        }
        // Default first, then registry order: the order unpinned runs try them.
        return items.filter(\.isDefault) + items.filter { !$0.isDefault }
    }

    public func worker(_ id: String) -> WorkerItem? {
        workers.first { $0.id == id }
    }

    public func automaticDeviceKind(id: String) -> DeviceKind {
        let setting = configuration?.machines.first { $0.id == id }
        let observation = state?.workers.first { $0.id == id }
        return DeviceKind.classify(model: observation?.health?.model, os: observation?.health?.os, names: names(id: id, settings: setting, observation: observation))
    }

    private func names(id: String, settings: WorkerSettings?, observation: WorkerObservation?) -> [String] {
        ([id, settings?.target, settings?.description, observation?.health?.host].compactMap { $0 }) + (settings?.aliases ?? [])
    }

    func deviceKind(id: String, settings: WorkerSettings?, observation: WorkerObservation?) -> DeviceKind {
        if let raw = preferences.deviceKinds[id], let chosen = DeviceKind(rawValue: raw) { return chosen }
        return DeviceKind.classify(model: observation?.health?.model, os: observation?.health?.os, names: names(id: id, settings: settings, observation: observation))
    }

    public var runningWork: [OperationSummary] {
        operations.filter { $0.isWork && $0.isRunning }
    }

    public var finishedWork: [FinishedWork] {
        let receipts = (runs?.runs ?? []).map(FinishedWork.run)
        // Work that ended before admission (for example no available worker) has no receipt.
        let receiptless = operations.filter { $0.isWork && !$0.isRunning && $0.jobIds.isEmpty }.map(FinishedWork.operation)
        return (receipts + receiptless).sorted { ($0.finishedAt ?? .distantPast) > ($1.finishedAt ?? .distantPast) }
    }

    public var stateObservedAt: Date? { FleetDate.parse(state?.observedAt) }

    public func operation(_ id: String) -> OperationSummary? {
        operations.first { $0.id == id }
    }

    public func run(forJob jobID: String) -> RunSummary? {
        runs?.runs.first { $0.jobId == jobID }
    }

    // MARK: - Actions

    public func open(_ item: SidebarItem) {
        selection = item
    }

    public func startService() async {
        guard !isStartingService else { return }
        let version = connectionVersion
        serviceStartError = nil
        guard let core = locations.core else {
            serviceStartError = "The Fleet's command wasn't found. Install The Fleet, or set its location in Settings."
            return
        }
        isStartingService = true
        defer { if version == connectionVersion { isStartingService = false } }
        do {
            _ = try await launcher(core, locations.home)
            guard version == connectionVersion else { return }
            healthFailures = 0
            await refreshHealth()
        } catch {
            if version == connectionVersion { serviceStartError = message(error) }
        }
    }

    /// Re-reads where The Fleet lives after a Settings change; reconnects if the socket moved.
    public func applyLocations() {
        let next = discovery.locations(homeOverride: preferences.fleetHome, nodeOverride: preferences.nodePath, scriptOverride: preferences.scriptPath)
        let moved = next.socketPath != locations.socketPath
        locations = next
        guard moved else { return }
        connectionVersion &+= 1
        client = makeClient(next.socketPath)
        connection = .connecting
        state = nil; configuration = nil; projects = nil; runs = nil; pairings = nil; operations = []
        stateError = nil; configurationError = nil; projectsError = nil; runsError = nil; pairingsError = nil
        serviceNeedsUpdate = false; serviceStartError = nil; isStartingService = false; isRefreshing = false
        selection = .overview
        overviewPath = []; workPath = []; projectsPath = []; workerPath = []; sheet = nil; notice = nil
        healthFailures = 0
        lastFetched = [:]
        inFlight = []
    }

    private func afterSettingsChange() async {
        let version = connectionVersion
        do { try await loadConfiguration() } catch { if version == connectionVersion { record(error, for: .configuration) } }
        guard version == connectionVersion else { return }
        do { try await loadState(fresh: false) } catch { if version == connectionVersion { record(error, for: .state) } }
        guard version == connectionVersion else { return }
        lastFetched[.pairings] = nil
    }

    public func addWorker(_ body: [String: JSONValue]) async throws -> WorkerChange {
        let version = connectionVersion
        let change = try await client.addWorker(body)
        guard version == connectionVersion else { throw CancellationError() }
        await afterSettingsChange()
        guard version == connectionVersion else { throw CancellationError() }
        return change
    }

    public func updateWorker(id: String, _ body: [String: JSONValue]) async throws -> WorkerChange {
        let version = connectionVersion
        let change = try await client.updateWorker(id: id, body)
        guard version == connectionVersion else { throw CancellationError() }
        await afterSettingsChange()
        guard version == connectionVersion else { throw CancellationError() }
        return change
    }

    public func removeWorker(id: String, revision: String) async throws -> WorkerRemoval {
        let version = connectionVersion
        let removal = try await client.removeWorker(id: id, revision: revision)
        guard version == connectionVersion else { throw CancellationError() }
        if selection == .worker(id) { selection = .overview }
        preferences.deviceKinds[id] = nil
        notice = FleetNotice(text: "Removed \(id). Its pairing, remote folder and run history are unchanged.", details: removal.warnings)
        await afterSettingsChange()
        guard version == connectionVersion else { throw CancellationError() }
        return removal
    }

    public func reloadConfiguration() async {
        await fetch(.configuration)
    }

    /// Save the shared preference, retaining stale-connection protection.
    public func saveControllerSettings(revision: String, runsDirectory: String?) async throws -> FleetConfiguration {
        let version = connectionVersion
        let saved = try await client.updateControllerSettings([
            "revision": .string(revision),
            "runsDirectory": runsDirectory.map(JSONValue.string) ?? .null
        ])
        guard version == connectionVersion else { throw CancellationError() }
        configuration = saved
        configurationError = nil
        lastFetched[.configuration] = Date()
        lastFetched[.runs] = nil
        return saved
    }

    public func reloadPairings() async {
        await fetch(.pairings)
    }

    public func checkPairing(target: String, remoteRoot: String?, workerID: String?) async throws -> PairingCheck {
        try await client.checkPairing(target: target, remoteRoot: remoteRoot, workerID: workerID)
    }

    public func plan(project: String, profile: String, worker: String?) async throws -> RunPlan {
        try await client.plan(project: project, profile: profile, worker: worker)
    }

    /// Starts a saved profile as detached work and opens its live output.
    @discardableResult
    public func startRun(project: String, profile: String, placement: RunPlacement) async throws -> String {
        let version = connectionVersion
        let started = try await client.startRun(project: project, profile: profile, placement: placement, owner: Self.appOwner)
        guard version == connectionVersion else { throw CancellationError() }
        if let operation = started.operation, !operations.contains(where: { $0.id == operation.id }) {
            operations.insert(operation, at: 0)
        }
        selection = .work
        workPath = [.operation(started.operationId)]
        lastFetched[.operations] = nil
        return started.operationId
    }

    public func cancel(operationID: String) async throws {
        try await client.cancel(operationID: operationID)
        lastFetched[.operations] = nil
        lastFetched[.state] = nil
    }

    public func recoverManagedReservations(workerID: String) async throws -> [String] {
        let version = connectionVersion
        let released = try await client.recoverManagedReservations(workerID: workerID)
        guard version == connectionVersion else { throw CancellationError() }
        do { try await loadState(fresh: false) } catch { record(error, for: .state) }
        return released
    }
}

/// Live output of one operation, read with `observe=1` so viewing never acts as its heartbeat.
@MainActor
@Observable
public final class OperationFeed {
    public let id: String
    public private(set) var text = ""
    public private(set) var latest: OperationOutput?
    /// The service no longer keeps this operation (finished long ago or the service restarted).
    public private(set) var missing = false
    public private(set) var error: String?
    public private(set) var earlierOutputOmitted = false
    @ObservationIgnored private var offset = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    static let characterLimit = 600_000

    public init(id: String) { self.id = id }

    public func start(client: any FleetAPI) {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !(await self.poll(client)) { return }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// Returns true while more output may arrive.
    func poll(_ client: any FleetAPI) async -> Bool {
        do {
            let output = try await client.operation(id: id, offset: offset)
            latest = output
            error = nil
            if output.truncated { earlierOutputOmitted = true }
            append(output.output)
            offset = output.nextOffset
            return output.status == "running"
        } catch let failure as FleetAPIError {
            if case .notFound = failure { missing = true; return false }
            // Keep trying through a brief outage; the output is still kept by the service.
            error = failure.errorDescription
            return true
        } catch {
            self.error = error.localizedDescription
            return true
        }
    }

    func append(_ chunk: String) {
        guard !chunk.isEmpty else { return }
        text += chunk
        if text.utf8.count > Self.characterLimit {
            text = String(text.suffix(Self.characterLimit * 3 / 4))
            earlierOutputOmitted = true
        }
    }
}
