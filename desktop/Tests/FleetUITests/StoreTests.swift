// The store's behaviour against a scripted service: connection states, worker
// merging, run start, removal, polling cadence, live output and settings edits.

import XCTest
@testable import FleetUI
import FleetKit

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

@MainActor
final class StoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("core/bin"), withIntermediateDirectories: true)
        try Data(#"{"name":"the-fleet","version":"9.9.9"}"#.utf8).write(to: root.appendingPathComponent("core/package.json"))
        for path in ["core/bin/the-fleet.js", "node"] {
            let url = root.appendingPathComponent(path)
            try Data("#!/bin/sh\n".utf8).write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeStore(_ api: FakeFleetAPI, core: Bool = true, launcher: @escaping @Sendable (CoreInstallation, String) async throws -> String = { _, _ in "" }) -> FleetStore {
        let preferences = FleetPreferences(defaults: UserDefaults(suiteName: "fleet-tests-\(UUID().uuidString)")!)
        preferences.fleetHome = root.appendingPathComponent("home").path
        preferences.scriptPath = core ? root.appendingPathComponent("core/bin/the-fleet.js").path : root.appendingPathComponent("missing/bin/the-fleet.js").path
        preferences.nodePath = root.appendingPathComponent("node").path
        return FleetStore(preferences: preferences, discovery: FleetDiscovery(userHome: root.path, environment: [:]), makeClient: { _ in api }, launcher: launcher)
    }

    func testAStoppedServiceIsStartedThroughTheInstalledCLI() async {
        let api = FakeFleetAPI()
        let launched = Flag()
        let store = makeStore(api, launcher: { core, home in
            XCTAssertTrue(core.scriptPath.hasSuffix("core/bin/the-fleet.js"))
            XCTAssertTrue(home.hasSuffix("/home"), "the service gets the same state folder as this app")
            launched.set()
            api.setHealth(version: "9.9.9")
            return "{}"
        })
        await store.refreshHealth()
        XCTAssertEqual(store.connection, .notRunning)
        await store.startService()
        XCTAssertTrue(launched.isSet)
        XCTAssertTrue(store.connection.isConnected)
        XCTAssertFalse(store.serviceNeedsUpdate)
        XCTAssertNil(store.serviceStartError)
    }

    func testWithoutTheCLINothingIsStartedAndTheProblemIsNamed() async {
        let launched = Flag()
        let store = makeStore(FakeFleetAPI(), core: false, launcher: { _, _ in launched.set(); return "" })
        XCTAssertNil(store.locations.core)
        await store.startService()
        XCTAssertFalse(launched.isSet)
        XCTAssertNotNil(store.serviceStartError)
    }

    func testAnOlderServiceIsFlaggedRatherThanReportedAsBroken() async {
        let api = FakeFleetAPI()
        api.setHealth(version: nil)
        api.setConfigurationFailure(.serviceOutdated)
        let store = makeStore(api)
        await store.refreshHealth()
        XCTAssertTrue(store.connection.isConnected)
        XCTAssertTrue(store.serviceNeedsUpdate)
        await store.fetch(.configuration)
        XCTAssertNil(store.configurationError)
        XCTAssertTrue(store.serviceNeedsUpdate)
    }

    func testWorkersMergeSettingsWithObservationsDefaultFirst() async throws {
        let api = FakeFleetAPI()
        api.operationsList = [UIFixture.operation("aaaaaaaaaaaaaaaaaaaaaaaa")]
        let store = makeStore(api)
        try await store.loadConfiguration()
        try await store.loadState(fresh: false)
        try await store.loadOperations()
        let workers = store.workers
        XCTAssertEqual(workers.map(\.id), ["desk", "laptop"], "the default worker is tried first, so it's shown first")
        XCTAssertEqual(workers[0].status.condition, .running)
        XCTAssertEqual(workers[0].status.job?.operationID, "aaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(workers[0].kind, .macMini)
        XCTAssertEqual(workers[0].subtitle, "Desk Mac mini")
        XCTAssertEqual(workers[1].status.condition, .unreachable)
        XCTAssertEqual(workers[1].kind, .macBook, "named from its pairing before it answers")
        store.preferences.deviceKinds["laptop"] = DeviceKind.macStudio.rawValue
        XCTAssertEqual(store.worker("laptop")?.kind, .macStudio)
        XCTAssertEqual(store.automaticDeviceKind(id: "laptop"), .macBook)
    }

    func testControllerSaveUpdatesTheSharedConfigurationAndPreservesItOnRefusal() async throws {
        let api = FakeFleetAPI()
        let store = makeStore(api)
        try await store.loadConfiguration()
        let saved = try await store.saveControllerSettings(revision: "c1", runsDirectory: "/tmp/results.noindex")
        XCTAssertEqual(saved.controller?.revision, "c2")
        XCTAssertEqual(store.configuration?.controller?.runsDirectory, "/tmp/results.noindex")
        let request = try JSONSerialization.jsonObject(with: JSONEncoder().encode(api.controllerSaves[0])) as! [String: Any]
        XCTAssertEqual(request["revision"] as? String, "c1")
        XCTAssertEqual(request["runsDirectory"] as? String, "/tmp/results.noindex")
        api.setControllerFailure(.revisionConflict(message: "Changed", currentRevision: "c3"))
        do {
            _ = try await store.saveControllerSettings(revision: "c2", runsDirectory: nil)
            XCTFail("must surface the server refusal")
        } catch {
            XCTAssertEqual(error as? FleetAPIError, .revisionConflict(message: "Changed", currentRevision: "c3"))
        }
        XCTAssertEqual(store.configuration?.controller?.runsDirectory, "/tmp/results.noindex")
        let reset = try JSONSerialization.jsonObject(with: JSONEncoder().encode(api.controllerSaves[1])) as! [String: Any]
        XCTAssertTrue(reset["runsDirectory"] is NSNull)
    }

    func testStartingARunOpensItsLiveOutputAsTheAppsOwnWork() async throws {
        let api = FakeFleetAPI()
        let store = makeStore(api)
        let id = try await store.startRun(project: "example", profile: "test", placement: .worker("desk"))
        XCTAssertEqual(api.started.first?.owner, FleetStore.appOwner)
        XCTAssertEqual(api.started.first?.placement, .worker("desk"))
        XCTAssertEqual(store.selection, .work)
        XCTAssertEqual(store.workPath, [.operation(id)])
        XCTAssertEqual(store.runningWork.map(\.id), [id])
    }

    func testRemovingTheOpenWorkerReturnsToTheOverview() async throws {
        let api = FakeFleetAPI()
        api.removalWarnings = ["pinned names desk as its worker."]
        let store = makeStore(api)
        store.selection = .worker("desk")
        store.preferences.deviceKinds["desk"] = DeviceKind.macMini.rawValue
        _ = try await store.removeWorker(id: "desk", revision: "r1")
        XCTAssertEqual(api.removals.first?.revision, "r1")
        XCTAssertEqual(store.selection, .overview)
        XCTAssertNil(store.preferences.deviceKinds["desk"])
        XCTAssertEqual(store.notice?.details, ["pinned names desk as its worker."])
    }

    func testFinishedWorkIncludesWorkThatNeverStartedNewestFirst() async throws {
        let api = FakeFleetAPI()
        api.operationsList = [
            UIFixture.operation("cccccccccccccccccccccccc", status: "complete", exitCode: 4, finishedAt: "2026-11-01T12:30:00.000Z", machine: nil),
            UIFixture.operation("dddddddddddddddddddddddd", status: "complete", exitCode: 0, jobIds: ["20261101-120001-example-test-000001"], finishedAt: "2026-11-01T12:00:07.000Z"),
            UIFixture.operation("eeeeeeeeeeeeeeeeeeeeeeee", status: "running"),
            UIFixture.operation("ffffffffffffffffffffffff", status: "complete", project: nil, exitCode: 0, finishedAt: "2026-11-01T13:00:00.000Z"),
        ]
        let store = makeStore(api)
        try await store.loadOperations()
        try await store.loadRuns()
        XCTAssertEqual(store.finishedWork.map(\.id), ["op-cccccccccccccccccccccccc", "run-20261101-120001-example-test-000001"],
                       "receipts aren't listed twice, and ordinary CLI commands aren't work")
        XCTAssertEqual(store.runningWork.map(\.id), ["eeeeeeeeeeeeeeeeeeeeeeee"])
    }

    func testPollingFollowsVisibilityAndWork() {
        typealias Store = FleetStore
        XCTAssertNil(Store.pollInterval(.state, activity: .hidden, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false),
                     "no window, no worker checks")
        XCTAssertEqual(Store.pollInterval(.health, activity: .hidden, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false), 30)
        XCTAssertNil(Store.pollInterval(.state, activity: .active, connected: false, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false))
        XCTAssertEqual(Store.pollInterval(.health, activity: .active, connected: false, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false), 2)
        XCTAssertEqual(Store.pollInterval(.health, activity: .active, connected: false, healthFailures: 9, hasRunningWork: false, workVisible: false, pairingsWanted: false), 10)
        XCTAssertEqual(Store.pollInterval(.operations, activity: .active, connected: true, healthFailures: 0, hasRunningWork: true, workVisible: false, pairingsWanted: false), 2)
        XCTAssertEqual(Store.pollInterval(.operations, activity: .active, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false), 6)
        XCTAssertGreaterThan(Store.pollInterval(.state, activity: .inactive, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false) ?? 0,
                             Store.pollInterval(.state, activity: .active, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false) ?? 0)
        XCTAssertNil(Store.pollInterval(.pairings, activity: .active, connected: true, healthFailures: 0, hasRunningWork: false, workVisible: false, pairingsWanted: false))
    }

    func testLiveOutputIsReadIncrementallyAndStopsWhenTheRunEnds() async {
        let api = FakeFleetAPI()
        api.queue([UIFixture.output("hello ", next: 6, status: "running"), UIFixture.output("world", next: 11, status: "complete")])
        let feed = OperationFeed(id: "aaaaaaaaaaaaaaaaaaaaaaaa")
        let first = await feed.poll(api)
        let second = await feed.poll(api)
        XCTAssertTrue(first)
        XCTAssertFalse(second)
        XCTAssertEqual(feed.text, "hello world")
        XCTAssertEqual(api.offsets, [0, 6])

        let retired = FakeFleetAPI()
        retired.setOperationFailure(.notFound("Operation is not retained."))
        let gone = OperationFeed(id: "aaaaaaaaaaaaaaaaaaaaaaaa")
        let more = await gone.poll(retired)
        XCTAssertFalse(more)
        XCTAssertTrue(gone.missing)
    }

    func testSettingsEditsSendOnlyWhatChanged() throws {
        let original = decode(WorkerSettings.self, UIFixture.settings("desk", target: "Desk-Mini", isDefault: true, description: "Desk", envNames: ["TOKEN"]))
        var draft = WorkerDraft(original)
        XCTAssertEqual(draft.changes(from: original), [:])
        draft.description = "  "
        draft.env.append(EnvRow(name: "NEW_TOOL", savedName: nil, newValue: "/opt/tool"))
        draft.limits.keepJobs = 5
        let body = draft.changes(from: original)
        XCTAssertEqual(body["description"], .null, "an emptied description is cleared, not saved as blank")
        XCTAssertEqual(body["env"], .object(["TOKEN": .object(["keep": .bool(true)]), "NEW_TOOL": .object(["value": .string("/opt/tool")])]),
                       "saved values are kept without being read")
        if case .object(let limits)? = body["limits"] { XCTAssertEqual(limits["keepJobs"], .number(5)) } else { XCTFail("limits missing") }
        XCTAssertNil(body["target"])
        XCTAssertNil(body["remoteRoot"], "unchanged route and folder are never sent")
        XCTAssertEqual(draft.problems, [])

        draft.env[0].name = "RENAMED"
        XCTAssertFalse(draft.problems.isEmpty, "a renamed saved variable needs a new value")
        draft.env[0].name = "TOKEN"
        draft.aliases = ["bad name"]
        XCTAssertFalse(draft.problems.isEmpty)
    }
}
