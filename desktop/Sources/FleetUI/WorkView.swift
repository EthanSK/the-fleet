// Managed work, like a dispatcher's strip board: what's running now, then
// finished runs with their receipts. Other CLI commands are not shown here.

import SwiftUI
import FleetKit

struct WorkView: View {
    @Bindable var store: FleetStore
    @State private var query = ""

    var body: some View {
        let running = store.runningWork
        let finished = filtered(store.finishedWork)
        List {
            Section {
                if running.isEmpty {
                    Text("Nothing running").foregroundStyle(.secondary)
                } else {
                    ForEach(running) { operation in
                        NavigationLink(value: FleetRoute.operation(operation.id)) {
                            OperationStrip(store: store, operation: operation)
                        }
                    }
                }
            } header: {
                Eyebrow("Running")
            }
            Section {
                if finished.isEmpty {
                    if store.runs == nil, store.runsError == nil, !store.serviceNeedsUpdate {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text(query.isEmpty ? "No runs yet" : "No runs found").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(finished) { item in
                        switch item {
                        case .run(let run):
                            NavigationLink(value: FleetRoute.run(run.jobId)) { RunStrip(store: store, run: run) }
                        case .operation(let operation):
                            NavigationLink(value: FleetRoute.operation(operation.id)) { OperationStrip(store: store, operation: operation) }
                        }
                    }
                }
                if let error = store.runsError {
                    NoticeLine(text: "Couldn't read run history: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                }
            } header: {
                Eyebrow("Finished")
            }
        }
        .listStyle(.inset)
        .searchable(text: $query, placement: .toolbar, prompt: "Search runs")
        .navigationTitle("Work")
        .toolbar { ToolbarItem { RefreshButton(store: store) } }
        .onAppear { store.workVisible = true }
        .onDisappear { store.workVisible = false }
    }

    private func filtered(_ items: [FinishedWork]) -> [FinishedWork] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return items }
        return items.filter { item in words.allSatisfy { item.searchText.contains($0) } }
    }
}

/// A strip for coordinated work: colour bar, call sign, worker, owner and timing.
struct OperationStrip: View {
    let store: FleetStore
    let operation: OperationSummary

    var body: some View {
        let outcome = operation.isRunning ? "running" : OutcomeText.outcome(forExitCode: operation.exitCode)
        let started = FleetDate.parse(operation.createdAt)
        let ended = FleetDate.parse(operation.finishedAt)
        StripLayout(tint: FleetPalette.color(forOutcome: outcome)) {
            HStack(spacing: 8) {
                Text(operation.label).font(.data(13, weight: .semibold)).lineLimit(1)
                if let machine = operation.machineId {
                    WorkerChip(id: machine, kind: store.worker(machine)?.kind ?? .mac)
                }
            }
            Text(detail(outcome: outcome))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } trailing: {
            VStack(alignment: .trailing, spacing: 2) {
                if let started {
                    Text(FleetFormat.duration((ended ?? store.now).timeIntervalSince(started))).font(.data(12))
                    Text(FleetFormat.moment(started, now: store.now)).font(.caption).foregroundStyle(.secondary)
                }
            }
            OutcomeBadge(outcome: outcome).frame(minWidth: 92, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private func detail(outcome: String) -> String {
        if operation.isRunning {
            let line = operation.cancelRequested ? "Cancelling" : (operation.lastLine ?? (operation.machineId == nil ? "Choosing a worker" : "Starting"))
            return "\(operation.owner) · \(line)"
        }
        let meaning = operation.exitCode.map(ExitMeaning.title) ?? "Ended"
        return "\(operation.owner) · \(operation.lastLine ?? meaning)"
    }
}

struct RunStrip: View {
    let store: FleetStore
    let run: RunSummary

    var body: some View {
        StripLayout(tint: FleetPalette.color(forOutcome: run.outcome)) {
            HStack(spacing: 8) {
                Text("\(run.project)/\(run.profile)").font(.data(13, weight: .semibold)).lineLimit(1)
                if let machine = run.machineId {
                    WorkerChip(id: machine, kind: store.worker(machine)?.kind ?? .mac)
                }
                if !run.available {
                    Image(systemName: "doc.badge.ellipsis").foregroundStyle(.secondary).help("Receipt unavailable")
                }
            }
            Text(run.summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        } trailing: {
            VStack(alignment: .trailing, spacing: 2) {
                if let seconds = run.jobSeconds ?? run.totalSeconds { Text(FleetFormat.duration(seconds)).font(.data(12)) }
                if let finished = FleetDate.parse(run.finishedAt) {
                    Text(FleetFormat.moment(finished, now: store.now)).font(.caption).foregroundStyle(.secondary)
                }
            }
            OutcomeBadge(outcome: run.outcome).frame(minWidth: 92, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

struct StripLayout<Leading: View, Trailing: View>: View {
    let tint: Color
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(tint)
                .frame(width: 4)
                .shadow(color: tint.opacity(0.5), radius: 2)
            VStack(alignment: .leading, spacing: 3) { leading }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 6)
        .padding(.trailing, 4)
        .contentShape(Rectangle())
    }
}

struct OperationDetailView: View {
    let store: FleetStore
    let operationID: String
    @State private var feed: OperationFeed
    @State private var confirmingCancel = false
    @State private var cancelError: String?

    init(store: FleetStore, operationID: String) {
        self.store = store
        self.operationID = operationID
        _feed = State(initialValue: OperationFeed(id: operationID))
    }

    var body: some View {
        let summary = store.operation(operationID)
        let running = feed.latest.map { $0.status == "running" } ?? summary?.isRunning ?? false
        let label = feed.latest?.label ?? summary?.label ?? "Operation"
        let exitCode = feed.latest?.exitCode ?? summary?.exitCode
        let outcome = running ? "running" : OutcomeText.outcome(forExitCode: exitCode)
        let jobIDs = feed.latest?.jobIds ?? summary?.jobIds ?? []
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(label).font(.nameplate(20)).lineLimit(1).textSelection(.enabled)
                    Spacer()
                    OutcomeBadge(outcome: outcome)
                }
                HStack(spacing: 10) {
                    if let machine = feed.latest?.machineId ?? summary?.machineId {
                        WorkerChip(id: machine, kind: store.worker(machine)?.kind ?? .mac)
                    }
                    if let owner = feed.latest?.owner ?? summary?.owner { Text("by \(owner)") }
                    if let started = FleetDate.parse(feed.latest?.createdAt ?? summary?.createdAt) {
                        let ended = FleetDate.parse(feed.latest?.finishedAt ?? summary?.finishedAt)
                        Text("Started \(FleetFormat.moment(started, now: store.now)) · \(FleetFormat.duration((ended ?? store.now).timeIntervalSince(started)))")
                    }
                    Spacer()
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                if !running, let exitCode {
                    Text(ExitMeaning.title(exitCode)).font(.callout.weight(.medium))
                }
                if running, (feed.latest?.detached ?? summary?.detached) == true {
                    Text("Keeps running if you quit The Fleet.").font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    if running {
                        Button(role: .destructive) { confirmingCancel = true } label: { Text("Cancel run…") }
                            .disabled((feed.latest?.cancelRequested ?? summary?.cancelRequested) == true)
                    }
                    ForEach(jobIDs, id: \.self) { jobID in
                        NavigationLink(value: FleetRoute.run(jobID)) { Text(jobIDs.count > 1 ? "Receipt \(jobID)" : "Receipt") }
                    }
                    if (feed.latest?.cancelRequested ?? summary?.cancelRequested) == true, running {
                        Text("Cancelling. The worker stops the job and cleans up.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let cancelError { Text(cancelError).font(.caption).foregroundStyle(FleetPalette.stop) }
                }
            }
            .padding(20)
            .background(.bar)
            Divider()
            if feed.missing && feed.text.isEmpty {
                ContentUnavailableView {
                    Label("Output no longer kept", systemImage: "text.badge.xmark")
                } description: {
                    Text("The service keeps recent output only. Finished runs keep their receipts and logs in Work.")
                }
            } else {
                VStack(spacing: 0) {
                    if feed.earlierOutputOmitted {
                        Text("Earlier output omitted. The full log is in the run's receipt folder.")
                            .font(.caption).foregroundStyle(.secondary).padding(.vertical, 6)
                    }
                    ConsoleTextView(text: feed.text)
                    if let error = feed.error {
                        NoticeLine(text: error, symbol: "wifi.exclamationmark", tint: FleetPalette.hold).padding(8)
                    }
                }
            }
        }
        .navigationTitle(label)
        .onAppear { feed.start(client: store.client) }
        .onDisappear { feed.stop() }
        .confirmationDialog("Cancel \(label)?", isPresented: $confirmingCancel) {
            Button("Cancel run", role: .destructive) {
                Task {
                    do { try await store.cancel(operationID: operationID); cancelError = nil }
                    catch { cancelError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
                }
            }
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("The worker stops the job and cleans up. Its receipt records the cancellation.")
        }
    }
}
