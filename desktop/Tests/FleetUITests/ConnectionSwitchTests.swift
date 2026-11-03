// Switching the configured coordinator must invalidate replies from the old
// one, including requests already waiting on its socket.
import XCTest
import FleetKit
@testable import FleetUI

private actor DeferredReply: HTTPTransport {
    private var pending: CheckedContinuation<HTTPResponse, Never>?

    func send(method: String, path: String, body: Data?, timeout: TimeInterval) async throws -> HTTPResponse {
        await withCheckedContinuation { pending = $0 }
    }

    func waitForRequest() async throws {
        for _ in 0..<1_000 {
            if pending != nil { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        throw NSError(domain: "ConnectionSwitchTests", code: 1)
    }

    func finish(_ json: String) {
        pending?.resume(returning: HTTPResponse(status: 200, headers: [:], body: Data(json.utf8)))
        pending = nil
    }
}

@MainActor
final class ConnectionSwitchTests: XCTestCase {
    func testOldControllerSaveCannotRepopulateSwitchedConnection() async throws {
        let suite = "TheFleet.controller-switch.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = FleetPreferences(defaults: defaults)
        preferences.fleetHome = "/tmp/fleet-first"
        let reply = DeferredReply()
        let store = FleetStore(preferences: preferences, makeClient: { _ in LiveFleetClient(transport: reply) })
        let request = Task { try await store.saveControllerSettings(revision: "c1", runsDirectory: nil) }
        try await reply.waitForRequest()
        preferences.fleetHome = "/tmp/fleet-second"
        store.applyLocations()
        await reply.finish(String(decoding: try JSONEncoder().encode(UIFixture.configuration), as: UTF8.self))
        do { _ = try await request.value; XCTFail("old connection must be rejected") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(store.configuration)
    }
    func testOldWorkerReplyCannotRepopulateSwitchedConnection() async throws {
        let suite = "TheFleet.connection-switch.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = FleetPreferences(defaults: defaults)
        preferences.fleetHome = "/tmp/fleet-first"
        let reply = DeferredReply()
        let store = FleetStore(preferences: preferences, makeClient: { _ in LiveFleetClient(transport: reply) })
        let request = Task { try await store.loadState(fresh: false) }
        try await reply.waitForRequest()
        preferences.fleetHome = "/tmp/fleet-second"
        store.applyLocations()
        await reply.finish(#"{"protocolVersion":1,"coordinatorPid":7,"observedAt":"2026-11-01T12:00:00Z","workers":[],"reservations":[]}"#)
        try await request.value
        XCTAssertEqual(store.locations.home, "/tmp/fleet-second")
        XCTAssertNil(store.state, "the previous coordinator's worker reply must be ignored")
    }

    func testOldHealthReplyCannotMarkNewConnectionAsConnected() async throws {
        let suite = "TheFleet.health-switch.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = FleetPreferences(defaults: defaults)
        preferences.fleetHome = "/tmp/fleet-first"
        let reply = DeferredReply()
        let store = FleetStore(preferences: preferences, makeClient: { _ in LiveFleetClient(transport: reply) })
        let request = Task { await store.refreshHealth() }
        try await reply.waitForRequest()
        preferences.fleetHome = "/tmp/fleet-second"
        store.applyLocations()
        await reply.finish(#"{"application":"The Fleet","protocolVersion":1,"pid":7,"version":"0.4.0"}"#)
        await request.value
        XCTAssertEqual(store.connection, .connecting, "only the new coordinator may complete this connection")
    }
}
