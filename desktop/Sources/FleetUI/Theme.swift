// Visual language: each worker is an equipment faceplate — anodised aluminium
// in light mode, graphite in dark — with an engraved nameplate and one activity
// LED per CPU core. Status colours follow airfield lighting: threshold green
// (cleared), taxiway blue (moving), hold-short amber (held) and stop-bar red.

import SwiftUI
import AppKit
import FleetKit

public enum FleetPalette {
    static func dynamic(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let value = isDark ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                           blue: CGFloat(value & 0xFF) / 255, alpha: isDark ? darkAlpha : lightAlpha)
        })
    }

    public static let cleared = dynamic(light: 0x1E9A58, dark: 0x3CCB7F)
    public static let taxiway = dynamic(light: 0x2462D6, dark: 0x5E96FF)
    public static let hold = dynamic(light: 0xB06A00, dark: 0xF4AE42)
    public static let stop = dynamic(light: 0xC8372D, dark: 0xF2655C)
    public static let idle = dynamic(light: 0x868D97, dark: 0x7F8792)

    static let plateTop = dynamic(light: 0xF8F9FB, dark: 0x2B2F36)
    static let plateBottom = dynamic(light: 0xE8EBEF, dark: 0x202328)
    static let plateEdge = dynamic(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.10, darkAlpha: 0.09)
    static let plateHighlight = dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, lightAlpha: 0.9, darkAlpha: 0.06)
    static let well = dynamic(light: 0xDCE0E6, dark: 0x16181C)
    static let wellEdge = dynamic(light: 0x000000, dark: 0x000000, lightAlpha: 0.08, darkAlpha: 0.45)
    static let ledOff = dynamic(light: 0xC9CED5, dark: 0x343941)
    static let engraving = dynamic(light: 0x5B6370, dark: 0x9BA3AE)

    public static func color(for condition: WorkerCondition) -> Color {
        switch condition {
        case .available: return cleared
        case .running: return taxiway
        case .reserved, .busy: return hold
        case .unavailable, .unreachable: return stop
        case .checking, .dispatcher: return idle
        }
    }

    enum Lamp: Equatable { case cleared, taxiway, hold, stop, idle }

    /// A run's verdict is green or amber: failing tests are a valid result.
    /// Work that never reached a verdict (cancelled, aborted by a source
    /// change, refused) is grey. Red is kept for The Fleet's own errors.
    static func lamp(forOutcome outcome: String) -> Lamp {
        switch outcome {
        case "passed": return .cleared
        case "running": return .taxiway
        case "failed", "timed-out": return .hold
        case "error": return .stop
        default: return .idle
        }
    }

    public static func color(forOutcome outcome: String) -> Color {
        switch lamp(forOutcome: outcome) {
        case .cleared: return cleared
        case .taxiway: return taxiway
        case .hold: return hold
        case .stop: return stop
        case .idle: return idle
        }
    }

    public static func color(forPressure pressure: MemoryPressure?) -> Color {
        switch pressure {
        case .critical: return stop
        case .elevated: return hold
        default: return cleared
        }
    }
}

extension Font {
    /// Engraved nameplate: SF Pro Expanded, used for names and headlines only.
    static func nameplate(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight).width(.expanded)
    }

    static let eyebrow = Font.system(size: 10, weight: .semibold).width(.expanded)

    static func data(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// Outcome names for finished runs and the live state of operations.
enum OutcomeText {
    static func title(_ outcome: String) -> String {
        switch outcome {
        case "passed": return "Passed"
        case "failed": return "Failed"
        case "timed-out": return "Timed out"
        case "cancelled": return "Cancelled"
        case "aborted": return "Aborted"
        case "refused": return "Refused"
        case "error": return "Error"
        case "running": return "Running"
        default: return outcome.capitalized
        }
    }

    /// What an outcome means, shown when hovering its badge.
    static func help(_ outcome: String) -> String? {
        switch outcome {
        case "failed": return "The job ran and its checks failed."
        case "timed-out": return "The job ran past its time limit."
        case "cancelled": return "Cancelled before it finished."
        case "aborted": return "Source changed before the job started, so nothing ran."
        case "refused": return "No ship accepted the job, so nothing ran."
        case "error": return "The Fleet couldn't run, verify or clean up this job."
        default: return nil
        }
    }

    /// An operation's outcome: the service's once it reports one, otherwise
    /// named from the exit code, as older services left it.
    static func outcome(running: Bool, reported: String?, exitCode: Int?) -> String {
        running ? "running" : (reported ?? outcome(forExitCode: exitCode))
    }

    /// The same mapping as the service's `outcomeForExitCode`, for a finished
    /// operation the service hasn't named.
    static func outcome(forExitCode code: Int?) -> String {
        switch code {
        case 0: return "passed"
        case 1: return "failed"
        case 6: return "timed-out"
        case 7: return "cancelled"
        case 3, 4: return "refused"
        default: return "error"
        }
    }

    /// A worker's recent job, named by its receipt when this Mac has one,
    /// otherwise as the service names the worker's reason. The worker's record
    /// alone can't tell a source-change abort from a failed upload, so anything
    /// it can't name stays an error.
    static func outcome(of job: RemoteJob, recorded: String?) -> String {
        if let recorded { return recorded }
        switch job.reason {
        case "completed": return ["0", "-", ""].contains(job.exitCode) ? "passed" : "failed"
        case "timeout": return "timed-out"
        case "cancelled", "disconnected": return "cancelled"
        default: return "error"
        }
    }

    /// The line under a finished operation: its exit code's meaning, or the
    /// outcome's own when the code alone would mislead, such as exit 2 for a
    /// source-change abort.
    static func meaning(of outcome: String, exitCode: Int?) -> String? {
        guard let exitCode else { return nil }
        return outcome == Self.outcome(forExitCode: exitCode) ? ExitMeaning.title(exitCode) : help(outcome)
    }
}
