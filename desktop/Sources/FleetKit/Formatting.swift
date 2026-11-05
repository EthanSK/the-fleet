// Display formatting shared by every view. Memory uses binary units like
// Activity Monitor; disk uses decimal units like Finder.

import Foundation

public enum FleetFormat {
    public static func memory(_ bytes: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes.rounded()), countStyle: .memory)
    }

    public static func disk(_ bytes: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes.rounded()), countStyle: .file)
    }

    /// "45s", "3m 12s", "1h 04m".
    public static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        if minutes < 60 { return "\(minutes)m \(String(format: "%02d", total % 60))s" }
        return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m"
    }

    /// "just now", "12s ago", "4m ago", "3h ago", "2d ago".
    public static func ago(_ date: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }

    /// Time today, or a short date for earlier days.
    public static func moment(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }

    public static func load(_ value: Double) -> String {
        String(format: value >= 10 ? "%.1f" : "%.2f", value)
    }

    public static func minutes(_ value: Double) -> String {
        if value < 1 { return "\(Int((value * 60).rounded()))s" }
        let rounded = (value * 10).rounded() / 10
        return rounded == rounded.rounded() ? "\(Int(rounded))m" : "\(rounded)m"
    }

    /// Abbreviates the user's home folder to ~.
    public static func path(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    /// A shell-readable command, quoting only words that need it.
    public static func command(_ argv: [String]) -> String {
        argv.map { word in
            if !word.isEmpty, word.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || "-_./=:@%+,".unicodeScalars.contains($0) }) { return word }
            return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }.joined(separator: " ")
    }

    public static func plural(_ count: Int, _ singular: String, _ pluralForm: String? = nil) -> String {
        "\(count) \(count == 1 ? singular : (pluralForm ?? singular + "s"))"
    }
}

/// One LED per CPU core, lit to the current one-minute load.
public struct CoreLoad: Sendable, Equatable {
    public let cores: Int
    public let load: Double
    public let lit: Int
    /// Runnable work beyond the core count, shown as +N.
    public let overflow: Int

    public init(load: Double, cores: Int) {
        let cores = max(1, cores)
        let safeLoad = load.isFinite ? max(0, load) : 0
        self.cores = cores
        self.load = safeLoad
        self.lit = min(cores, Int(safeLoad.rounded()))
        self.overflow = max(0, Int((safeLoad - Double(cores)).rounded()))
    }

    public var fraction: Double { min(1, load / Double(cores)) }
}

public enum MemoryPressure: Sendable, Equatable {
    case normal, elevated, critical

    public init?(level: Int?) {
        guard let level else { return nil }
        self = level >= 4 ? .critical : level >= 2 ? .elevated : .normal
    }

    public var title: String {
        switch self {
        case .normal: return "Normal"
        case .elevated: return "Elevated"
        case .critical: return "Critical"
        }
    }
}

/// CLI exit codes (src/errors.ts), named for finished operations.
public enum ExitMeaning {
    public static func title(_ code: Int) -> String {
        switch code {
        case 0: return "Passed"
        case 1: return "Failed"
        case 2: return "Invalid request or settings"
        case 3: return "Ship check refused"
        case 4: return "No ship available"
        case 5: return "Connection or upload failed"
        case 6: return "Timed out"
        case 7: return "Cancelled"
        case 8: return "Outputs failed verification"
        default: return "Exit \(code)"
        }
    }
}
