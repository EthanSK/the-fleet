// What a worker is doing, derived from the coordinator's own observation.
// The coordinator decides availability; this only explains it. Precedence
// follows what blocks new work first: no answer, this Mac, a running job, a
// stale lock, a reservation, then the coordinator's admission findings.

import Foundation

public enum WorkerCondition: String, Sendable, Equatable, CaseIterable {
    case checking
    case available
    case running
    case reserved
    /// Not taking work because other heavy work (another chat's build) is running.
    case busy
    case unavailable
    case unreachable
    /// The coordinator's own computer, which never takes its own work.
    case dispatcher

    public var title: String {
        switch self {
        case .checking: return "Checking"
        case .available: return "Available"
        case .running: return "Running"
        case .reserved: return "Reserved"
        case .busy: return "Busy"
        case .unavailable: return "Unavailable"
        case .unreachable: return "Unreachable"
        case .dispatcher: return "This Mac"
        }
    }

    /// Sort order for lists: things needing attention first, idle workers last.
    public var rank: Int {
        switch self {
        case .running: return 0
        case .reserved: return 1
        case .unavailable: return 2
        case .unreachable: return 3
        case .busy: return 4
        case .available: return 5
        case .checking: return 6
        case .dispatcher: return 7
        }
    }
}

public struct CurrentJob: Sendable, Equatable {
    public let label: String
    public let jobID: String?
    public let startedAt: Date?
    public let owner: String?
    /// Set when this coordinator runs the job, so it can be cancelled by identity.
    public let operationID: String?
    /// The supervisor stopped but job processes remain.
    public let orphaned: Bool
}

public struct WorkerStatus: Sendable, Equatable {
    public let condition: WorkerCondition
    /// One line explaining the condition, when it needs one.
    public let detail: String?
    public let job: CurrentJob?
    public let reservation: Reservation?

    public static let dispatcherReason = "This is the dispatching computer."

    public static func derive(_ observation: WorkerObservation?, reservations: [Reservation], operations: [OperationSummary]) -> WorkerStatus {
        guard let observation else { return WorkerStatus(condition: .checking, detail: nil, job: nil, reservation: nil) }
        guard let health = observation.health else {
            return WorkerStatus(condition: .unreachable, detail: observation.reasons.first, job: nil, reservation: nil)
        }
        if observation.reasons.contains(dispatcherReason) {
            return WorkerStatus(condition: .dispatcher, detail: "Workers must be other computers.", job: nil, reservation: nil)
        }
        let leases = observation.assignments ?? reservations.filter { $0.machineId == observation.id }
        let reservation = observation.reservation ?? leases.first
        let managedLeases = leases.filter { $0.kind == "managed" }

        let exclusiveLock = health.lock.flatMap { $0.state == "busy" ? $0 : nil }
        if let lock = exclusiveLock ?? health.sharedLocks?.first(where: { $0.state == "busy" }) {
            // A shared lock may appear in a different order than its leases.
            // Never put a neighbour's cancel action on the displayed job.
            let managed = managedLeases.first { $0.jobId != nil && $0.jobId == lock.jobId }
                ?? (exclusiveLock != nil && managedLeases.count == 1 && managedLeases.first?.jobId == nil ? managedLeases.first : nil)
            let operation = managed.flatMap { lease in operations.first { $0.id == lease.id } }
            let label = lock.label.flatMap { $0 == "-" ? nil : $0 } ?? managed?.label ?? lock.jobId ?? "Job"
            let job = CurrentJob(label: label, jobID: lock.jobId == "-" ? nil : lock.jobId,
                                 startedAt: lock.startedEpoch.map { Date(timeIntervalSince1970: $0) },
                                 owner: managed?.owner ?? (exclusiveLock != nil && reservation?.kind == "external" ? reservation?.owner : nil),
                                 operationID: operation?.isRunning == true ? operation?.id : nil, orphaned: lock.orphaned == true)
            let detail = job.orphaned ? "Its supervisor stopped, but the job's processes are still running." : nil
            return WorkerStatus(condition: .running, detail: detail, job: job, reservation: reservation)
        }
        if let lock = (health.lock.flatMap { $0.state == "stale" ? $0 : nil }) ?? health.sharedLocks?.first(where: { $0.state == "stale" }) {
            return WorkerStatus(condition: .unavailable, detail: "Stale lock from job \(lock.jobId ?? "unknown"). Its processes have exited.", job: nil, reservation: reservation)
        }
        if let reservation {
            if reservation.kind == "managed", reservation.state == "active" {
                let operation = operations.first { $0.id == reservation.id }
                let job = CurrentJob(label: reservation.label, jobID: nil, startedAt: FleetDate.parse(reservation.createdAt), owner: reservation.owner,
                                     operationID: operation?.isRunning == true ? operation?.id : nil, orphaned: false)
                return WorkerStatus(condition: .running, detail: "Starting", job: job, reservation: reservation)
            }
            let detail: String
            switch (reservation.kind, reservation.state) {
            case ("managed", _): detail = "A coordinated run's ownership wasn't confirmed released."
            case (_, "expired"): detail = "\(reservation.owner) stopped renewing. Ownership stays until they release it."
            case (_, "unverified"): detail = "Reserved before The Fleet restarted. Ownership stays until it is released."
            default: detail = "\(reservation.owner): \(reservation.label)"
            }
            return WorkerStatus(condition: .reserved, detail: detail, job: nil, reservation: reservation)
        }
        if observation.available {
            return WorkerStatus(condition: .available, detail: nil, job: nil, reservation: nil)
        }
        if let heavy = health.heavy, !heavy.isEmpty, observation.reasons.contains(where: { $0.contains("heavy work") }) {
            return WorkerStatus(condition: .busy, detail: "Other work: \(HeavyProcessSummary.text(heavy))", job: nil, reservation: nil)
        }
        return WorkerStatus(condition: .unavailable, detail: observation.reasons.first, job: nil, reservation: nil)
    }
}

public enum HeavyProcessSummary {
    /// "swift-frontend ×3, ld" — the same grouping the coordinator uses.
    public static func text(_ processes: [HeavyProcess]) -> String {
        var counts: [(String, Int)] = []
        for process in processes {
            if let index = counts.firstIndex(where: { $0.0 == process.name }) { counts[index].1 += 1 } else { counts.append((process.name, 1)) }
        }
        return counts.map { $0.1 > 1 ? "\($0.0) ×\($0.1)" : $0.0 }.joined(separator: ", ")
    }
}

public enum FleetDate {
    public static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
        return try? Date.ISO8601FormatStyle().parse(text)
    }
}
