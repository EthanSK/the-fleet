// A scripted service for store and view tests. Answers are built from the same
// JSON shapes the real service returns.

import Foundation
import FleetKit

func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
    do { return try JSONDecoder().decode(T.self, from: Data(json.utf8)) }
    catch { fatalError("Fixture for \(T.self) doesn't decode: \(error)") }
}

func decode<T: Decodable>(_ json: String) -> T {
    decode(T.self, json)
}

enum UIFixture {
    static let limits = #"{"minFreeDiskGiB":8,"minAvailableMemoryGiB":1,"memoryPressure":"refuse-critical","heavyProcessNames":["swiftc","ld"],"heavyProcessAction":"refuse","keepJobs":20,"uploadTimeoutMinutes":15,"terminateGraceSeconds":20}"#

    static func settings(_ id: String, target: String, isDefault: Bool, description: String? = nil, envNames: [String] = []) -> String {
        let text = description.map { "\"\($0)\"" } ?? "null"
        let env = String(decoding: try! JSONEncoder().encode(envNames), as: UTF8.self)
        return #"{"id":"\#(id)","description":\#(text),"target":"\#(target)","aliases":[],"remoteRoot":"~/FleetRunner.noindex","pathPrepend":["/opt/homebrew/bin"],"envNames":\#(env),"limits":\#(limits),"isDefault":\#(isDefault)}"#
    }

    static let configuration = decode(FleetConfiguration.self, #"""
    {"revision":"r1","defaultMachine":"desk","machines":[\#(settings("laptop", target: "OldMacBookPro", isDefault: false)),\#(settings("desk", target: "Desk-Mini", isDefault: true, description: "Desk Mac mini", envNames: ["TOKEN"]))],
     "defaults":{"remoteRoot":"~/FleetRunner.noindex","limits":\#(limits)},"paths":{"home":"/tmp/fleet","machinesFile":"/tmp/fleet/machines.json","runsDirectory":"/tmp/fleet/runs.noindex"},"controller":{"revision":"c1","runsDirectory":null}}
    """#)

    static let state = decode(FleetState.self, #"""
    {"protocolVersion":1,"coordinatorPid":1,"observedAt":"2026-11-01T22:09:56.872Z",
     "workers":[
      {"id":"laptop","aliases":[],"observedAt":"2026-11-01T22:09:55.000Z","available":false,"reasons":["Connection timed out"],"warnings":[]},
      {"id":"desk","aliases":[],"observedAt":"2026-11-01T22:09:55.000Z","available":false,"reasons":["busy"],"warnings":["desk is under elevated memory pressure"],
       "health":{"complete":true,"os":"Darwin","arch":"arm64","host":"desk-host","user":"tester","model":"Mac16,10","cpuBrand":"Apple M4","osVersion":"26.1",
        "diskFreeBytes":18221412352,"memTotalBytes":17179869184,"memAvailableBytes":2621882368,"memPressureLevel":2,"cpuCount":10,"loadAverage":[4.47,4.17,4.08],
        "guiSession":true,"missingBaseTools":[],"heavy":[],"lock":{"state":"busy","jobId":"20261101-220602-example-test-17db55","label":"example/test","startedEpoch":1793570765,"orphaned":false}},
       "recentJobs":[{"jobId":"20261101-120001-example-test-000001","reason":"completed","exitCode":"0","label":"example/test","startedEpoch":1793570651,"endedEpoch":1793570654}],
       "caches":[{"name":"deps","kib":1024}],"jobsKiB":12484}],
     "reservations":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaa","machineId":"desk","fingerprint":"f","owner":"The Fleet app","label":"example/test","kind":"managed","createdAt":"2026-11-01T22:06:01.000Z","expiresAt":null,"state":"active"}]}
    """#)

    static func operation(_ id: String, status: String = "running", project: String? = "example", exitCode: Int? = nil, jobIds: [String] = [], finishedAt: String? = nil, machine: String? = "desk") -> OperationSummary {
        let projectJSON = project.map { "\"\($0)\"" } ?? "null"
        let finished = finishedAt.map { "\"\($0)\"" } ?? "null"
        let machineJSON = machine.map { "\"\($0)\"" } ?? "null"
        let jobs = String(decoding: try! JSONEncoder().encode(jobIds), as: UTF8.self)
        return decode(#"{"id":"\#(id)","owner":"The Fleet app","kind":"run","label":"example/test","project":\#(projectJSON),"profile":"test","status":"\#(status)","exitCode":\#(exitCode.map(String.init) ?? "null"),"createdAt":"2026-11-01T22:06:00.000Z","finishedAt":\#(finished),"detached":true,"cancelRequested":false,"jobIds":\#(jobs),"machineId":\#(machineJSON),"lastLine":"Uploading to desk"}"#)
    }

    static let runs = decode(RunList.self, #"""
    {"runsDirectory":"/tmp/fleet/runs.noindex","runs":[{"jobId":"20261101-120001-example-test-000001","project":"example","profile":"test","profileKind":"test","outcome":"passed",
     "summary":"Passed on desk: 3 tests, exit 0","machineId":"desk","requestedAt":"2026-11-01T12:00:00.000Z","finishedAt":"2026-11-01T12:00:06.000Z","jobSeconds":4,"totalSeconds":6,
     "testCount":3,"passed":true,"artifacts":0,"missingArtifacts":0,"owner":"cli","operationId":null,"available":true,"directory":"/tmp/fleet/runs.noindex/20261101-120001-example-test-000001"}]}
    """#)

    static func output(_ text: String, next: Int, status: String) -> OperationOutput {
        let escaped = String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
        return decode(#"{"id":"aaaaaaaaaaaaaaaaaaaaaaaa","owner":"cli","status":"\#(status)","output":\#(escaped),"nextOffset":\#(next),"truncated":false}"#)
    }
}

final class FakeFleetAPI: FleetAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var _health: Result<ServiceHealth, FleetAPIError> = .failure(.serviceNotRunning)
    private var _configurationFailure: FleetAPIError?
    private var _controllerFailure: FleetAPIError?
    private var _configuration = UIFixture.configuration
    private(set) var controllerSaves: [[String: JSONValue]] = []
    private var _outputs: [OperationOutput] = []
    private var _operationFailure: FleetAPIError?
    private(set) var offsets: [Int] = []
    private(set) var started: [(project: String, profile: String, placement: RunPlacement, owner: String)] = []
    private(set) var removals: [(id: String, revision: String)] = []
    var operationsList: [OperationSummary] = []
    var removalWarnings: [String] = []

    func setHealth(version: String?, pid: Int = 4242) {
        let versionJSON = version.map { "\"\($0)\"" } ?? "null"
        let health: ServiceHealth = decode(#"{"application":"The Fleet","protocolVersion":1,"pid":\#(pid),"version":\#(versionJSON),"startedAt":"2026-11-01T20:00:00.000Z"}"#)
        lock.withLock { _health = .success(health) }
    }
    func setConfigurationFailure(_ failure: FleetAPIError?) { lock.withLock { _configurationFailure = failure } }
    func setControllerFailure(_ failure: FleetAPIError?) { lock.withLock { _controllerFailure = failure } }
    func queue(_ outputs: [OperationOutput]) { lock.withLock { _outputs = outputs } }
    func setOperationFailure(_ failure: FleetAPIError?) { lock.withLock { _operationFailure = failure } }

    func health() async throws -> ServiceHealth {
        try lock.withLock { try _health.get() }
    }
    func state(fresh: Bool) async throws -> FleetState { UIFixture.state }
    func configuration() async throws -> FleetConfiguration {
        if let failure = lock.withLock({ _configurationFailure }) { throw failure }
        return lock.withLock { _configuration }
    }
    func updateControllerSettings(_ body: [String: JSONValue]) async throws -> FleetConfiguration {
        try lock.withLock {
            controllerSaves.append(body)
            if let failure = _controllerFailure { throw failure }
            var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(_configuration)) as! [String: Any]
            let input = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
            json["controller"] = ["revision": "c2", "runsDirectory": input["runsDirectory"] ?? NSNull()]
            _configuration = try JSONDecoder().decode(FleetConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
            return _configuration
        }
    }
    func pairings() async throws -> PairingList { decode(#"{"configPath":"/tmp/config","found":true,"targets":[]}"#) }
    func checkPairing(target: String, remoteRoot: String?, workerID: String?) async throws -> PairingCheck {
        decode(#"{"target":"\#(target)","observedAt":"2026-11-01T22:00:00.000Z","reachable":false,"error":"No route","dispatchingComputer":false}"#)
    }
    func addWorker(_ body: [String: JSONValue]) async throws -> WorkerChange { throw FleetAPIError.rejected(message: "unused", details: []) }
    func updateWorker(id: String, _ body: [String: JSONValue]) async throws -> WorkerChange { throw FleetAPIError.rejected(message: "unused", details: []) }
    func removeWorker(id: String, revision: String) async throws -> WorkerRemoval {
        let warnings = lock.withLock { removals.append((id, revision)); return removalWarnings }
        return decode(#"{"revision":"r2","removed":"\#(id)","warnings":\#(String(decoding: try! JSONEncoder().encode(warnings), as: UTF8.self))}"#)
    }
    func projects() async throws -> ProjectList { decode(#"{"projects":[]}"#) }
    func plan(project: String, profile: String, worker: String?) async throws -> RunPlan { throw FleetAPIError.rejected(message: "unused", details: []) }
    func startRun(project: String, profile: String, placement: RunPlacement, owner: String) async throws -> OperationStarted {
        lock.withLock { started.append((project, profile, placement, owner)) }
        let operation = String(decoding: try JSONEncoder().encode(UIFixture.operation("bbbbbbbbbbbbbbbbbbbbbbbb", machine: nil)), as: UTF8.self)
        return decode(#"{"operationId":"bbbbbbbbbbbbbbbbbbbbbbbb","operation":\#(operation)}"#)
    }
    func operations() async throws -> [OperationSummary] { lock.withLock { operationsList } }
    func operation(id: String, offset: Int) async throws -> OperationOutput {
        try lock.withLock {
            offsets.append(offset)
            if let failure = _operationFailure { throw failure }
            return _outputs.isEmpty ? UIFixture.output("", next: offset, status: "complete") : _outputs.removeFirst()
        }
    }
    func cancel(operationID: String) async throws {}
    func runs(limit: Int) async throws -> RunList { UIFixture.runs }
    func runDetail(jobID: String) async throws -> RunDetail { throw FleetAPIError.notFound("No receipt") }
    func recoverManagedReservations(workerID: String?) async throws -> [String] { [] }
}
