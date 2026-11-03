// The app's contract with src/service: response shapes, error meanings and
// the exact requests it is allowed to make (detached owned runs, observing
// without heartbeats, revision-checked settings).

import XCTest
@testable import FleetKit

/// Answers by path and records each request.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Request { let method: String; let path: String; let body: String? }
    private let lock = NSLock()
    private var replies: [String: (Int, String)] = [:]
    private(set) var requests: [Request] = []

    func reply(_ pathPrefix: String, status: Int = 200, _ json: String) {
        lock.withLock { replies[pathPrefix] = (status, json) }
    }

    func send(method: String, path: String, body: Data?, timeout: TimeInterval) async throws -> HTTPResponse {
        lock.withLock {
            requests.append(Request(method: method, path: path, body: body.map { String(decoding: $0, as: UTF8.self) }))
            let match = replies.keys.filter { path.hasPrefix($0) }.max { $0.count < $1.count }
            guard let match, let (status, json) = replies[match] else {
                return HTTPResponse(status: 404, headers: [:], body: Data("{\"error\":\"Unknown API route.\",\"code\":\"unknown-route\"}".utf8))
            }
            return HTTPResponse(status: status, headers: ["content-type": "application/json"], body: Data(json.utf8))
        }
    }

    var last: Request? { lock.withLock { requests.last } }
}

enum Fixture {
    /// Shaped like a real two-worker coordinator answer.
    static let state = """
    {"protocolVersion":1,"coordinatorPid":56470,"observedAt":"2026-11-01T22:09:56.872Z",
     "workers":[
      {"id":"desk","aliases":["desk-alias"],"observedAt":"2026-11-01T22:09:55.100Z","available":false,
       "reasons":["desk is busy: example/test (job 20261101-220602-example-test-17db55) running for 1m 2s"],
       "warnings":["desk is under elevated memory pressure"],
       "health":{"complete":true,"os":"Darwin","arch":"arm64","host":"desk-host","user":"tester","bashVersion":"3.2.57(1)-release",
        "fingerprint":"0123456789abcdef","model":"Mac16,10","cpuBrand":"Apple M4","osVersion":"26.1","rootExists":true,
        "diskFreeBytes":18221412352,"memTotalBytes":17179869184,"memAvailableBytes":2621882368,"memPressureLevel":2,"swapUsedMiB":812.5,
        "cpuCount":10,"loadAverage":[4.47314453125,4.16943359375,4.08154296875],"guiSession":true,"bsdtar":true,"missingBaseTools":[],
        "tools":{},"heavy":[],"lock":{"state":"busy","jobId":"20261101-220602-example-test-17db55","label":"example/test","startedEpoch":1793570765,"orphaned":false}},
       "recentJobs":[{"jobId":"20261101-220407-example-test-8012a2","reason":"completed","exitCode":"1","label":"example/test","startedEpoch":1793570651,"endedEpoch":1793570654}],
       "caches":[{"name":"example-deps","kib":1282136}],"jobsKiB":12484},
      {"id":"laptop","aliases":[],"observedAt":"2026-11-01T22:09:55.300Z","available":false,
       "reasons":["Connection timed out"],"warnings":[]}
     ],
     "reservations":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaa","machineId":"desk","fingerprint":"0123456789abcdef","owner":"The Fleet app",
       "label":"example/test","kind":"managed","createdAt":"2026-11-01T22:06:01.000Z","expiresAt":null,"state":"active"}]}
    """

    static let runDetail = """
    {"jobId":"20261101-120001-example-test-000001","available":true,"directory":"/tmp/runs.noindex/20261101-120001-example-test-000001",
     "run":{"jobId":"20261101-120001-example-test-000001","project":"example","profile":"test","profileKind":"test","outcome":"passed",
       "summary":"Passed on desk: 3 tests, exit 0","machineId":"desk","requestedAt":"2026-11-01T12:00:00.000Z","finishedAt":"2026-11-01T12:00:06.000Z",
       "jobSeconds":4,"totalSeconds":6,"testCount":3,"passed":true,"artifacts":0,"missingArtifacts":0,"owner":"cli","operationId":null,"available":true,
       "directory":"/tmp/runs.noindex/20261101-120001-example-test-000001"},
     "receipt":{"schemaVersion":1,"jobId":"20261101-120001-example-test-000001","project":"example","profile":"test","profileKind":"test",
       "outcome":"passed","cliExitCode":0,"summary":"Passed on desk: 3 tests, exit 0",
       "machine":{"id":"desk","transport":"Agent Bridge target Desk (internet route)","host":"desk-host","fingerprint":"0123456789abcdef"},
       "source":{"root":"/tmp/source","digest":"\(String(repeating: "a", count: 64))","files":3,"symlinks":0,"bytes":30,
         "git":{"head":null,"branch":null,"staged":0,"unstaged":2,"untracked":1},"manifest":"source-manifest.tsv"},
       "command":{"argv":["npm","test"],"extraArgs":[],"prepare":[["npm","ci"]],"cwd":".","envNames":["API_TOKEN"],"timeoutSeconds":300,"script":"command.sh"},
       "timing":{"requestedAt":"2026-11-01T12:00:00.000Z","remoteStartedAt":"2026-11-01T12:00:01.000Z","remoteEndedAt":"2026-11-01T12:00:05.000Z",
         "finishedAt":"2026-11-01T12:00:06.000Z","jobSeconds":4,"totalSeconds":6},
       "remote":{"admission":"admitted","reason":"completed","exitCode":0,"stragglersStopped":false,"processesRemaining":false,"lockReleased":true,"notes":[]},
       "success":{"passed":true,"testCount":3,"checks":[{"name":"exit code","passed":true,"detail":"exit 0"}]},
       "artifacts":[{"path":"reports/junit.xml","sha256":"\(String(repeating: "b", count: 64))","bytes":2048}],"missingArtifacts":[],
       "logs":{"stdout":"stdout.log","stderr":"stderr.log"}},
     "logs":{"stdout":{"text":"# tests 3\\n","bytes":3011,"truncated":true,"present":true},"stderr":{"text":"","bytes":0,"truncated":false,"present":true}}}
    """
}

final class ClientContractTests: XCTestCase {
    func testControllerSettingsUseTheSharedRevisionCheckedRoute() async throws {
        let stub = StubTransport()
        let json = #"{"revision":"r1","defaultMachine":null,"machines":[],"defaults":{"remoteRoot":"~/FleetRunner.noindex","limits":{"minFreeDiskGiB":8,"minAvailableMemoryGiB":1,"memoryPressure":"refuse-critical","heavyProcessNames":[],"heavyProcessAction":"warn","keepJobs":20,"uploadTimeoutMinutes":15,"terminateGraceSeconds":20}},"paths":{"home":"/tmp/fleet","machinesFile":"/tmp/fleet/machines.json","runsDirectory":"/tmp/results.noindex"},"controller":{"revision":"c2","runsDirectory":"/tmp/results.noindex"}}"#
        stub.reply("/v1/config/controller", json)
        let config = try await LiveFleetClient(transport: stub).updateControllerSettings(["revision": .string("c1"), "runsDirectory": .null])
        XCTAssertEqual(config.controller?.revision, "c2")
        XCTAssertEqual(stub.last?.method, "PUT")
        XCTAssertEqual(stub.last?.path, "/v1/config/controller")
        let body = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(stub.last?.body).utf8)) as! [String: Any]
        XCTAssertEqual(body["revision"] as? String, "c1")
        XCTAssertTrue(body["runsDirectory"] is NSNull)
        var oldJSON = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        oldJSON.removeValue(forKey: "controller")
        stub.reply("/v1/config", String(decoding: try JSONSerialization.data(withJSONObject: oldJSON), as: UTF8.self))
        let older = try await LiveFleetClient(transport: stub).configuration()
        XCTAssertNil(older.controller)
    }
    func testDecodesTheCoordinatorsStateShape() async throws {
        let stub = StubTransport()
        stub.reply("/v1/state", Fixture.state)
        let state = try await LiveFleetClient(transport: stub).state(fresh: true)
        XCTAssertEqual(stub.last?.path, "/v1/state?fresh=1")
        XCTAssertEqual(state.workers.map(\.id), ["desk", "laptop"])
        let desk = try XCTUnwrap(state.workers.first)
        XCTAssertEqual(desk.health?.model, "Mac16,10")
        XCTAssertEqual(desk.health?.lock?.state, "busy")
        XCTAssertEqual(desk.health?.loadAverage?.count, 3)
        XCTAssertEqual(desk.recentJobs?.first?.exitCode, "1")
        XCTAssertNil(state.workers[1].health, "an unreachable worker has no health")
        XCTAssertEqual(state.reservations.first?.kind, "managed")
        XCTAssertNil(state.reservations.first?.expiresAt)
    }

    func testDecodesAFinishedRunWithItsReceiptAndLogTails() async throws {
        let stub = StubTransport()
        stub.reply("/v1/runs/", Fixture.runDetail)
        let detail = try await LiveFleetClient(transport: stub).runDetail(jobID: "20261101-120001-example-test-000001")
        XCTAssertEqual(detail.receipt?.success.checks.first?.name, "exit code")
        XCTAssertEqual(detail.receipt?.artifacts.first?.path, "reports/junit.xml")
        XCTAssertEqual(detail.receipt?.source.git?.unstaged, 2)
        XCTAssertEqual(detail.logs?.stdout.truncated, true)
        XCTAssertEqual(detail.receipt?.command.envNames, ["API_TOKEN"], "receipts carry environment names only")
    }

    func testServiceRefusalsKeepTheirMeaning() async {
        let stub = StubTransport()
        let client = LiveFleetClient(transport: stub)
        stub.reply("/v1/machines/desk", status: 409, #"{"error":"These worker settings changed somewhere else while you were editing. Reload them and try again.","code":"revision-conflict","revision":"abc123"}"#)
        await assertThrows(try await client.updateWorker(id: "desk", ["revision": .string("old")]),
                           .revisionConflict(message: "These worker settings changed somewhere else while you were editing. Reload them and try again.", currentRevision: "abc123"))
        stub.reply("/v1/machines/desk", status: 409, #"{"error":"desk is reserved by agent for tests. Change its connection or remote folder after that work is released.","code":"busy","exitCode":4}"#)
        await assertThrows(try await client.updateWorker(id: "desk", [:]), .busy(message: "desk is reserved by agent for tests. Change its connection or remote folder after that work is released.", details: []))
        stub.reply("/v1/projects/example/run", status: 400, #"{"error":"No available remote workers in --machines.","code":"invalid","exitCode":4,"details":["desk: busy"]}"#)
        await assertThrows(try await client.startRun(project: "example", profile: "test", placement: .firstAvailable, owner: "app"),
                           .rejected(message: "No available remote workers in --machines.", details: ["desk: busy"]))
        stub.reply("/v1/operations/", status: 404, #"{"error":"Operation is not retained. Inspect the durable job receipts.","code":"not-found"}"#)
        await assertThrows(try await client.operation(id: "a1", offset: 0), .notFound("Operation is not retained. Inspect the durable job receipts."))
    }

    func testOlderServicesAreRecognisedWithOrWithoutAnErrorCode() async {
        let stub = StubTransport()
        await assertThrows(try await LiveFleetClient(transport: stub).configuration(), .serviceOutdated)
        stub.reply("/v1/operations", status: 404, #"{"error":"Unknown API route."}"#)
        await assertThrows(try await LiveFleetClient(transport: stub).operations(), .serviceOutdated)
    }

    func testRunsFromTheAppAreDetachedOwnedAndPinnedOnlyWhenChosen() async throws {
        let stub = StubTransport()
        stub.reply("/v1/projects/example/run", status: 202, #"{"operationId":"0123456789abcdef01234567"}"#)
        let client = LiveFleetClient(transport: stub)
        _ = try await client.startRun(project: "example", profile: "test", placement: .worker("desk"), owner: "The Fleet app")
        let pinned = try XCTUnwrap(stub.last?.body).data(using: .utf8)!
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: pinned) as? [String: Any])
        XCTAssertEqual(body["detached"] as? Bool, true, "quitting the app must not abandon its runs")
        XCTAssertEqual(body["owner"] as? String, "The Fleet app")
        XCTAssertEqual(body["machine"] as? String, "desk")
        _ = try await client.startRun(project: "example", profile: "test", placement: .firstAvailable, owner: "The Fleet app")
        XCTAssertFalse(stub.last?.body?.contains("machine") ?? true, "the coordinator picks the worker")
    }

    func testWatchingAnOperationNeverActsAsItsHeartbeat() async throws {
        let stub = StubTransport()
        stub.reply("/v1/operations/", #"{"id":"0123456789abcdef01234567","owner":"cli","status":"running","output":"x","nextOffset":5,"truncated":false}"#)
        _ = try await LiveFleetClient(transport: stub).operation(id: "0123456789abcdef01234567", offset: 4)
        XCTAssertEqual(stub.last?.path, "/v1/operations/0123456789abcdef01234567?offset=4&observe=1")
    }

    func testRecoveryTargetsOneWorkerAndKeepsTheGlobalRouteAvailable() async throws {
        let stub = StubTransport()
        stub.reply("/v1/recover", #"{"released":[]}"#)
        let client = LiveFleetClient(transport: stub)
        _ = try await client.recoverManagedReservations(workerID: "desk")
        XCTAssertEqual(stub.last?.path, "/v1/recover?machine=desk")
        _ = try await client.recoverManagedReservations()
        XCTAssertEqual(stub.last?.path, "/v1/recover")
    }

    func testSettingsRequestsCarryTheirRevisionAndKeepNullDistinctFromOmitted() async throws {
        let stub = StubTransport()
        stub.reply("/v1/machines/desk", #"{"revision":"r2","removed":"desk","warnings":[]}"#)
        _ = try await LiveFleetClient(transport: stub).removeWorker(id: "desk", revision: "r1/+")
        XCTAssertEqual(stub.last?.method, "DELETE")
        XCTAssertEqual(stub.last?.path, "/v1/machines/desk?revision=r1%2F%2B")
        let encoded = String(decoding: try JSONEncoder().encode(["description": JSONValue.null, "keepJobs": .number(5), "ratio": .number(1.5)]), as: UTF8.self)
        XCTAssertTrue(encoded.contains("\"description\":null"))
        XCTAssertTrue(encoded.contains("\"keepJobs\":5"))
        XCTAssertTrue(encoded.contains("\"ratio\":1.5"))
    }

    private func assertThrows<T>(_ expression: @autoclosure () async throws -> T, _ expected: FleetAPIError, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await expression()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? FleetAPIError, expected, file: file, line: line)
        }
    }
}
