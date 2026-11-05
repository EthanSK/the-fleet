// One finished run from its durable receipt: what was sent, what ran, the
// success checks, verified outputs and the end of its logs.

import SwiftUI
import AppKit
import FleetKit

struct RunDetailView: View {
    let store: FleetStore
    let jobID: String
    @State private var detail: RunDetail?
    @State private var error: String?
    @State private var showingErrors = false

    var body: some View {
        Group {
            if let detail {
                content(detail)
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't open this run", systemImage: "doc.questionmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(detail.map { "\($0.run.project)/\($0.run.profile)" } ?? jobID)
        .task(id: jobID) { await load() }
        .toolbar {
            ToolbarItem {
                Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }.help("Reload this run")
            }
        }
    }

    private func load() async {
        do {
            detail = try await store.client.runDetail(jobID: jobID)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @ViewBuilder private func content(_ detail: RunDetail) -> some View {
        let run = detail.run
        FleetScroll {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(run.project)/\(run.profile)").font(.nameplate(22)).textSelection(.enabled)
                        if let kind = run.profileKind { KindChip(kind: kind) }
                        Spacer()
                        OutcomeBadge(outcome: run.outcome)
                    }
                    Text(run.summary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        if let machine = run.machineId { WorkerChip(id: machine, kind: store.worker(machine)?.kind ?? .mac) }
                        if let finished = FleetDate.parse(run.finishedAt) { Text("Finished \(FleetFormat.moment(finished, now: store.now))") }
                        if let owner = run.owner { Text("by \(owner)") }
                        Spacer()
                        Button("Show in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: detail.directory)])
                        }
                        .disabled(!FileManager.default.fileExists(atPath: detail.directory))
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }

                if let receipt = detail.receipt {
                    // Unmet checks and outputs take the run's colour: amber when its tests
                    // failed, grey when it never ran, red only for The Fleet's own errors.
                    let unmet = FleetPalette.color(forOutcome: run.outcome)
                    facts(receipt, outcome: run.outcome)
                    checks(receipt, unmet: unmet)
                    if !receipt.artifacts.isEmpty || !receipt.missingArtifacts.isEmpty { outputs(receipt, unmet: unmet) }
                    if !receipt.remote.notes.isEmpty {
                        SectionCard(title: "Notes") {
                            ForEach(receipt.remote.notes, id: \.self) { NoticeLine(text: $0, symbol: "info.circle", tint: FleetPalette.idle) }
                        }
                    }
                    if let logs = detail.logs { logsCard(logs) }
                } else {
                    ContentUnavailableView {
                        Label("Receipt unavailable", systemImage: "doc.badge.ellipsis")
                    } description: {
                        Text("It was removed by retention, or its run folder is on a disk that isn't connected.\n\(FleetFormat.path(detail.directory))")
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 1100, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func facts(_ receipt: Receipt, outcome: String) -> some View {
        SectionCard(title: "Run") {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                // Only older receipts are read differently from how they were written.
                if receipt.outcome != outcome {
                    FactRow(label: "Recorded as", value: "\(OutcomeText.title(receipt.outcome)), by an earlier version of The Fleet")
                }
                FactRow(label: "Source", value: FleetFormat.path(receipt.source.root), monospaced: true)
                FactRow(label: "Sent", value: "\(FleetFormat.plural(receipt.source.files, "file"))\(receipt.source.symlinks > 0 ? " and \(FleetFormat.plural(receipt.source.symlinks, "link"))" : ""), \(FleetFormat.disk(receipt.source.bytes))")
                FactRow(label: "Digest", value: String(receipt.source.digest.prefix(16)), monospaced: true)
                if let git = receipt.source.git { FactRow(label: "Git", value: GitText.describe(git)) }
                ForEach(Array(receipt.command.prepare.enumerated()), id: \.offset) { _, step in
                    FactRow(label: "Prepare", value: FleetFormat.command(step), monospaced: true)
                }
                FactRow(label: "Command", value: FleetFormat.command(receipt.command.argv + receipt.command.extraArgs), monospaced: true)
                if receipt.command.cwd != "." { FactRow(label: "Folder", value: receipt.command.cwd, monospaced: true) }
                if !receipt.command.envNames.isEmpty { FactRow(label: "Environment", value: receipt.command.envNames.joined(separator: ", "), monospaced: true) }
                FactRow(label: "Time limit", value: FleetFormat.duration(receipt.command.timeoutSeconds))
                if let started = FleetDate.parse(receipt.timing.remoteStartedAt) {
                    FactRow(label: "Started", value: started.formatted(date: .abbreviated, time: .standard))
                }
                if let seconds = receipt.timing.jobSeconds { FactRow(label: "Job time", value: FleetFormat.duration(seconds)) }
                FactRow(label: "Total time", value: FleetFormat.duration(receipt.timing.totalSeconds))
                FactRow(label: "Cleanup", value: receipt.remote.lockReleased && !receipt.remote.processesRemaining
                    ? "Confirmed; the ship's lock was released"
                    : "Not confirmed. Check the ship before clearing anything.")
            }
        }
    }

    private func checks(_ receipt: Receipt, unmet: Color) -> some View {
        SectionCard(title: "Checks") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(receipt.success.checks, id: \.self) { check in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(check.passed ? FleetPalette.cleared : unmet)
                        Text(check.name).font(.callout.weight(.medium))
                        Text(check.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let count = receipt.success.testCount {
                    Text("\(FleetFormat.plural(count, "test")) counted").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func outputs(_ receipt: Receipt, unmet: Color) -> some View {
        SectionCard(title: "Outputs") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(receipt.artifacts.prefix(200), id: \.self) { artifact in
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(FleetPalette.cleared).help("Hash verified")
                        Text(artifact.path).font(.data(12)).textSelection(.enabled).lineLimit(1)
                        Spacer()
                        Text(FleetFormat.disk(artifact.bytes)).font(.caption).foregroundStyle(.secondary)
                        Text(String(artifact.sha256.prefix(12))).font(.data(11)).foregroundStyle(.tertiary).textSelection(.enabled)
                    }
                }
                if receipt.artifacts.count > 200 {
                    Text("\(receipt.artifacts.count - 200) more in the receipt").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(receipt.missingArtifacts, id: \.self) { missing in
                    NoticeLine(text: "\(missing) wasn't returned", symbol: "xmark.seal.fill", tint: unmet)
                }
            }
        }
    }

    private func logsCard(_ logs: RunDetail.Logs) -> some View {
        let log = showingErrors ? logs.stderr : logs.stdout
        return SectionCard(title: "Logs", trailing: AnyView(
            Picker("Log", selection: $showingErrors) {
                Text("Output").tag(false)
                Text("Errors").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 180)
        )) {
            VStack(alignment: .leading, spacing: 6) {
                if log.truncated {
                    Text("Showing the end of \(FleetFormat.disk(log.bytes)). The full log is in the run folder.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !log.present || log.text.isEmpty {
                    Text(log.present ? "Empty" : "No log file").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
                } else {
                    ConsoleTextView(text: log.text)
                        .frame(minHeight: 240, idealHeight: 380)
                        .recessed(cornerRadius: 8)
                }
            }
        }
    }
}

enum GitText {
    static func describe(_ git: GitSnapshot) -> String {
        var parts: [String] = []
        if let branch = git.branch { parts.append(branch) }
        parts.append(git.head.map { String($0.prefix(12)) } ?? "no commits")
        let changes = [(git.staged, "staged"), (git.unstaged, "unstaged"), (git.untracked, "untracked")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        parts.append(changes.isEmpty ? "clean" : changes.joined(separator: ", "))
        return parts.joined(separator: " · ") + (changes.isEmpty ? "" : " (sent as on disk)")
    }
}
