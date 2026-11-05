// One worker in depth. Actions appear only where they are safe and real:
// coordinated runs can be cancelled by identity; locks this coordinator didn't
// start, orphaned processes and stale locks get the exact CLI command instead,
// because clearing them needs a person to check the worker first.

import SwiftUI
import FleetKit

struct WorkerDetailView: View {
    @Bindable var store: FleetStore
    let workerID: String
    @State private var confirmingCancel = false
    @State private var actionMessage: String?
    @State private var recovering = false

    var body: some View {
        if let worker = store.worker(workerID) {
            content(worker)
                .navigationTitle(worker.id)
                .toolbar {
                    ToolbarItemGroup {
                        RefreshButton(store: store)
                        Button {
                            store.sheet = .editWorker(worker.id)
                        } label: {
                            Label("Settings", systemImage: "slider.horizontal.3")
                        }
                        .help("Ship settings")
                        .disabled(worker.settings == nil)
                    }
                }
        } else {
            ContentUnavailableView {
                Label("No ship named \(workerID)", systemImage: "questionmark.square.dashed")
            } description: {
                Text("It may have been removed somewhere else.")
            } actions: {
                Button("Overview") { store.open(.overview) }
            }
        }
    }

    private func content(_ worker: WorkerItem) -> some View {
        FleetScroll {
            VStack(alignment: .leading, spacing: 16) {
                header(worker)
                if let actionMessage {
                    NoticeLine(text: actionMessage, symbol: "info.circle.fill", tint: FleetPalette.taxiway)
                }
                if let job = worker.status.job { nowCard(worker, job) }
                if worker.status.condition == .reserved, let reservation = worker.status.reservation { reservationCard(worker, reservation) }
                if worker.status.condition == .unavailable, worker.health?.lock?.state == "stale" { staleLockCard(worker) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                    if let health = worker.health { healthCard(worker, health) }
                    recentJobsCard(worker)
                    admissionCard(worker)
                    storageCard(worker)
                    connectionCard(worker)
                }
            }
            .padding(24)
            .frame(maxWidth: 1180, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Header

    private func header(_ worker: WorkerItem) -> some View {
        HStack(alignment: .top, spacing: 18) {
            DeviceGlyph(kind: worker.kind, size: 84)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(worker.id.uppercased()).font(.nameplate(26, weight: .bold)).tracking(1.6).textSelection(.enabled)
                    if worker.isDefault { Text("Default").font(.caption.weight(.medium)).foregroundStyle(.secondary) }
                }
                Text(worker.subtitle).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(identityChips(worker), id: \.self) { chip in
                        Text(chip).font(.data(11)).padding(.horizontal, 7).padding(.vertical, 2).recessed(cornerRadius: 6)
                    }
                }
                HStack(spacing: 10) {
                    StatusBadge(condition: worker.status.condition)
                    if let detail = worker.status.detail, worker.status.job == nil {
                        Text(detail).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .padding(.top, 4)
            }
            Spacer()
            if let observed = worker.observedAt {
                Text("Checked \(FleetFormat.ago(observed, now: store.now))").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .faceplate()
    }

    private func identityChips(_ worker: WorkerItem) -> [String] {
        guard let health = worker.health else { return [worker.kind.title] }
        return [health.cpuBrand, health.model, worker.systemName, health.arch].compactMap { $0 }
    }

    // MARK: Now

    private func nowCard(_ worker: WorkerItem, _ job: CurrentJob) -> some View {
        SectionCard(title: "Now") {
            VStack(alignment: .leading, spacing: 10) {
                StripLayout(tint: FleetPalette.taxiway) {
                    Text(job.label).font(.data(14, weight: .semibold)).textSelection(.enabled)
                    Text([job.owner.map { "by \($0)" }, job.jobID].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                } trailing: {
                    if let started = job.startedAt {
                        Text(FleetFormat.duration(store.now.timeIntervalSince(started))).font(.data(13))
                    }
                }
                if job.orphaned {
                    NoticeLine(text: "Its supervisor stopped, but the job's processes are still running. Stop them from Terminal after checking the ship:")
                    CommandBlock(command: "the-fleet cancel --machine \(worker.id)")
                } else if let operationID = job.operationID {
                    HStack(spacing: 10) {
                        NavigationLink(value: FleetRoute.operation(operationID)) { Text("Output") }
                        Button(role: .destructive) { confirmingCancel = true } label: { Text("Cancel run…") }
                            .disabled(store.operation(operationID)?.cancelRequested == true)
                    }
                    .confirmationDialog("Cancel \(job.label)?", isPresented: $confirmingCancel) {
                        Button("Cancel run", role: .destructive) {
                            Task {
                                do {
                                    try await store.cancel(operationID: operationID)
                                    actionMessage = "Cancelling \(job.label). \(worker.id) stops the job and cleans up."
                                } catch {
                                    actionMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                                }
                            }
                        }
                        Button("Keep running", role: .cancel) {}
                    } message: {
                        Text("\(worker.id) stops the job and cleans up. Its receipt records the cancellation.")
                    }
                } else {
                    Text("This job wasn't started through this service, so it can only be cancelled from Terminal:")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    CommandBlock(command: "the-fleet cancel --machine \(worker.id)")
                }
            }
        }
    }

    private func reservationCard(_ worker: WorkerItem, _ reservation: Reservation) -> some View {
        SectionCard(title: "Reservation") {
            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                    FactRow(label: "Owner", value: reservation.owner)
                    FactRow(label: "Work", value: reservation.label)
                    FactRow(label: "Kind", value: reservation.kind == "managed" ? "Coordinated run" : "Own SSH")
                    if let created = FleetDate.parse(reservation.createdAt) {
                        FactRow(label: "Since", value: "\(FleetFormat.moment(created, now: store.now)) (\(FleetFormat.ago(created, now: store.now)))")
                    }
                    if let expires = FleetDate.parse(reservation.expiresAt) {
                        FactRow(label: reservation.state == "active" ? "Renew by" : "Expired", value: FleetFormat.moment(expires, now: store.now))
                    }
                }
                if let detail = worker.status.detail { Text(detail).font(.callout).foregroundStyle(.secondary) }
                if reservation.kind == "managed" {
                    HStack(spacing: 10) {
                        Button("Recover…") { Task { await recover(worker) } }.disabled(recovering)
                        if recovering { ProgressView().controlSize(.small) }
                        Text("Clears it only after \(worker.id) is confirmed idle.").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Its owner releases it with its token once their work stops.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func recover(_ worker: WorkerItem) async {
        recovering = true
        defer { recovering = false }
        do {
            let released = try await store.recoverManagedReservations(workerID: worker.id)
            actionMessage = released.isEmpty
                ? "\(worker.id) isn't confirmed idle, so its ownership was kept."
                : "Released \(FleetFormat.plural(released.count, "reservation")) after confirming the ship is idle."
        } catch {
            actionMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func staleLockCard(_ worker: WorkerItem) -> some View {
        SectionCard(title: "Stale lock") {
            VStack(alignment: .leading, spacing: 8) {
                Text("A finished job left its lock. Locks are never cleared automatically: check its outputs, then clear it from Terminal.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                CommandBlock(command: "the-fleet lock clear --machine \(worker.id)")
            }
        }
    }

    // MARK: Health

    private func healthCard(_ worker: WorkerItem, _ health: WorkerHealth) -> some View {
        SectionCard(title: "Health") {
            VStack(alignment: .leading, spacing: 12) {
                if let cores = health.cpuCount, let loads = health.loadAverage, let first = loads.first {
                    VStack(alignment: .leading, spacing: 6) {
                        CoreStrip(reading: CoreLoad(load: first, cores: cores), tint: FleetPalette.color(for: worker.status.condition), height: 14)
                        Text(loadText(loads, cores: cores)).font(.data(11)).foregroundStyle(.secondary)
                    }
                }
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                    if let total = health.memTotalBytes, let available = health.memAvailableBytes {
                        FactRow(label: "Memory", value: "About \(FleetFormat.memory(available)) free of \(FleetFormat.memory(total))")
                    }
                    if let pressure = MemoryPressure(level: health.memPressureLevel) {
                        GridRow {
                            Text("Pressure").foregroundStyle(.secondary)
                            HStack(spacing: 6) {
                                StatusLamp(color: FleetPalette.color(forPressure: pressure), size: 7)
                                Text(pressure.title)
                            }
                        }
                    }
                    if let swap = health.swapUsedMiB, swap > 0 { FactRow(label: "Swap", value: FleetFormat.memory(swap * 1_048_576)) }
                    if let free = health.diskFreeBytes {
                        FactRow(label: "Disk", value: "\(FleetFormat.disk(free)) free\(worker.settings.map { " · needs \(GiB.text($0.limits.minFreeDiskGiB))" } ?? "")")
                    }
                    if let gui = health.guiSession {
                        FactRow(label: "Console", value: gui ? "\(health.user ?? "The ship's user") is signed in at the screen" : "No one signed in at the screen")
                    }
                    if let heavy = health.heavy, !heavy.isEmpty { FactRow(label: "Other work", value: HeavyProcessSummary.text(heavy)) }
                    if let missing = health.missingBaseTools, !missing.isEmpty { FactRow(label: "Missing", value: missing.joined(separator: ", ")) }
                    if health.rootExists == false { FactRow(label: "Remote folder", value: "Created on first run") }
                }
            }
        }
    }

    private func loadText(_ loads: [Double], cores: Int) -> String {
        let labels = ["1 min", "5 min", "15 min"]
        return zip(labels, loads).map { "\($0) \(FleetFormat.load($1))" }.joined(separator: " · ") + " · \(cores) cores"
    }

    private func recentJobsCard(_ worker: WorkerItem) -> some View {
        SectionCard(title: "Recent jobs") {
            let jobs = worker.observation?.recentJobs ?? []
            if jobs.isEmpty {
                Text(worker.health == nil ? "Shown once the ship answers." : "No finished jobs kept on this ship.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(jobs) { job in
                        let run = store.run(forJob: job.jobId)
                        let row = RecentJobRow(job: job, outcome: OutcomeText.outcome(of: job, recorded: run?.outcome), now: store.now)
                        if run != nil {
                            NavigationLink(value: FleetRoute.run(job.jobId)) { row }.buttonStyle(.plain)
                        } else {
                            row
                        }
                    }
                }
            }
        }
    }

    private func admissionCard(_ worker: WorkerItem) -> some View {
        SectionCard(title: "Admission") {
            let reasons = (worker.observation?.reasons ?? []).filter { $0 != WorkerStatus.dispatcherReason || worker.status.condition == .dispatcher }
            let warnings = worker.observation?.warnings ?? []
            VStack(alignment: .leading, spacing: 8) {
                if reasons.isEmpty && warnings.isEmpty {
                    Text(worker.observation == nil ? "Waiting for its first check." : "Takes new work. No warnings.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(reasons, id: \.self) { NoticeLine(text: $0, symbol: "hand.raised.fill", tint: FleetPalette.stop) }
                ForEach(warnings, id: \.self) { NoticeLine(text: $0) }
                if let limits = worker.settings?.limits {
                    Text("Refuses below \(GiB.text(limits.minFreeDiskGiB)) free disk or \(GiB.text(limits.minAvailableMemoryGiB)) available memory, \(PressurePolicy.sentence(limits.memoryPressure)).")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func storageCard(_ worker: WorkerItem) -> some View {
        if let observation = worker.observation, observation.jobsKiB != nil || !(observation.caches ?? []).isEmpty {
            SectionCard(title: "Storage") {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                    if let kib = observation.jobsKiB {
                        FactRow(label: "Job folders", value: "\(FleetFormat.disk(kib * 1024)) of logs, results and pending outputs")
                    }
                    ForEach(observation.caches ?? [], id: \.name) { cache in
                        FactRow(label: "Cache", value: "\(cache.name) · \(FleetFormat.disk(cache.kib * 1024))", monospaced: false)
                    }
                }
            }
        }
    }

    private func connectionCard(_ worker: WorkerItem) -> some View {
        SectionCard(title: "Connection") {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                if let settings = worker.settings {
                    FactRow(label: "Pairing", value: pairingText(settings.target))
                    if !settings.aliases.isEmpty { FactRow(label: "Aliases", value: settings.aliases.joined(separator: ", "), monospaced: true) }
                    FactRow(label: "Remote folder", value: settings.remoteRoot, monospaced: true)
                    if !settings.pathPrepend.isEmpty { FactRow(label: "PATH additions", value: settings.pathPrepend.joined(separator: "\n"), monospaced: true) }
                    if !settings.envNames.isEmpty { FactRow(label: "Environment", value: settings.envNames.joined(separator: ", ") + " (values hidden)", monospaced: true) }
                }
                if let health = worker.health {
                    if let user = health.user, let host = health.host { FactRow(label: "Signed in", value: "\(user) on \(host)", monospaced: true) }
                    if let bash = health.bashVersion { FactRow(label: "Bash", value: bash, monospaced: true) }
                    if let fingerprint = health.fingerprint { FactRow(label: "Identity", value: fingerprint, monospaced: true) }
                }
            }
        }
    }

    private func pairingText(_ target: String) -> String {
        guard let pairing = store.pairings?.targets.first(where: { $0.target.lowercased() == target.lowercased() }) else { return target }
        let route = pairing.route == "internet" ? "internet route" : "LAN"
        return [target, pairing.host.map { "\(pairing.user ?? "?")@\($0)" }, route].compactMap { $0 }.joined(separator: " · ")
    }
}

struct RecentJobRow: View {
    let job: RemoteJob
    let outcome: String
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(FleetPalette.color(forOutcome: outcome)).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(job.label.isEmpty ? job.jobId : job.label).font(.data(12, weight: .medium)).lineLimit(1)
                Text(reasonText).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                if let started = job.startedEpoch, let ended = job.endedEpoch {
                    Text(FleetFormat.duration(ended - started)).font(.data(11))
                }
                if let ended = job.endedEpoch {
                    Text(FleetFormat.ago(Date(timeIntervalSince1970: ended), now: now)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var reasonText: String {
        let exit = job.exitCode.isEmpty || job.exitCode == "-" ? nil : "exit \(job.exitCode)"
        switch job.reason {
        case "completed": return exit.map { "Completed, \($0)" } ?? "Completed"
        case "timeout": return "Timed out"
        case "cancelled": return "Cancelled"
        case "disconnected": return "Stopped when its connection dropped"
        case "aborted": return "Stopped before starting"
        case "abandoned": return "Cleared after its supervisor stopped"
        default: return [job.reason, exit].compactMap { $0 }.joined(separator: ", ")
        }
    }
}

enum GiB {
    static func text(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value)) GiB" : String(format: "%.1f GiB", value)
    }
}

enum PressurePolicy {
    static let options: [(String, String)] = [("refuse-critical", "Refuse when critical"), ("refuse-warn", "Refuse when elevated"), ("report-only", "Report only")]

    static func sentence(_ policy: String) -> String {
        switch policy {
        case "refuse-warn": return "or under elevated memory pressure"
        case "report-only": return "and only reports memory pressure"
        default: return "or under critical memory pressure"
        }
    }
}
