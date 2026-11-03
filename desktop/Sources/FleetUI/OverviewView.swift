// The fleet at a glance: one faceplate per worker and the work running now.

import SwiftUI
import FleetKit

struct OverviewView: View {
    @Bindable var store: FleetStore

    var body: some View {
        let workers = store.workers
        FleetScroll {
            VStack(alignment: .leading, spacing: 22) {
                header(workers)
                if workers.isEmpty {
                    if store.configuration == nil && store.configurationError == nil && !store.serviceNeedsUpdate {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                    } else {
                        NoWorkersView(store: store)
                    }
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 560), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                        ForEach(workers) { worker in
                            DeviceCardButton(store: store, worker: worker)
                        }
                    }
                }
                if !store.runningWork.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow("Running now")
                        VStack(spacing: 8) {
                            ForEach(store.runningWork) { operation in
                                NavigationLink(value: FleetRoute.operation(operation.id)) {
                                    OperationStrip(store: store, operation: operation)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if let error = store.stateError {
                    NoticeLine(text: "Couldn't check the workers: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                }
                if let error = store.configurationError {
                    NoticeLine(text: "Couldn't read worker settings: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                }
            }
            .padding(24)
            .frame(maxWidth: 1240, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Overview")
        .toolbar {
            ToolbarItemGroup {
                RefreshButton(store: store)
                Button {
                    store.sheet = .addWorker
                } label: {
                    Label("Add worker", systemImage: "plus")
                }
                .help("Add a paired computer as a worker")
                .disabled(store.serviceNeedsUpdate)
            }
        }
    }

    @ViewBuilder private func header(_ workers: [WorkerItem]) -> some View {
        // A worker can be running a job and still have shared capacity. The
        // coordinator owns admission; the card's activity label is separate.
        let available = workers.filter { $0.observation?.available == true }.count
        let running = workers.filter { $0.status.condition == .running }.count
        VStack(alignment: .leading, spacing: 6) {
            Text(workers.isEmpty ? "No workers yet" : "\(available) of \(FleetFormat.plural(workers.count, "worker")) available")
                .font(.nameplate(26, weight: .bold))
            HStack(spacing: 6) {
                if running > 0 { Text("\(running) running") }
                if running > 0, store.stateObservedAt != nil { Text("·") }
                if let observed = store.stateObservedAt {
                    Text("Checked \(FleetFormat.ago(observed, now: store.now))")
                } else if !workers.isEmpty {
                    Text("Checking workers…")
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct DeviceCardButton: View {
    let store: FleetStore
    let worker: WorkerItem
    @State private var hovering = false

    var body: some View {
        Button {
            store.open(.worker(worker.id))
        } label: {
            DeviceCard(worker: worker, limits: worker.settings?.limits, now: store.now, hovering: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Open \(worker.id)")
        .contextMenu {
            Button("Open") { store.open(.worker(worker.id)) }
            Button("Settings…") { store.sheet = .editWorker(worker.id) }
                .disabled(worker.settings == nil)
        }
    }
}

/// The worker's faceplate: device, nameplate, status lamp, one LED per core, memory and disk.
struct DeviceCard: View {
    let worker: WorkerItem
    let limits: WorkerLimits?
    let now: Date
    var hovering = false

    var body: some View {
        let tint = FleetPalette.color(for: worker.status.condition)
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                DeviceGlyph(kind: worker.kind, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(worker.id.uppercased())
                            .font(.nameplate(15))
                            .tracking(1.4)
                            .lineLimit(1)
                        if worker.isDefault {
                            Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(.secondary).help("Default worker")
                        }
                        Spacer(minLength: 8)
                        StatusBadge(condition: worker.status.condition)
                    }
                    Text(worker.subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            // Every faceplate keeps the same layout; one that hasn't answered is a dark panel.
            MetricsBlock(health: worker.health, tint: tint, minimumDiskGiB: limits?.minFreeDiskGiB)

            Rectangle().fill(FleetPalette.plateEdge).frame(height: 1)

            StatusLine(worker: worker, now: now)

            HStack(spacing: 8) {
                if let observed = worker.observedAt {
                    Text("Checked \(FleetFormat.ago(observed, now: now))")
                }
                Spacer()
                if let warnings = worker.observation?.warnings, !warnings.isEmpty {
                    Label(FleetFormat.plural(warnings.count, "warning"), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(FleetPalette.hold)
                        .help(warnings.joined(separator: "\n"))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(16)
        .faceplate(raised: hovering)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Load, memory and disk. Without an answer it draws the same rows dark, so
/// every faceplate keeps one shape and an offline worker reads as powered off.
struct MetricsBlock: View {
    let health: WorkerHealth?
    let tint: Color
    let minimumDiskGiB: Double?

    private static let labelWidth: CGFloat = 70

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            let cores = health?.cpuCount ?? 8
            let load = health?.loadAverage?.first
            CoreStrip(reading: CoreLoad(load: load ?? 0, cores: cores), tint: tint)
                .opacity(health == nil ? 0.6 : 1)
            HStack(spacing: 6) {
                Eyebrow("Load").frame(width: Self.labelWidth, alignment: .leading)
                if let load, health?.cpuCount != nil {
                    Text(FleetFormat.load(load)).font(.data(12, weight: .medium))
                    Text("on \(cores) cores").font(.caption).foregroundStyle(.secondary)
                } else {
                    missing
                }
                Spacer(minLength: 0)
            }
            memoryRow
            diskRow
        }
    }

    private var missing: some View {
        Text("—").font(.data(11)).foregroundStyle(.tertiary).accessibilityLabel("Unknown")
    }

    private var memoryRow: some View {
        HStack(spacing: 8) {
            Eyebrow("Memory").frame(width: Self.labelWidth, alignment: .leading)
            if let total = health?.memTotalBytes, total > 0, let available = health?.memAvailableBytes {
                let pressure = MemoryPressure(level: health?.memPressureLevel)
                MeterBar(fraction: 1 - available / total, tint: FleetPalette.color(forPressure: pressure))
                    .frame(minWidth: 30, maxWidth: 110)
                    .help(pressure.map { "Memory pressure: \($0.title)" } ?? "")
                Text("\(FleetFormat.memory(available)) of \(FleetFormat.memory(total)) free")
                    .font(.data(11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(1)
            } else {
                missing
            }
            Spacer(minLength: 0)
        }
    }

    private var diskRow: some View {
        HStack(spacing: 8) {
            Eyebrow("Disk").frame(width: Self.labelWidth, alignment: .leading)
            if let free = health?.diskFreeBytes {
                let short = minimumDiskGiB.map { free < $0 * 1_073_741_824 } ?? false
                Text("\(FleetFormat.disk(free)) free")
                    .font(.data(11))
                    .foregroundStyle(short ? FleetPalette.stop : .secondary)
                if short, let minimumDiskGiB {
                    Text("needs \(GiB.text(minimumDiskGiB))").font(.caption).foregroundStyle(FleetPalette.stop)
                }
            } else {
                missing
            }
            Spacer(minLength: 0)
        }
    }
}

/// What the worker is doing now, or why it isn't taking work.
struct StatusLine: View {
    let worker: WorkerItem
    let now: Date

    var body: some View {
        let status = worker.status
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch status.condition {
            case .running:
                Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(FleetPalette.taxiway)
                VStack(alignment: .leading, spacing: 2) {
                    Text(status.job?.label ?? "Job").font(.data(12, weight: .semibold)).lineLimit(1)
                    Text(jobDetail(status)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case .available:
                Text("Ready for work").font(.callout).foregroundStyle(.secondary)
            case .checking:
                Text("Waiting for its first check").font(.callout).foregroundStyle(.secondary)
            default:
                Text(status.detail ?? status.condition.title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 30, alignment: .topLeading)
    }

    private func jobDetail(_ status: WorkerStatus) -> String {
        var parts: [String] = []
        if let owner = status.job?.owner { parts.append(owner) }
        if let started = status.job?.startedAt { parts.append(FleetFormat.duration(now.timeIntervalSince(started))) }
        if let detail = status.detail { parts.append(detail) }
        return parts.isEmpty ? "Running" : parts.joined(separator: " · ")
    }
}

struct NoWorkersView: View {
    let store: FleetStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                ForEach([DeviceKind.macMini, .macBook, .macStudio], id: \.self) { kind in
                    DeviceGlyph(kind: kind, size: 46).opacity(0.75)
                }
            }
            Text("Pair a computer with Agent Bridge, then add it here. The pairing keeps its address and key; The Fleet only stores how to use it.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button("Add worker") { store.sheet = .addWorker }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.serviceNeedsUpdate)
                Text("Haven't paired one yet?").foregroundStyle(.secondary)
            }
            CommandBlock(command: "agent-bridge pair").frame(maxWidth: 360)
        }
        .padding(20)
        .frame(maxWidth: 620, alignment: .leading)
        .faceplate()
    }
}
