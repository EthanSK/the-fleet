// What the app says about a worker must follow the coordinator's own
// observation: precedence of conditions, honest job ownership and devices.

import XCTest
@testable import FleetKit

enum Observations {
    static func worker(_ id: String = "desk", available: Bool = true, reasons: [String] = [], health: String? = #"{"complete":true,"cpuCount":10,"loadAverage":[1,1,1],"lock":{"state":"free"}}"#, reservation: String? = nil, assignments: [Reservation]? = nil) -> WorkerObservation {
        var json = #"{"id":"\#(id)","aliases":[],"observedAt":"2026-11-01T22:00:00.000Z","available":\#(available),"reasons":\#(encode(reasons)),"warnings":[]"#
        if let health { json += #","health":\#(health)"# }
        if let reservation { json += #","reservation":\#(reservation)"# }
        if let assignments { json += #","assignments":\#(encode(assignments))"# }
        json += "}"
        return try! JSONDecoder().decode(WorkerObservation.self, from: Data(json.utf8))
    }

    static func reservation(kind: String, state: String = "active", owner: String = "agent", label: String = "own SSH tests", id: String = "aaaaaaaaaaaaaaaaaaaaaaaa", machine: String = "desk", jobId: String? = nil) -> Reservation {
        let job = jobId.map(encode) ?? "null"
        return try! JSONDecoder().decode(Reservation.self, from: Data(#"{"id":"\#(id)","jobId":\#(job),"machineId":"\#(machine)","fingerprint":"f","owner":"\#(owner)","label":"\#(label)","kind":"\#(kind)","createdAt":"2026-11-01T22:00:00.000Z","expiresAt":null,"state":"\#(state)"}"#.utf8))
    }

    static func operation(id: String = "aaaaaaaaaaaaaaaaaaaaaaaa", status: String = "running", project: String? = "example", exitCode: Int? = nil, jobIds: [String] = [], finishedAt: String? = nil) -> OperationSummary {
        let projectJSON = project.map { "\"\($0)\"" } ?? "null"
        let exit = exitCode.map(String.init) ?? "null"
        let finished = finishedAt.map { "\"\($0)\"" } ?? "null"
        return try! JSONDecoder().decode(OperationSummary.self, from: Data(#"{"id":"\#(id)","owner":"The Fleet app","kind":"run","label":"example/test","project":\#(projectJSON),"profile":"test","status":"\#(status)","exitCode":\#(exit),"createdAt":"2026-11-01T22:00:00.000Z","finishedAt":\#(finished),"detached":true,"cancelRequested":false,"jobIds":\#(encode(jobIds)),"machineId":"desk","lastLine":null}"#.utf8))
    }

    static func encode<T: Encodable>(_ value: T) -> String {
        String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
    }
}

final class WorkerStatusTests: XCTestCase {
    func testNoObservationYetIsChecking() {
        XCTAssertEqual(WorkerStatus.derive(nil, reservations: [], operations: []).condition, .checking)
    }

    func testNoAnswerIsUnreachableWithTheReason() {
        let status = WorkerStatus.derive(Observations.worker(available: false, reasons: ["Connection timed out"], health: nil), reservations: [], operations: [])
        XCTAssertEqual(status.condition, .unreachable)
        XCTAssertEqual(status.detail, "Connection timed out")
    }

    func testTheDispatchingComputerIsNeverOfferedAsAWorker() {
        let status = WorkerStatus.derive(Observations.worker(available: false, reasons: [WorkerStatus.dispatcherReason]), reservations: [], operations: [])
        XCTAssertEqual(status.condition, .dispatcher)
    }

    func testACoordinatedRunCanBeCancelledByItsOperation() {
        let health = #"{"complete":true,"lock":{"state":"busy","jobId":"20261101-job","label":"example/test","startedEpoch":1793570765,"orphaned":false}}"#
        let lease = Observations.reservation(kind: "managed", owner: "The Fleet app", label: "example/test")
        let status = WorkerStatus.derive(Observations.worker(available: false, reasons: ["busy"], health: health), reservations: [lease], operations: [Observations.operation()])
        XCTAssertEqual(status.condition, .running)
        XCTAssertEqual(status.job?.label, "example/test")
        XCTAssertEqual(status.job?.owner, "The Fleet app")
        XCTAssertEqual(status.job?.operationID, "aaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(status.job?.startedAt, Date(timeIntervalSince1970: 1793570765))
    }

    func testAJobThisServiceDidNotStartHasNoCancelIdentity() {
        let health = #"{"complete":true,"lock":{"state":"busy","jobId":"20261101-job","label":"-","orphaned":true}}"#
        let status = WorkerStatus.derive(Observations.worker(available: false, health: health), reservations: [], operations: [])
        XCTAssertEqual(status.condition, .running)
        XCTAssertNil(status.job?.operationID, "only coordinated runs are cancelled from the app")
        XCTAssertEqual(status.job?.orphaned, true)
        XCTAssertEqual(status.job?.label, "20261101-job")
    }

    func testAStaleLockNeedsAttentionAndIsNeverShownAsFree() {
        let health = #"{"complete":true,"lock":{"state":"stale","jobId":"20261101-old"}}"#
        let status = WorkerStatus.derive(Observations.worker(available: false, health: health), reservations: [], operations: [])
        XCTAssertEqual(status.condition, .unavailable)
        XCTAssertTrue(status.detail?.contains("20261101-old") == true)
    }

    func testExternalReservationsStayReservedAfterExpiry() {
        let active = WorkerStatus.derive(Observations.worker(available: false), reservations: [Observations.reservation(kind: "external")], operations: [])
        XCTAssertEqual(active.condition, .reserved)
        XCTAssertEqual(active.detail, "agent: own SSH tests")
        let expired = WorkerStatus.derive(Observations.worker(available: false), reservations: [Observations.reservation(kind: "external", state: "expired")], operations: [])
        XCTAssertEqual(expired.condition, .reserved, "expiry is uncertainty, not evidence the work stopped")
        XCTAssertTrue(expired.detail?.contains("Ownership stays") == true)
    }

    func testAManagedReservationBeforeTheLockIsAStartingRun() {
        let lease = Observations.reservation(kind: "managed", owner: "cli")
        let status = WorkerStatus.derive(Observations.worker(available: false), reservations: [lease], operations: [Observations.operation()])
        XCTAssertEqual(status.condition, .running)
        XCTAssertEqual(status.detail, "Starting")
    }

    func testSharedJobsMatchTheirOwnOperationDespiteReversedLockOrderAndAliases() {
        let first = Observations.reservation(kind: "managed", owner: "first app", jobId: "first-job")
        let second = Observations.reservation(kind: "managed", owner: "second app", id: "bbbbbbbbbbbbbbbbbbbbbbbb", jobId: "second-job")
        let health = #"{"complete":true,"lock":{"state":"free"},"sharedLocks":[{"state":"busy","jobId":"second-job","label":"second/test","startedEpoch":1793570765},{"state":"busy","jobId":"first-job","label":"first/test"}]}"#
        let observation = Observations.worker("alias", available: true, health: health, assignments: [first, second])
        let status = WorkerStatus.derive(observation, reservations: [], operations: [Observations.operation(), Observations.operation(id: second.id)])
        XCTAssertTrue(observation.available, "running activity does not remove spare capacity")
        XCTAssertEqual(status.condition, .running)
        XCTAssertNil(status.detail, "a confirmed remote job is no longer Starting")
        XCTAssertEqual(status.job?.jobID, "second-job")
        XCTAssertEqual(status.job?.owner, "second app")
        XCTAssertEqual(status.job?.operationID, second.id, "never cancel the first lease just because it appeared first")
        XCTAssertEqual(status.job?.startedAt, Date(timeIntervalSince1970: 1793570765))
    }

    func testUnknownSharedJobsNeverBorrowANeighboursCancelActionOrOwner() {
        let lease = Observations.reservation(kind: "managed", owner: "neighbour", jobId: "known-job")
        let external = Observations.reservation(kind: "external", owner: "other SSH client", id: "bbbbbbbbbbbbbbbbbbbbbbbb")
        let health = #"{"complete":true,"lock":{"state":"free"},"sharedLocks":[{"state":"busy","jobId":"unknown-job","label":"remote/test"}]}"#
        let status = WorkerStatus.derive(Observations.worker(health: health, assignments: [external, lease]), reservations: [lease], operations: [Observations.operation()])
        XCTAssertEqual(status.condition, .running)
        XCTAssertEqual(status.job?.jobID, "unknown-job")
        XCTAssertNil(status.job?.operationID)
        XCTAssertNil(status.job?.owner)
    }

    func testLegacyWorkerResponsesStillDecodeWithoutSharedFields() {
        let observation = Observations.worker()
        XCTAssertNil(observation.assignments)
        XCTAssertNil(observation.health?.sharedLocks)
        XCTAssertNil(Observations.reservation(kind: "managed").jobId)
        XCTAssertEqual(WorkerStatus.derive(observation, reservations: [], operations: []).condition, .available)
    }

    func testOtherHeavyWorkIsBusyAndOtherRefusalsAreUnavailable() {
        let health = #"{"complete":true,"lock":{"state":"free"},"heavy":[{"pid":1,"name":"swift-frontend"},{"pid":2,"name":"swift-frontend"},{"pid":3,"name":"ld"}]}"#
        let busy = WorkerStatus.derive(Observations.worker(available: false, reasons: ["desk is already running heavy work: swift-frontend ×2, ld. Other chats' builds don't take this runner's lock."], health: health), reservations: [], operations: [])
        XCTAssertEqual(busy.condition, .busy)
        XCTAssertEqual(busy.detail, "Other work: swift-frontend ×2, ld")
        let disk = WorkerStatus.derive(Observations.worker(available: false, reasons: ["Not enough free disk on desk: 3.0 GiB free, 8 GiB required"]), reservations: [], operations: [])
        XCTAssertEqual(disk.condition, .unavailable)
        XCTAssertEqual(disk.detail, "Not enough free disk on desk: 3.0 GiB free, 8 GiB required")
        XCTAssertEqual(WorkerStatus.derive(Observations.worker(), reservations: [], operations: []).condition, .available)
    }

    func testAttentionSortsBeforeIdleWorkers() {
        XCTAssertLessThan(WorkerCondition.running.rank, WorkerCondition.available.rank)
        XCTAssertLessThan(WorkerCondition.unreachable.rank, WorkerCondition.available.rank)
    }
}

final class DeviceKindTests: XCTestCase {
    func testReportedModelWins() {
        XCTAssertEqual(DeviceKind.classify(model: "Mac16,10", os: "Darwin", names: ["laptop"]), .macMini)
        XCTAssertEqual(DeviceKind.classify(model: "MacBookPro18,2", os: "Darwin", names: []), .macBook)
        XCTAssertEqual(DeviceKind.classify(model: "Mac13,1", os: "Darwin", names: []), .macStudio)
        XCTAssertEqual(DeviceKind.classify(model: "Macmini9,1", os: "Darwin", names: []), .macMini)
        XCTAssertEqual(DeviceKind.classify(model: "iMac21,1", os: "Darwin", names: []), .iMac)
    }

    func testNamesCoverWorkersNotYetReachedOrNewerModels() {
        XCTAssertEqual(DeviceKind.classify(model: nil, os: nil, names: ["m1max", "OldMacBookPro"]), .macBook)
        XCTAssertEqual(DeviceKind.classify(model: "Mac99,1", os: "Darwin", names: ["Mac-Mini"]), .macMini)
        XCTAssertEqual(DeviceKind.classify(model: nil, os: nil, names: ["studio"]), .macStudio)
    }

    func testLinuxComesFromTheSystemNotJustAName() {
        XCTAssertEqual(DeviceKind.classify(model: "PowerEdge", os: "Linux", names: []), .linux)
        XCTAssertEqual(DeviceKind.classify(model: nil, os: "Darwin", names: ["ubuntu-build"]), .mac)
        XCTAssertEqual(DeviceKind.classify(model: nil, os: nil, names: ["build"]), .mac)
    }
}

final class FormattingTests: XCTestCase {
    func testDurationsStayCompact() {
        XCTAssertEqual(FleetFormat.duration(45), "45s")
        XCTAssertEqual(FleetFormat.duration(192), "3m 12s")
        XCTAssertEqual(FleetFormat.duration(3840), "1h 04m")
        XCTAssertEqual(FleetFormat.duration(-3), "0s")
    }

    func testFreshness() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(FleetFormat.ago(now.addingTimeInterval(-2), now: now), "just now")
        XCTAssertEqual(FleetFormat.ago(now.addingTimeInterval(-42), now: now), "42s ago")
        XCTAssertEqual(FleetFormat.ago(now.addingTimeInterval(-600), now: now), "10m ago")
        XCTAssertEqual(FleetFormat.ago(now.addingTimeInterval(-7200), now: now), "2h ago")
    }

    func testCoreLEDsFollowTheOneMinuteLoad() {
        XCTAssertEqual(CoreLoad(load: 4.47, cores: 10).lit, 4)
        XCTAssertEqual(CoreLoad(load: 4.47, cores: 10).overflow, 0)
        let saturated = CoreLoad(load: 12.6, cores: 10)
        XCTAssertEqual(saturated.lit, 10)
        XCTAssertEqual(saturated.overflow, 3)
        XCTAssertEqual(CoreLoad(load: .nan, cores: 8).lit, 0)
        XCTAssertEqual(CoreLoad(load: 3, cores: 0).cores, 1, "a missing core count still draws one LED")
    }

    func testMemoryPressureLevels() {
        XCTAssertEqual(MemoryPressure(level: 1), .normal)
        XCTAssertEqual(MemoryPressure(level: 2), .elevated)
        XCTAssertEqual(MemoryPressure(level: 4), .critical)
        XCTAssertNil(MemoryPressure(level: nil))
    }

    func testCommandsQuoteOnlyWhatNeedsIt() {
        XCTAssertEqual(FleetFormat.command(["npm", "run", "test:unit"]), "npm run test:unit")
        XCTAssertEqual(FleetFormat.command(["swift", "test", "--filter", "Wand(A|B)"]), "swift test --filter 'Wand(A|B)'")
        XCTAssertEqual(FleetFormat.command(["echo", "it's"]), "echo 'it'\\''s'")
        XCTAssertEqual(FleetFormat.command(["printf", ""]), "printf ''")
    }

    func testHomeFolderIsAbbreviatedOnlyAtABoundary() {
        XCTAssertEqual(FleetFormat.path("/Users/a/Projects/x", home: "/Users/a"), "~/Projects/x")
        XCTAssertEqual(FleetFormat.path("/Users/ab/x", home: "/Users/a"), "/Users/ab/x")
    }

    func testExitCodesAreNamed() {
        XCTAssertEqual(ExitMeaning.title(0), "Passed")
        XCTAssertEqual(ExitMeaning.title(4), "No worker available")
        XCTAssertEqual(ExitMeaning.title(7), "Cancelled")
        XCTAssertEqual(ExitMeaning.title(42), "Exit 42")
    }
}

final class ValidationTests: XCTestCase {
    func testWorkerNamesFollowTheRegistryRules() {
        XCTAssertNil(FleetValidation.workerNameProblem("mini", existing: []))
        XCTAssertNotNil(FleetValidation.workerNameProblem("Mini", existing: []))
        XCTAssertNotNil(FleetValidation.workerNameProblem("-mini", existing: []))
        XCTAssertNotNil(FleetValidation.workerNameProblem("mini", existing: ["MINI"]), "names are unique across ids and aliases, ignoring case")
        XCTAssertNotNil(FleetValidation.workerNameProblem(String(repeating: "a", count: 49), existing: []))
    }

    func testSuggestedNamesComeFromThePairing() {
        XCTAssertEqual(FleetValidation.suggestedWorkerName(from: "Mac-Mini", existing: []), "mac-mini")
        XCTAssertEqual(FleetValidation.suggestedWorkerName(from: "Old MacBook Pro", existing: []), "old-macbook-pro")
        XCTAssertEqual(FleetValidation.suggestedWorkerName(from: "Mac-Mini", existing: ["mac-mini", "mac-mini-2"]), "mac-mini-3")
        XCTAssertEqual(FleetValidation.suggestedWorkerName(from: "___", existing: []), "worker")
        XCTAssertNil(FleetValidation.workerNameProblem(FleetValidation.suggestedWorkerName(from: "Ethan's Mac_Studio.local", existing: []), existing: []))
    }

    func testRemoteFoldersMustBeDedicatedNoindexFolders() {
        XCTAssertNil(FleetValidation.remoteRootProblem("~/FleetRunner.noindex"))
        XCTAssertNil(FleetValidation.remoteRootProblem("/Volumes/Scratch/Fleet.noindex"))
        XCTAssertNotNil(FleetValidation.remoteRootProblem("Fleet.noindex"))
        XCTAssertNotNil(FleetValidation.remoteRootProblem("~/Fleet"))
        XCTAssertNotNil(FleetValidation.remoteRootProblem("~/a/../Fleet.noindex"))
        XCTAssertNotNil(FleetValidation.remoteRootProblem("~/.noindex"))
        XCTAssertNotNil(FleetValidation.remoteRootProblem("~/a:b.noindex"))
    }

    func testEnvironmentNamesCannotTakeOverManagedVariables() {
        XCTAssertNil(FleetValidation.envNameProblem("TOOL_HOME"))
        XCTAssertNotNil(FleetValidation.envNameProblem("PATH"))
        XCTAssertNotNil(FleetValidation.envNameProblem("FLEET_RUNNER_JOB"))
        XCTAssertNotNil(FleetValidation.envNameProblem("1TOOL"))
    }

    func testLimitsMatchTheServiceRanges() throws {
        var limits = try JSONDecoder().decode(WorkerLimits.self, from: Data(#"{"minFreeDiskGiB":8,"minAvailableMemoryGiB":1,"memoryPressure":"refuse-critical","heavyProcessNames":["swiftc"],"heavyProcessAction":"refuse","keepJobs":20,"uploadTimeoutMinutes":15,"terminateGraceSeconds":20}"#.utf8))
        XCTAssertEqual(FleetValidation.limitProblems(limits), [])
        limits.keepJobs = 0
        limits.heavyProcessNames = ["bad name"]
        XCTAssertEqual(FleetValidation.limitProblems(limits).count, 2)
    }
}
