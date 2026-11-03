// Starts the shared service when nothing is listening, by running the
// installed CLI's own auto-start (`the-fleet service status`). That path holds
// the permanent kernel lock, so concurrent starts from this app, the CLI,
// Agent Bridge or launchd still produce exactly one coordinator. The service
// runs detached from this app: quitting the app never stops it or its jobs.

import Foundation

public enum ServiceLauncher {
    public struct Failure: Error, LocalizedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// The environment for the CLI: the app's own, plus Node's folder and the
    /// standard tool folders on PATH, and the chosen state folder.
    public static func environment(for core: CoreInstallation, home: String, base: [String: String]) -> [String: String] {
        var environment = base
        let nodeDirectory = (core.nodePath as NSString).deletingLastPathComponent
        let existing = (base["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        environment["PATH"] = ([nodeDirectory] + existing + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        environment["THE_FLEET_HOME"] = home
        return environment
    }

    public static func start(core: CoreInstallation, home: String, base: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 40) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try run(core: core, home: home, base: base, timeout: timeout)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ chunk: Data) { lock.lock(); data.append(chunk); lock.unlock() }
        var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    }

    static func run(core: CoreInstallation, home: String, base: [String: String], timeout: TimeInterval) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: core.nodePath)
        process.arguments = [core.scriptPath, "service", "status"]
        process.environment = environment(for: core, home: home, base: base)
        process.currentDirectoryURL = URL(fileURLWithPath: base["HOME"] ?? NSHomeDirectory())
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let collected = Collected()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collected.append(chunk) }
        }
        do { try process.run() } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            throw Failure(message: "Couldn't run Node at \(core.nodePath): \(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if process.isRunning {
            process.terminate()
            pipe.fileHandleForReading.readabilityHandler = nil
            throw Failure(message: "The Fleet took too long to start. Check \((home as NSString).appendingPathComponent("service.log")).")
        }
        Thread.sleep(forTimeInterval: 0.1)
        pipe.fileHandleForReading.readabilityHandler = nil
        let output = collected.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0 else {
            throw Failure(message: output.isEmpty ? "The Fleet didn't start (exit \(process.terminationStatus))." : output)
        }
        return output
    }
}
