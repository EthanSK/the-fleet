// A Dock app has no shell environment, so it must find the same service,
// state folder and CLI that the login service and command line use.

import XCTest
@testable import FleetKit

final class DiscoveryTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-discovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeExecutable(_ path: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    /// A package laid out like the repository: package.json beside bin/the-fleet.js.
    private func makePackage(_ directory: String, name: String = "the-fleet", version: String = "0.3.0") throws -> String {
        let package = root.appendingPathComponent(directory)
        try FileManager.default.createDirectory(at: package.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try Data(#"{"name":"\#(name)","version":"\#(version)"}"#.utf8).write(to: package.appendingPathComponent("package.json"))
        try makeExecutable("\(directory)/bin/the-fleet.js")
        try makeExecutable("\(directory)/bin/fleet-runner.js")
        return package.appendingPathComponent("bin/the-fleet.js").path
    }

    func testReadsTheLoginServiceTheCLIWrites() {
        let plist: [String: Any] = [
            "Label": "org.the-fleet.service",
            "ProgramArguments": ["python3", "/opt/fleet/bin/service-lock.py", "/opt/node/bin/node", "/opt/fleet/bin/the-fleet.js", "service", "serve"],
            "EnvironmentVariables": ["THE_FLEET_HOME": "/Users/someone/.fleet-runner", "PATH": "/usr/bin:/bin"],
        ]
        let agent = FleetDiscovery.parseLaunchAgent(plist, path: "/x.plist")
        XCTAssertEqual(agent.nodePath, "/opt/node/bin/node")
        XCTAssertEqual(agent.scriptPath, "/opt/fleet/bin/the-fleet.js")
        XCTAssertEqual(agent.fleetHome, "/Users/someone/.fleet-runner")
    }

    func testStateFolderPrecedenceMatchesTheService() {
        let agent = LaunchAgentInfo(plistPath: "/x.plist", nodePath: nil, scriptPath: nil, fleetHome: "/srv/agent-home")
        let home = root.path
        let plain = FleetDiscovery(userHome: home, environment: [:])
        XCTAssertEqual(plain.resolveHome(override: nil, launchAgent: nil).0, "\(home)/.the-fleet")
        XCTAssertEqual(plain.resolveHome(override: nil, launchAgent: agent).1, .launchAgent)
        let shell = FleetDiscovery(userHome: home, environment: ["FLEET_RUNNER_HOME": "~/legacy"])
        XCTAssertEqual(shell.resolveHome(override: nil, launchAgent: agent).0, "\(home)/legacy", "a terminal launch follows the shell like the CLI")
        XCTAssertEqual(shell.resolveHome(override: "~/chosen", launchAgent: agent).0, "\(home)/chosen")
        XCTAssertEqual(shell.resolveHome(override: "  ", launchAgent: agent).1, .environment, "a blank setting means discover")
    }

    func testOldHomePreferenceFollowsOnlyACompletedMigration() throws {
        let old = root.appendingPathComponent(".fleet-runner").path
        let current = root.appendingPathComponent(".the-fleet")
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        let record = current.appendingPathComponent("state-migration.json")
        let discovery = FleetDiscovery(userHome: root.path, environment: [:])
        func write(_ phase: String) throws {
            try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "source": old, "destination": current.path, "phase": phase]).write(to: record)
        }
        try write("prepared")
        XCTAssertEqual(discovery.resolveHome(override: old, launchAgent: nil).0, old)
        try write("complete")
        XCTAssertEqual(discovery.resolveHome(override: old, launchAgent: nil).0, current.path)
        XCTAssertEqual(discovery.resolveHome(override: root.appendingPathComponent("custom").path, launchAgent: nil).0, root.appendingPathComponent("custom").path)
    }

    func testFindsTheRealScriptBehindAnNpmLink() throws {
        let script = try makePackage("repo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("bin/the-fleet").path, withDestinationPath: script)
        XCTAssertEqual(FleetDiscovery.fleetScript(at: root.appendingPathComponent("bin/the-fleet").path), (script as NSString).resolvingSymlinksInPath)
        XCTAssertEqual(FleetDiscovery.fleetScript(at: root.appendingPathComponent("repo/bin/fleet-runner.js").path), (script as NSString).resolvingSymlinksInPath,
                       "the legacy name leads to the same client")
        XCTAssertEqual(FleetDiscovery.packageVersion(script: script), "0.3.0")
        let other = try makePackage("other", name: "something-else")
        XCTAssertNil(FleetDiscovery.fleetScript(at: other), "only The Fleet's own package is trusted to start its service")
    }

    func testFindsTheInstalledCommandAndTheNewestNvmNode() throws {
        let script = try makePackage("repo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".local/bin"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent(".local/bin/the-fleet").path, withDestinationPath: script)
        try makeExecutable(".nvm/versions/node/v22.18.0/bin/node")
        try makeExecutable(".nvm/versions/node/v24.22.1/bin/node")
        try makeExecutable(".nvm/versions/node/v9.11.2/bin/node")
        let discovery = FleetDiscovery(userHome: root.path, environment: ["PATH": "/nonexistent"])
        let core = try XCTUnwrap(discovery.locateCore(nodeOverride: nil, scriptOverride: nil, launchAgent: nil))
        XCTAssertEqual(core.source, "Installed command")
        XCTAssertEqual(core.scriptPath, (script as NSString).resolvingSymlinksInPath)
        XCTAssertEqual(core.version, "0.3.0")
        let versions = discovery.nodeCandidates().filter { $0.contains("/.nvm/") }
            .map { URL(fileURLWithPath: $0).deletingLastPathComponent().deletingLastPathComponent().lastPathComponent }
        XCTAssertEqual(versions, ["v24.22.1", "v22.18.0", "v9.11.2"], "nvm installs are tried newest first")
    }

    func testTheLoginServicesOwnNodeAndScriptArePreferred() throws {
        let script = try makePackage("installed")
        try makeExecutable("node-for-service/node")
        let agent = LaunchAgentInfo(plistPath: "/x.plist", nodePath: root.appendingPathComponent("node-for-service/node").path, scriptPath: script, fleetHome: nil)
        let core = try XCTUnwrap(FleetDiscovery(userHome: root.path, environment: [:]).locateCore(nodeOverride: nil, scriptOverride: nil, launchAgent: agent))
        XCTAssertEqual(core.source, "Login service")
        XCTAssertEqual(core.nodePath, agent.nodePath)
        XCTAssertNil(FleetDiscovery(userHome: root.path, environment: [:]).locateCore(nodeOverride: "/nonexistent/node", scriptOverride: script, launchAgent: agent),
                     "an explicit Node that isn't there is reported, not silently replaced")
    }

    func testTheServiceStartsWithNodeOnPathAndTheChosenFolder() {
        let core = CoreInstallation(nodePath: "/opt/node/bin/node", scriptPath: "/opt/fleet/bin/the-fleet.js", version: nil, source: "test")
        let environment = ServiceLauncher.environment(for: core, home: "/tmp/home", base: ["PATH": "/usr/bin:/bin", "AGENT_BRIDGE_HOME": "/tmp/bridge"])
        XCTAssertEqual(environment["PATH"]?.split(separator: ":").first, "/opt/node/bin")
        XCTAssertEqual(environment["PATH"]?.components(separatedBy: ":").filter { $0 == "/usr/bin" }.count, 1)
        XCTAssertEqual(environment["THE_FLEET_HOME"], "/tmp/home")
        XCTAssertEqual(environment["AGENT_BRIDGE_HOME"], "/tmp/bridge", "the pairing location set for the app reaches the service")
    }
}
