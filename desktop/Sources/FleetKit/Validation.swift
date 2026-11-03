// Form checks mirroring src/schema/machines.ts so problems show while typing.
// The service re-validates every save with the real parser; these never relax it.

import Foundation

public enum FleetValidation {
    static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    public static func workerNameProblem(_ name: String, existing: [String]) -> String? {
        if name.isEmpty { return "Name the worker." }
        if !matches(name, "^[a-z0-9][a-z0-9-]{0,47}$") { return "Use up to 48 lowercase letters, digits or hyphens, starting with a letter or digit." }
        if existing.contains(where: { $0.lowercased() == name }) { return "A worker or alias already uses this name." }
        return nil
    }

    /// "Mac-Mini" → "mac-mini"; "Old MacBook Pro" → "old-macbook-pro".
    public static func suggestedWorkerName(from target: String, existing: [String]) -> String {
        var base = target.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
            .replacingOccurrences(of: "--+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        base = String(base.filter { $0.isASCII }.prefix(40))
        if base.isEmpty || !matches(base, "^[a-z0-9]") { base = "worker" }
        let taken = Set(existing.map { $0.lowercased() })
        if !taken.contains(base) { return base }
        var index = 2
        while taken.contains("\(base)-\(index)") { index += 1 }
        return "\(base)-\(index)"
    }

    public static func remoteRootProblem(_ path: String) -> String? {
        if !matches(path, "^(~/|/)[^\\x00\\n:]*\\.noindex$") { return "Use an absolute or ~/ folder ending in .noindex, such as ~/FleetRunner.noindex." }
        if path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) { return "Remove . and .. from the folder." }
        if path == "~/.noindex" || path == "/.noindex" { return "Give the folder a name before .noindex." }
        return nil
    }

    public static func aliasProblem(_ alias: String) -> String? {
        matches(alias, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") ? nil : "Use letters, digits, “.”, “_” or “-”, like an Agent Bridge name."
    }

    public static func pathEntryProblem(_ entry: String) -> String? {
        matches(entry, "^(/|~/)[^:\\n]*$") ? nil : "Use an absolute or ~/ folder without “:”."
    }

    public static func envNameProblem(_ name: String) -> String? {
        if !matches(name, "^[A-Za-z_][A-Za-z0-9_]*$") { return "Use letters, digits and underscores, not starting with a digit." }
        if name == "PATH" { return "Add folders to PATH additions instead." }
        if name.hasPrefix("FLEET_RUNNER_") { return "FLEET_RUNNER_ variables are set by The Fleet." }
        return nil
    }

    public static func processNameProblem(_ name: String) -> String? {
        matches(name, "^[A-Za-z0-9._+-]+$") ? nil : "Use a process name without paths or spaces."
    }

    public static func limitProblems(_ limits: WorkerLimits) -> [String] {
        var problems: [String] = []
        if limits.minFreeDiskGiB < 0 { problems.append("Free disk can't be negative.") }
        if limits.minAvailableMemoryGiB < 0 { problems.append("Available memory can't be negative.") }
        if !(1...500).contains(limits.keepJobs) { problems.append("Keep 1–500 finished job folders.") }
        if !(1...240).contains(limits.uploadTimeoutMinutes) { problems.append("Upload time limit must be 1–240 minutes.") }
        if !(1...600).contains(limits.terminateGraceSeconds) { problems.append("Stop grace must be 1–600 seconds.") }
        if let bad = limits.heavyProcessNames.first(where: { processNameProblem($0) != nil }) { problems.append("“\(bad)” isn't a process name.") }
        return problems
    }
}
