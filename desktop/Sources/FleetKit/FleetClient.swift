// Typed access to The Fleet's local API.
//
// The app only reads and requests: worker settings are written by the service
// (with revision checks), runs are admitted by the coordinator, and reading
// another client's operation uses `observe=1` so viewing it never keeps
// abandoned work alive.

import Foundation

public enum FleetAPIError: Error, Equatable, LocalizedError {
    /// Nothing is listening on the socket.
    case serviceNotRunning
    /// The running service predates this route; it needs a restart onto the current version.
    case serviceOutdated
    /// Settings changed somewhere else since they were loaded.
    case revisionConflict(message: String, currentRevision: String?)
    /// The worker has work or a reservation, or its lock could not be confirmed free.
    case busy(message: String, details: [String])
    case notFound(String)
    case rejected(message: String, details: [String])
    case transport(String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .serviceNotRunning: return "The Fleet isn't running."
        case .serviceOutdated: return "The running service is older than this app. Restart it to load the current version."
        case .revisionConflict(let message, _): return message
        case .busy(let message, _): return message
        case .notFound(let message): return message
        case .rejected(let message, _): return message
        case .transport(let message): return message
        case .invalidResponse(let message): return message
        }
    }

    public var details: [String] {
        switch self {
        case .busy(_, let details), .rejected(_, let details): return details
        default: return []
        }
    }
}

/// A JSON value for request bodies, keeping `null` (clear) distinct from an omitted field (keep).
public enum JSONValue: Encodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value):
            if value.rounded() == value, abs(value) < 9e15 { try container.encode(Int64(value)) } else { try container.encode(value) }
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public static func strings(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
}

/// Where a profile run may go. The coordinator decides the actual worker.
public enum RunPlacement: Equatable, Sendable {
    /// Registered workers in order, default first (or the project's own worker).
    case firstAvailable
    case worker(String)
}

public protocol FleetAPI: Sendable {
    func health() async throws -> ServiceHealth
    func state(fresh: Bool) async throws -> FleetState
    func configuration() async throws -> FleetConfiguration
    func updateControllerSettings(_ body: [String: JSONValue]) async throws -> FleetConfiguration
    func pairings() async throws -> PairingList
    func checkPairing(target: String, remoteRoot: String?, workerID: String?) async throws -> PairingCheck
    func addWorker(_ body: [String: JSONValue]) async throws -> WorkerChange
    func updateWorker(id: String, _ body: [String: JSONValue]) async throws -> WorkerChange
    func removeWorker(id: String, revision: String) async throws -> WorkerRemoval
    func projects() async throws -> ProjectList
    func plan(project: String, profile: String, worker: String?) async throws -> RunPlan
    func startRun(project: String, profile: String, placement: RunPlacement, owner: String) async throws -> OperationStarted
    func operations() async throws -> [OperationSummary]
    func operation(id: String, offset: Int) async throws -> OperationOutput
    func cancel(operationID: String) async throws
    func runs(limit: Int) async throws -> RunList
    func runDetail(jobID: String) async throws -> RunDetail
    func recoverManagedReservations(workerID: String?) async throws -> [String]
}

public extension FleetAPI {
    /// Existing embedders can keep read-only controller settings support.
    func updateControllerSettings(_ body: [String: JSONValue]) async throws -> FleetConfiguration {
        throw FleetAPIError.serviceOutdated
    }
}

public struct LiveFleetClient: FleetAPI {
    public let transport: HTTPTransport

    public init(transport: HTTPTransport) {
        self.transport = transport
    }

    public init(socketPath: String) {
        self.transport = UnixSocketHTTPClient(socketPath: socketPath)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    func request<T: Decodable>(_ method: String, _ path: String, body: [String: JSONValue]? = nil, timeout: TimeInterval = 30) async throws -> T {
        let data = try body.map { try Self.encoder.encode($0) }
        let response: HTTPResponse
        do {
            response = try await transport.send(method: method, path: path, body: data, timeout: timeout)
        } catch SocketError.serviceNotRunning {
            throw FleetAPIError.serviceNotRunning
        } catch SocketError.timedOut {
            throw FleetAPIError.transport("The Fleet didn't answer in time.")
        } catch let error as SocketError {
            throw FleetAPIError.transport("Couldn't reach The Fleet (\(error)).")
        } catch let error as HTTPParseError {
            throw FleetAPIError.invalidResponse("The Fleet sent an unreadable answer (\(error)).")
        }
        return try Self.decode(response)
    }

    static func decode<T: Decodable>(_ response: HTTPResponse) throws -> T {
        let decoder = JSONDecoder()
        if response.status >= 400 {
            let body = try? decoder.decode(ServiceErrorBody.self, from: response.body)
            let message = body?.error ?? "The Fleet refused the request (HTTP \(response.status))."
            switch (response.status, body?.code) {
            case (404, .some("unknown-route")):
                throw FleetAPIError.serviceOutdated
            case (404, .none) where message == "Unknown API route.":
                // Services before the structured API answered unknown routes without a code.
                throw FleetAPIError.serviceOutdated
            case (409, .some("revision-conflict")):
                throw FleetAPIError.revisionConflict(message: message, currentRevision: body?.revision)
            case (409, _):
                throw FleetAPIError.busy(message: message, details: body?.details ?? [])
            case (404, _):
                throw FleetAPIError.notFound(message)
            default:
                throw FleetAPIError.rejected(message: message, details: body?.details ?? [])
            }
        }
        do {
            return try decoder.decode(T.self, from: response.body)
        } catch {
            throw FleetAPIError.invalidResponse("Unexpected answer from The Fleet: \(error)")
        }
    }

    static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }

    public func health() async throws -> ServiceHealth {
        try await request("GET", "/v1/health", timeout: 5)
    }

    public func state(fresh: Bool) async throws -> FleetState {
        // A fresh probe waits for every worker's read-only check (up to 45 s each, in parallel).
        try await request("GET", fresh ? "/v1/state?fresh=1" : "/v1/state", timeout: 100)
    }

    public func configuration() async throws -> FleetConfiguration {
        try await request("GET", "/v1/config")
    }

    public func updateControllerSettings(_ body: [String: JSONValue]) async throws -> FleetConfiguration {
        try await request("PUT", "/v1/config/controller", body: body)
    }

    public func pairings() async throws -> PairingList {
        try await request("GET", "/v1/pairings")
    }

    public func checkPairing(target: String, remoteRoot: String?, workerID: String?) async throws -> PairingCheck {
        var body: [String: JSONValue] = ["target": .string(target)]
        if let remoteRoot { body["remoteRoot"] = .string(remoteRoot) }
        if let workerID { body["id"] = .string(workerID) }
        return try await request("POST", "/v1/pairings/check", body: body, timeout: 100)
    }

    public func addWorker(_ body: [String: JSONValue]) async throws -> WorkerChange {
        try await request("POST", "/v1/machines", body: body)
    }

    public func updateWorker(id: String, _ body: [String: JSONValue]) async throws -> WorkerChange {
        try await request("PUT", "/v1/machines/\(Self.component(id))", body: body, timeout: 100)
    }

    public func removeWorker(id: String, revision: String) async throws -> WorkerRemoval {
        try await request("DELETE", "/v1/machines/\(Self.component(id))?revision=\(Self.component(revision))")
    }

    public func projects() async throws -> ProjectList {
        try await request("GET", "/v1/projects")
    }

    public func plan(project: String, profile: String, worker: String?) async throws -> RunPlan {
        var body: [String: JSONValue] = ["profile": .string(profile)]
        if let worker { body["machine"] = .string(worker) }
        return try await request("POST", "/v1/projects/\(Self.component(project))/plan", body: body, timeout: 120)
    }

    public func startRun(project: String, profile: String, placement: RunPlacement, owner: String) async throws -> OperationStarted {
        // Detached: the run is bounded by its profile timeout and keeps going if the app quits.
        var body: [String: JSONValue] = ["profile": .string(profile), "owner": .string(owner), "detached": .bool(true)]
        if case .worker(let id) = placement { body["machine"] = .string(id) }
        return try await request("POST", "/v1/projects/\(Self.component(project))/run", body: body)
    }

    public func operations() async throws -> [OperationSummary] {
        let list: OperationList = try await request("GET", "/v1/operations", timeout: 10)
        return list.operations
    }

    public func operation(id: String, offset: Int) async throws -> OperationOutput {
        try await request("GET", "/v1/operations/\(Self.component(id))?offset=\(offset)&observe=1", timeout: 10)
    }

    public func cancel(operationID: String) async throws {
        let _: [String: Bool] = try await request("POST", "/v1/operations/\(Self.component(operationID))/cancel", body: [:], timeout: 10)
    }

    public func runs(limit: Int) async throws -> RunList {
        try await request("GET", "/v1/runs?limit=\(limit)")
    }

    public func runDetail(jobID: String) async throws -> RunDetail {
        try await request("GET", "/v1/runs/\(Self.component(jobID))")
    }

    public func recoverManagedReservations(workerID: String? = nil) async throws -> [String] {
        let path = "/v1/recover" + (workerID.map { "?machine=\(Self.component($0))" } ?? "")
        let result: RecoveredReservations = try await request("POST", path, body: [:], timeout: 100)
        return result.released
    }
}
