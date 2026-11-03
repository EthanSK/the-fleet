// Which kind of computer a worker is, for its icon. The worker's own reported
// model identifier wins; names are the fallback for workers not yet reached or
// models newer than this table. People can override the choice per worker.

import Foundation

public enum DeviceKind: String, CaseIterable, Sendable, Codable, Identifiable {
    case macMini
    case macBook
    case macStudio
    case iMac
    case macPro
    case mac
    case linux

    public var id: String { rawValue }

    /// SF Symbols available on macOS 14.
    public var symbolName: String {
        switch self {
        case .macMini: return "macmini"
        case .macBook: return "laptopcomputer"
        case .macStudio: return "macstudio"
        case .iMac: return "desktopcomputer"
        case .macPro: return "macpro.gen3"
        case .mac: return "desktopcomputer"
        case .linux: return "server.rack"
        }
    }

    public var title: String {
        switch self {
        case .macMini: return "Mac mini"
        case .macBook: return "MacBook"
        case .macStudio: return "Mac Studio"
        case .iMac: return "iMac"
        case .macPro: return "Mac Pro"
        case .mac: return "Mac"
        case .linux: return "Linux computer"
        }
    }

    // Apple silicon identifiers no longer name the product family.
    static let appleSiliconModels: [String: DeviceKind] = [
        "Mac14,3": .macMini, "Mac14,12": .macMini, "Mac16,10": .macMini, "Mac16,11": .macMini,
        "Mac13,1": .macStudio, "Mac13,2": .macStudio, "Mac14,13": .macStudio, "Mac14,14": .macStudio, "Mac15,14": .macStudio, "Mac16,9": .macStudio,
        "Mac14,8": .macPro,
        "Mac15,4": .iMac, "Mac15,5": .iMac, "Mac16,2": .iMac, "Mac16,3": .iMac,
        "Mac14,2": .macBook, "Mac14,15": .macBook, "Mac14,7": .macBook, "Mac14,5": .macBook, "Mac14,6": .macBook, "Mac14,9": .macBook, "Mac14,10": .macBook,
        "Mac15,3": .macBook, "Mac15,6": .macBook, "Mac15,7": .macBook, "Mac15,8": .macBook, "Mac15,9": .macBook, "Mac15,10": .macBook, "Mac15,11": .macBook,
        "Mac15,12": .macBook, "Mac15,13": .macBook, "Mac16,1": .macBook, "Mac16,5": .macBook, "Mac16,6": .macBook, "Mac16,7": .macBook, "Mac16,8": .macBook,
        "Mac16,12": .macBook, "Mac16,13": .macBook,
    ]

    public static func classify(model: String?, os: String?, names: [String]) -> DeviceKind {
        if os?.lowercased() == "linux" { return .linux }
        if let model, !model.isEmpty {
            if let known = appleSiliconModels[model] { return known }
            if model.hasPrefix("Macmini") { return .macMini }
            if model.hasPrefix("MacBook") { return .macBook }
            if model.hasPrefix("iMac") { return .iMac }
            if model.hasPrefix("MacPro") { return .macPro }
        }
        let text = names.joined(separator: " ").lowercased()
        if text.contains("mini") { return .macMini }
        if text.contains("studio") { return .macStudio }
        if text.contains("imac") { return .iMac }
        if ["macpro", "mac-pro", "mac pro", "mac_pro"].contains(where: text.contains) { return .macPro }
        if ["macbook", "laptop", "mbp", "mba", "book"].contains(where: text.contains) { return .macBook }
        if os?.lowercased() != "darwin", ["linux", "ubuntu", "debian", "fedora"].contains(where: text.contains) { return .linux }
        return .mac
    }
}
