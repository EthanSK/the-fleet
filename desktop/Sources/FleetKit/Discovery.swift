// Finds the one local The Fleet installation this app should talk to.
//
// An app opened from the Dock gets a minimal environment: no shell PATH, no
// nvm, usually no THE_FLEET_HOME. The login service written by
// `the-fleet service install` records the exact Node, script and state folder
// the service uses, so it is preferred after an explicit app setting. Nothing
// here copies configuration; it only locates the shared service and its CLI.

import Foundation

public enum HomeSource: String, Sendable, Equatable {
    case appSetting, environment, launchAgent, standard

    public var title: String {
        switch self {
        case .appSetting: return "Set in Settings"
        case .environment: return "From THE_FLEET_HOME"
        case .launchAgent: return "From the login service"
        case .standard: return "Default folder"
        }
    }
}

/// The per-user LaunchAgent written by `the-fleet service install`.
public struct LaunchAgentInfo: Sendable, Equatable {
    public static let label = "org.the-fleet.service"
    public let plistPath: String
    public let nodePath: String?
    public let scriptPath: String?
    public let fleetHome: String?
}

/// Node plus The Fleet's real `bin/the-fleet.js`, used only to start the shared service.
public struct CoreInstallation: Sendable, Equatable {
    public let nodePath: String
    public let scriptPath: String
    public let version: String?
    public let source: String
}

public struct FleetLocations: Sendable, Equatable {
    public let home: String
    public let homeSource: HomeSource
    public let launchAgent: LaunchAgentInfo?
    public let core: CoreInstallation?

    public var socketPath: String { (home as NSString).appendingPathComponent("service.sock") }
    public var serviceLog: String { (home as NSString).appendingPathComponent("service.log") }
}

public struct FleetDiscovery: Sendable {
    public let userHome: String
    public let environment: [String: String]

    public init(userHome: String = NSHomeDirectory(), environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.userHome = userHome
        self.environment = environment
    }

    public var launchAgentPath: String {
        "\(userHome)/Library/LaunchAgents/\(LaunchAgentInfo.label).plist"
    }

    public func locations(homeOverride: String?, nodeOverride: String?, scriptOverride: String?) -> FleetLocations {
        let agent = launchAgent()
        let (home, source) = resolveHome(override: homeOverride, launchAgent: agent)
        return FleetLocations(home: home, homeSource: source, launchAgent: agent,
                              core: locateCore(nodeOverride: nodeOverride, scriptOverride: scriptOverride, launchAgent: agent))
    }

    public func launchAgent() -> LaunchAgentInfo? {
        guard let data = FileManager.default.contents(atPath: launchAgentPath),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
        return Self.parseLaunchAgent(plist, path: launchAgentPath)
    }

    /// ProgramArguments are `python3 service-lock.py <node> <bin/the-fleet.js> service serve`.
    public static func parseLaunchAgent(_ plist: [String: Any], path: String) -> LaunchAgentInfo {
        let arguments = plist["ProgramArguments"] as? [String] ?? []
        var node: String?, script: String?
        if let index = arguments.firstIndex(where: { $0.hasSuffix("/the-fleet.js") || $0.hasSuffix("/fleet-runner.js") }) {
            script = arguments[index]
            if index > 0, !arguments[index - 1].hasSuffix(".py") { node = arguments[index - 1] }
        }
        let environment = plist["EnvironmentVariables"] as? [String: String]
        let home = environment?["THE_FLEET_HOME"] ?? environment?["FLEET_RUNNER_HOME"]
        return LaunchAgentInfo(plistPath: path, nodePath: node, scriptPath: script, fleetHome: home?.isEmpty == true ? nil : home)
    }

    public func expand(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "~" { return userHome }
        if trimmed.hasPrefix("~/") { return userHome + trimmed.dropFirst(1) }
        return trimmed
    }

    private func normalized(_ path: String) -> String {
        (expand(path) as NSString).standardizingPath
    }

    /// Same precedence as the CLI, with an explicit app setting first and the
    /// login service before the default when the app has no shell environment.
    public func resolveHome(override: String?, launchAgent: LaunchAgentInfo?) -> (String, HomeSource) {
        if let override, !override.trimmingCharacters(in: .whitespaces).isEmpty { return (migratedHome(normalized(override)), .appSetting) }
        if let value = environment["THE_FLEET_HOME"] ?? environment["FLEET_RUNNER_HOME"], !value.isEmpty { return (migratedHome(normalized(value)), .environment) }
        if let value = launchAgent?.fleetHome { return (migratedHome(normalized(value)), .launchAgent) }
        let current = "\(userHome)/.the-fleet", old = "\(userHome)/.fleet-runner"
        return (FileManager.default.fileExists(atPath: current) ? current : FileManager.default.fileExists(atPath: old) ? old : current, .standard)
    }

    /// The canonical migration receipt redirects an old app preference. This
    /// reads the shared state; it never copies or creates another state folder.
    private func migratedHome(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        guard url.lastPathComponent == ".fleet-runner" else { return path }
        let current = url.deletingLastPathComponent().appendingPathComponent(".the-fleet")
        guard let data = try? Data(contentsOf: current.appendingPathComponent("state-migration.json")),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              record["schemaVersion"] as? Int == 1, record["phase"] as? String == "complete",
              record["source"] as? String == path, record["destination"] as? String == current.path else { return path }
        return current.path
    }

    public func locateCore(nodeOverride: String?, scriptOverride: String?, launchAgent: LaunchAgentInfo?) -> CoreInstallation? {
        let chosenNode = nodeOverride.map(expand).flatMap { $0.isEmpty ? nil : $0 }
        func node(preferred: String?) -> String? {
            if let chosenNode { return isExecutable(chosenNode) ? chosenNode : nil }
            if let preferred, isExecutable(preferred) { return preferred }
            return nodeCandidates().first(where: isExecutable)
        }
        if let script = scriptOverride.map(expand), !script.isEmpty {
            guard let resolved = Self.fleetScript(at: script), let nodePath = node(preferred: launchAgent?.nodePath) else { return nil }
            return CoreInstallation(nodePath: nodePath, scriptPath: resolved, version: Self.packageVersion(script: resolved), source: "Settings")
        }
        if let script = launchAgent?.scriptPath, let resolved = Self.fleetScript(at: script), let nodePath = node(preferred: launchAgent?.nodePath) {
            return CoreInstallation(nodePath: nodePath, scriptPath: resolved, version: Self.packageVersion(script: resolved), source: "Login service")
        }
        for candidate in commandCandidates() {
            if let resolved = Self.fleetScript(at: candidate), let nodePath = node(preferred: nil) {
                return CoreInstallation(nodePath: nodePath, scriptPath: resolved, version: Self.packageVersion(script: resolved), source: "Installed command")
            }
        }
        return nil
    }

    private var pathDirectories: [String] {
        (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { $0.hasPrefix("/") }
    }

    func commandCandidates() -> [String] {
        unique(pathDirectories + ["\(userHome)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(userHome)/bin"]).map { "\($0)/the-fleet" }
    }

    /// Common Node installs, newest nvm version first.
    func nodeCandidates() -> [String] {
        let nvmRoot = "\(userHome)/.nvm/versions/node"
        let nvm = ((try? FileManager.default.contentsOfDirectory(atPath: nvmRoot)) ?? [])
            .compactMap { name -> (String, [Int])? in
                let parts = name.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").compactMap { Int($0) }
                return parts.count == 3 ? (name, parts) : nil
            }
            .sorted { $1.1.lexicographicallyPrecedes($0.1) }
            .map { "\(nvmRoot)/\($0.0)/bin" }
        let directories = pathDirectories + ["/opt/homebrew/bin", "/usr/local/bin"] + nvm
            + ["\(userHome)/.volta/bin", "\(userHome)/.local/share/fnm/aliases/default/bin", "\(userHome)/.asdf/shims", "/usr/bin"]
        return unique(directories).map { "\($0)/node" }
    }

    private func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    private func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    /// The real `bin/the-fleet.js` of a package named the-fleet, following links such as npm link's.
    public static func fleetScript(at path: String) -> String? {
        let resolved = (path as NSString).resolvingSymlinksInPath
        let bin = (resolved as NSString).deletingLastPathComponent
        let script: String
        if resolved.hasSuffix("/bin/the-fleet.js") { script = resolved }
        else if resolved.hasSuffix("/bin/fleet-runner.js") { script = "\(bin)/the-fleet.js" }
        else { return nil }
        guard FileManager.default.fileExists(atPath: script) else { return nil }
        let package = ((bin as NSString).deletingLastPathComponent as NSString).appendingPathComponent("package.json")
        guard let data = FileManager.default.contents(atPath: package),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              manifest["name"] as? String == "the-fleet" else { return nil }
        return script
    }

    public static func packageVersion(script: String) -> String? {
        let package = (((script as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent as NSString).appendingPathComponent("package.json")
        guard let data = FileManager.default.contents(atPath: package),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return manifest["version"] as? String
    }
}
