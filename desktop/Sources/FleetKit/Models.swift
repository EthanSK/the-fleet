// JSON shapes of The Fleet's local API (src/service/*.ts owns them).
// Fields the service may omit are optional; timestamps stay ISO-8601 text and
// are parsed on demand so a new fractional-second format never breaks decoding.

import Foundation

public struct ServiceHealth: Codable, Sendable, Equatable {
    public let application: String
    public let protocolVersion: Int
    public let pid: Int
    /// Absent from services older than the structured worker/project/run API.
    public let version: String?
    public let startedAt: String?
}

// MARK: - Worker observations (/v1/state)

public struct FleetState: Codable, Sendable, Equatable {
    public let protocolVersion: Int
    public let coordinatorPid: Int
    public let observedAt: String
    public let workers: [WorkerObservation]
    public let reservations: [Reservation]
}

public struct WorkerObservation: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let aliases: [String]
    public let description: String?
    public let observedAt: String
    public let available: Bool
    public let reasons: [String]
    public let warnings: [String]
    public let health: WorkerHealth?
    public let recentJobs: [RemoteJob]?
    public let caches: [RemoteCache]?
    public let jobsKiB: Double?
    public let reservation: Reservation?
    /// All claims for the physical worker, including claims made through aliases.
    public let assignments: [Reservation]?
}

public struct WorkerHealth: Codable, Sendable, Equatable {
    public let complete: Bool
    public let os: String?
    public let arch: String?
    public let host: String?
    public let user: String?
    public let bashVersion: String?
    public let fingerprint: String?
    public let model: String?
    public let cpuBrand: String?
    public let osVersion: String?
    public let rootExists: Bool?
    public let diskFreeBytes: Double?
    public let memTotalBytes: Double?
    public let memAvailableBytes: Double?
    /// macOS memory pressure level: 1 normal, 2 elevated, 4 critical.
    public let memPressureLevel: Int?
    public let swapUsedMiB: Double?
    public let cpuCount: Int?
    public let loadAverage: [Double]?
    public let guiSession: Bool?
    public let bsdtar: Bool?
    public let missingBaseTools: [String]?
    public let tools: [String: Bool]?
    public let heavy: [HeavyProcess]?
    public let lock: LockState?
    public let sharedLocks: [LockState]?

    public init(complete: Bool = true, os: String? = nil, arch: String? = nil, host: String? = nil, user: String? = nil, bashVersion: String? = nil,
                fingerprint: String? = nil, model: String? = nil, cpuBrand: String? = nil, osVersion: String? = nil, rootExists: Bool? = true,
                diskFreeBytes: Double? = nil, memTotalBytes: Double? = nil, memAvailableBytes: Double? = nil, memPressureLevel: Int? = nil,
                swapUsedMiB: Double? = nil, cpuCount: Int? = nil, loadAverage: [Double]? = nil, guiSession: Bool? = nil, bsdtar: Bool? = true,
                missingBaseTools: [String]? = [], tools: [String: Bool]? = [:], heavy: [HeavyProcess]? = [], lock: LockState? = LockState(state: "free"), sharedLocks: [LockState]? = nil) {
        self.complete = complete; self.os = os; self.arch = arch; self.host = host; self.user = user; self.bashVersion = bashVersion
        self.fingerprint = fingerprint; self.model = model; self.cpuBrand = cpuBrand; self.osVersion = osVersion; self.rootExists = rootExists
        self.diskFreeBytes = diskFreeBytes; self.memTotalBytes = memTotalBytes; self.memAvailableBytes = memAvailableBytes
        self.memPressureLevel = memPressureLevel; self.swapUsedMiB = swapUsedMiB; self.cpuCount = cpuCount; self.loadAverage = loadAverage
        self.guiSession = guiSession; self.bsdtar = bsdtar; self.missingBaseTools = missingBaseTools; self.tools = tools; self.heavy = heavy; self.lock = lock
        self.sharedLocks = sharedLocks
    }
}

public struct HeavyProcess: Codable, Sendable, Equatable {
    public let pid: Int
    public let pgid: Int?
    public let rssKiB: Double?
    public let cpuPercent: Double?
    public let name: String
}

public struct LockState: Codable, Sendable, Equatable {
    /// "free", "busy" or "stale".
    public let state: String
    public let jobId: String?
    public let startedEpoch: Double?
    public let label: String?
    public let orphaned: Bool?

    public init(state: String, jobId: String? = nil, startedEpoch: Double? = nil, label: String? = nil, orphaned: Bool? = nil) {
        self.state = state; self.jobId = jobId; self.startedEpoch = startedEpoch; self.label = label; self.orphaned = orphaned
    }
}

public struct RemoteJob: Codable, Sendable, Equatable, Identifiable {
    public var id: String { jobId }
    public let jobId: String
    public let reason: String
    public let exitCode: String
    public let startedEpoch: Double?
    public let endedEpoch: Double?
    public let label: String
}

public struct RemoteCache: Codable, Sendable, Equatable {
    public let name: String
    public let kib: Double
}

public struct Reservation: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// Absent from old services and external clients using their own SSH.
    public let jobId: String?
    public let machineId: String
    public let fingerprint: String
    public let owner: String
    public let label: String
    /// "external" (an app using its own SSH) or "managed" (a coordinated run).
    public let kind: String
    public let createdAt: String
    public let expiresAt: String?
    /// "active", "expired" or "unverified".
    public let state: String
}

// MARK: - Worker settings (/v1/config, /v1/machines)

public struct WorkerLimits: Codable, Sendable, Equatable {
    public var minFreeDiskGiB: Double
    public var minAvailableMemoryGiB: Double
    /// "refuse-critical", "refuse-warn" or "report-only".
    public var memoryPressure: String
    public var heavyProcessNames: [String]
    /// "refuse" or "warn".
    public var heavyProcessAction: String
    public var keepJobs: Int
    public var uploadTimeoutMinutes: Double
    public var terminateGraceSeconds: Int
}

public struct WorkerSettings: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let description: String?
    public let target: String
    public let configPath: String?
    public let aliases: [String]
    public let remoteRoot: String
    public let pathPrepend: [String]
    /// Names only. Values never leave the service.
    public let envNames: [String]
    public let limits: WorkerLimits
    public let isDefault: Bool
}

public struct FleetConfiguration: Codable, Sendable, Equatable {
    public struct Controller: Codable, Sendable, Equatable {
        public let revision: String
        public let runsDirectory: String?
    }
    public struct Defaults: Codable, Sendable, Equatable {
        public let remoteRoot: String
        public let limits: WorkerLimits
    }
    public struct Paths: Codable, Sendable, Equatable {
        public let home: String
        public let machinesFile: String
        public let runsDirectory: String
    }
    public let revision: String
    public let defaultMachine: String?
    public let machines: [WorkerSettings]
    public let defaults: Defaults
    public let paths: Paths
    /// Older services lack the shared controller settings API.
    public var controller: Controller? = nil
}

public struct WorkerChange: Codable, Sendable, Equatable {
    public let revision: String
    public let machine: WorkerSettings
}

public struct WorkerRemoval: Codable, Sendable, Equatable {
    public let revision: String
    public let removed: String
    public let warnings: [String]
}

// MARK: - Agent Bridge pairings (/v1/pairings)

public struct PairingList: Codable, Sendable, Equatable {
    public let configPath: String
    public let found: Bool
    public let targets: [Pairing]
}

public struct Pairing: Codable, Sendable, Equatable, Identifiable {
    public var id: String { target }
    public let target: String
    public let usable: Bool
    /// "internet" (Tailscale or another internet_host) or "lan".
    public let route: String?
    public let host: String?
    public let user: String?
    public let port: Int?
    public let keyConfigured: Bool?
    public let problem: String?
    public let pairedAt: String?
    public let registeredAs: String?
}

public struct PairingCheck: Codable, Sendable, Equatable {
    public let target: String
    public let observedAt: String
    public let reachable: Bool
    public let health: WorkerHealth?
    public let error: String?
    public let dispatchingComputer: Bool
    public let sameAs: String?
}

// MARK: - Projects (/v1/projects)

public struct ProjectList: Codable, Sendable, Equatable {
    public let projects: [ProjectSummary]
    public let error: String?
}

public struct ProjectSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let manifestPath: String
    public let sourceRoot: String
    public let registeredAt: String
    public let description: String?
    public let defaultMachine: String?
    public let sends: [String]
    public let profiles: [ProfileSummary]
    public let localOnly: [LocalOnlyNote]
    public let error: String?
}

public struct ProfileSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String { name }
    public let name: String
    /// "test", "build" or "check".
    public let kind: String
    public let description: String
    public let blocked: String?
    public let command: [String]
    public let prepare: [[String]]
    public let timeoutMinutes: Double
    public let tools: [String]
    public let guiSession: Bool
    public let machineEnv: [String]
    public let artifacts: [String]
    public let allowExtraArgs: Bool
    public let success: String
}

public struct LocalOnlyNote: Codable, Sendable, Equatable, Hashable {
    public let command: String
    public let reason: String
}

public struct GitSnapshot: Codable, Sendable, Equatable {
    public let head: String?
    public let branch: String?
    public let staged: Int
    public let unstaged: Int
    public let untracked: Int
}

public struct RunPlan: Codable, Sendable, Equatable {
    public struct Source: Codable, Sendable, Equatable {
        public let root: String
        public let files: Int
        public let symlinks: Int
        public let bytes: Double
        public let digest: String
        public let git: GitSnapshot?
    }
    public struct Skipped: Codable, Sendable, Equatable, Hashable {
        public let path: String
        public let detail: String
    }
    public let project: String
    public let profile: String
    public let machine: String
    public let source: Source
    public let skipped: [Skipped]
    public let skippedCount: Int
    public let unmatchedIncludes: [String]
    public let command: [String]
    public let prepare: [[String]]
    public let timeoutMinutes: Double
    public let success: String
    public let artifacts: [String]
}

// MARK: - Operations (/v1/operations)

public struct OperationSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let owner: String
    /// "command", "submit" or "run".
    public let kind: String
    public let label: String
    public let project: String?
    public let profile: String?
    /// "running" or "complete".
    public let status: String
    public let exitCode: Int?
    public let createdAt: String
    public let finishedAt: String?
    public let detached: Bool
    public let cancelRequested: Bool
    public let jobIds: [String]
    public let machineId: String?
    public let lastLine: String?

    public var isRunning: Bool { status == "running" }
    /// Profile runs and one-time requests; other CLI commands are not work.
    public var isWork: Bool { project != nil }
}

public struct OperationList: Codable, Sendable, Equatable {
    public let operations: [OperationSummary]
}

public struct OperationOutput: Codable, Sendable, Equatable {
    public let id: String
    public let owner: String
    public let kind: String?
    public let label: String?
    public let project: String?
    public let profile: String?
    public let status: String
    public let exitCode: Int?
    public let createdAt: String?
    public let finishedAt: String?
    public let detached: Bool?
    public let cancelRequested: Bool?
    public let jobIds: [String]?
    public let machineId: String?
    public let output: String
    public let nextOffset: Int
    public let truncated: Bool
}

public struct OperationStarted: Codable, Sendable, Equatable {
    public let operationId: String
    public let operation: OperationSummary?
}

// MARK: - Finished runs (/v1/runs)

public struct RunList: Codable, Sendable, Equatable {
    public let runs: [RunSummary]
    public let runsDirectory: String
}

public struct RunSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String { jobId }
    public let jobId: String
    public let project: String
    public let profile: String
    public let profileKind: String?
    /// "passed", "failed", "timed-out", "cancelled", "refused" or "error".
    public let outcome: String
    public let summary: String
    public let machineId: String?
    public let requestedAt: String?
    public let finishedAt: String?
    public let jobSeconds: Double?
    public let totalSeconds: Double?
    public let testCount: Int?
    public let passed: Bool?
    public let artifacts: Int?
    public let missingArtifacts: Int?
    public let owner: String?
    public let operationId: String?
    /// False when the receipt was removed by retention or its run store is unavailable.
    public let available: Bool
    public let directory: String
}

public struct LogTail: Codable, Sendable, Equatable {
    public let text: String
    public let bytes: Double
    public let truncated: Bool
    public let present: Bool
}

public struct RunDetail: Codable, Sendable, Equatable {
    public struct Logs: Codable, Sendable, Equatable {
        public let stdout: LogTail
        public let stderr: LogTail
    }
    public let jobId: String
    public let available: Bool
    public let directory: String
    public let run: RunSummary
    public let receipt: Receipt?
    public let logs: Logs?
}

public struct Receipt: Codable, Sendable, Equatable {
    public struct Machine: Codable, Sendable, Equatable {
        public let id: String
        public let transport: String
        public let host: String?
        public let fingerprint: String?
    }
    public struct Source: Codable, Sendable, Equatable {
        public let root: String
        public let digest: String
        public let files: Int
        public let symlinks: Int
        public let bytes: Double
        public let git: GitSnapshot?
    }
    public struct Command: Codable, Sendable, Equatable {
        public let argv: [String]
        public let extraArgs: [String]
        public let prepare: [[String]]
        public let cwd: String
        public let envNames: [String]
        public let timeoutSeconds: Double
    }
    public struct Timing: Codable, Sendable, Equatable {
        public let requestedAt: String
        public let remoteStartedAt: String?
        public let remoteEndedAt: String?
        public let finishedAt: String
        public let jobSeconds: Double?
        public let totalSeconds: Double
    }
    public struct Remote: Codable, Sendable, Equatable {
        public let admission: String?
        public let reason: String?
        public let exitCode: Int?
        public let stragglersStopped: Bool
        public let processesRemaining: Bool
        public let lockReleased: Bool
        public let notes: [String]
    }
    public struct Check: Codable, Sendable, Equatable, Hashable {
        public let name: String
        public let passed: Bool
        public let detail: String
    }
    public struct Success: Codable, Sendable, Equatable {
        public let passed: Bool
        public let testCount: Int?
        public let checks: [Check]
    }
    public struct Artifact: Codable, Sendable, Equatable, Hashable {
        public let path: String
        public let sha256: String
        public let bytes: Double
    }
    public let jobId: String
    public let project: String
    public let profile: String
    public let profileKind: String
    public let outcome: String
    public let cliExitCode: Int
    public let summary: String
    public let machine: Machine
    public let source: Source
    public let command: Command
    public let timing: Timing
    public let remote: Remote
    public let success: Success
    public let artifacts: [Artifact]
    public let missingArtifacts: [String]
}

// MARK: - Errors returned by the service

public struct ServiceErrorBody: Codable, Sendable, Equatable {
    public let error: String
    public let code: String?
    public let exitCode: Int?
    public let details: [String]?
    public let revision: String?
}

public struct RecoveredReservations: Codable, Sendable, Equatable {
    public let released: [String]
}
