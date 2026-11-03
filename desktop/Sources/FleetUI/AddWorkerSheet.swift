// Adds a worker from an existing Agent Bridge pairing. The pairing keeps the
// address, user and key; the worker entry records only its name, remote folder
// and limits. A read-only check runs first so the same computer is never added
// twice (its aliases must share one lock) and this Mac is never its own worker.

import SwiftUI
import FleetKit

struct AddWorkerSheet: View {
    @Bindable var store: FleetStore
    @Environment(\.dismiss) private var dismiss

    @State private var target: String?
    @State private var check: PairingCheck?
    @State private var checkError: String?
    @State private var checking = false
    @State private var checkVersion = 0
    @State private var checkedTarget: String?
    @State private var name = ""
    @State private var suggestedName = ""
    @State private var details = ""
    @State private var remoteRoot = ""
    @State private var makeDefault = false
    @State private var saving = false
    @State private var saveError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Add Worker").font(.nameplate(20, weight: .bold))
                Text("Choose a computer paired with Agent Bridge. The pairing keeps its address and key.")
                    .foregroundStyle(.secondary)
            }
            .padding(20)
            Divider()
            HStack(alignment: .top, spacing: 0) {
                pairingList.frame(width: 270)
                Divider()
                form.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            Divider()
            HStack {
                if let saveError {
                    Text(saveError).font(.callout).foregroundStyle(FleetPalette.stop).lineLimit(3).textSelection(.enabled)
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add worker") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
            .padding(16)
        }
        .frame(width: 760, height: 560)
        .onAppear {
            store.pairingsWanted = true
            remoteRoot = store.configuration?.defaults.remoteRoot ?? "~/FleetRunner.noindex"
            makeDefault = store.workers.isEmpty
            Task { await store.reloadPairings() }
        }
        .onDisappear { store.pairingsWanted = false }
        .task(id: target) { await runCheck() }
    }

    // MARK: Pairings

    @ViewBuilder private var pairingList: some View {
        if let list = store.pairings {
            if !list.found || list.targets.isEmpty {
                NoPairingsView(found: list.found, configPath: list.configPath) { Task { await store.reloadPairings() } }
                    .padding(16)
            } else {
                List(selection: $target) {
                    Section("Paired computers") {
                        ForEach(list.targets) { pairing in
                            PairingRow(pairing: pairing)
                                .tag(pairing.target)
                                .selectionDisabled(!pairing.usable || pairing.registeredAs != nil)
                        }
                    }
                }
                .listStyle(.sidebar)
            }
        } else if let error = store.pairingsError {
            VStack(alignment: .leading, spacing: 10) {
                NoticeLine(text: "Couldn't read Agent Bridge pairings: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                Button("Check again") { Task { await store.reloadPairings() } }
            }
            .padding(16)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Form

    @ViewBuilder private var form: some View {
        if let target, let pairing = store.pairings?.targets.first(where: { $0.target == target }) {
            Form {
                Section {
                    CheckResultView(pairing: pairing, check: check, checking: checking, error: checkError)
                }
                Section {
                    TextField("Name", text: $name)
                    if let problem = nameProblem { Text(problem).font(.caption).foregroundStyle(FleetPalette.stop) }
                    TextField("Description", text: $details, prompt: Text("Optional, such as Desk Mac mini"))
                    Toggle("Default worker", isOn: $makeDefault)
                        .help("Runs that don't name a worker try the default first.")
                } footer: {
                    Text("Commands use this name, as in the-fleet run project test --machine \(name.isEmpty ? "name" : name).")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    TextField("Remote folder", text: $remoteRoot).font(.data(12))
                    if let problem = FleetValidation.remoteRootProblem(remoteRoot) {
                        Text(problem).font(.caption).foregroundStyle(FleetPalette.stop)
                    }
                } footer: {
                    Text("Jobs run in this folder on the worker, and its job lock lives there. Use one folder per computer.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .onChange(of: self.target, initial: true) { _, newTarget in
                guard let newTarget else { return }
                // Follow the chosen pairing until the name is typed by hand.
                let suggestion = FleetValidation.suggestedWorkerName(from: newTarget, existing: existingNames)
                if name.isEmpty || name == suggestedName { name = suggestion }
                suggestedName = suggestion
            }
        } else {
            ContentUnavailableView {
                Label("Choose a paired computer", systemImage: "desktopcomputer.and.arrow.down")
            } description: {
                Text("Computers already added, or with an incomplete pairing, can't be chosen.")
            }
        }
    }

    private var existingNames: [String] {
        (store.configuration?.machines ?? []).flatMap { [$0.id, $0.target] + $0.aliases }
    }

    private var nameProblem: String? {
        FleetValidation.workerNameProblem(name, existing: existingNames)
    }

    private var blocked: Bool {
        check?.dispatchingComputer == true || check?.sameAs != nil
    }

    private var canSave: Bool {
        target != nil && checkedTarget == target && !saving && !checking && !blocked && store.configuration != nil
            && FleetValidation.workerNameProblem(name, existing: existingNames) == nil
            && FleetValidation.remoteRootProblem(remoteRoot) == nil
    }

    private func runCheck() async {
        guard let target else { return }
        checkVersion &+= 1
        let version = checkVersion
        checkedTarget = nil
        check = nil
        checkError = nil
        checking = true
        defer { if version == checkVersion { checking = false } }
        do {
            let result = try await store.checkPairing(target: target, remoteRoot: FleetValidation.remoteRootProblem(remoteRoot) == nil ? remoteRoot : nil, workerID: nil)
            guard !Task.isCancelled, version == checkVersion, self.target == target else { return }
            check = result
            checkedTarget = target
        } catch {
            guard !Task.isCancelled, version == checkVersion, self.target == target else { return }
            checkError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            checkedTarget = target
        }
    }

    private func save() async {
        guard canSave, let target, let revision = store.configuration?.revision else { return }
        saving = true
        saveError = nil
        defer { saving = false }
        var body: [String: JSONValue] = [
            "revision": .string(revision), "id": .string(name), "target": .string(target),
            "remoteRoot": .string(remoteRoot), "makeDefault": .bool(makeDefault),
        ]
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["description"] = .string(trimmed) }
        do {
            let change = try await store.addWorker(body)
            store.notice = FleetNotice(text: "Added \(change.machine.id).")
            store.open(.worker(change.machine.id))
            dismiss()
        } catch let error as FleetAPIError {
            if case .revisionConflict = error {
                await store.reloadConfiguration()
                saveError = "Worker settings changed somewhere else. They're reloaded; add the worker again."
            } else {
                saveError = error.errorDescription
            }
        } catch {
            saveError = error.localizedDescription
        }
    }
}

struct PairingRow: View {
    let pairing: Pairing

    var body: some View {
        let kind = DeviceKind.classify(model: nil, os: nil, names: [pairing.target, pairing.host ?? ""])
        HStack(spacing: 10) {
            Image(systemName: kind.symbolName).symbolRenderingMode(.hierarchical).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(pairing.target).lineLimit(1)
                Group {
                    if let owner = pairing.registeredAs {
                        Text("Added as \(owner)")
                    } else if let problem = pairing.problem {
                        Text(problem).foregroundStyle(FleetPalette.stop)
                    } else if let host = pairing.host {
                        Text("\(pairing.user ?? "?")@\(host)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            }
            Spacer(minLength: 4)
            if let route = pairing.route {
                Text(route == "internet" ? "Internet" : "LAN")
                    .font(.system(size: 9, weight: .semibold).width(.expanded))
                    .foregroundStyle(FleetPalette.engraving)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .recessed(cornerRadius: 4)
                    .help(route == "internet" ? "Uses the pairing's internet_host, such as a Tailscale address" : "Uses the pairing's local network host")
            }
        }
        .opacity(pairing.usable && pairing.registeredAs == nil ? 1 : 0.55)
        .accessibilityElement(children: .combine)
    }
}

struct CheckResultView: View {
    let pairing: Pairing
    let check: PairingCheck?
    let checking: Bool
    let error: String?

    var body: some View {
        if checking {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking \(pairing.target)…").foregroundStyle(.secondary)
            }
        } else if let error {
            NoticeLine(text: error, symbol: "xmark.octagon.fill", tint: FleetPalette.stop)
        } else if let check {
            if check.dispatchingComputer {
                NoticeLine(text: "This is this Mac. Workers must be other computers.", symbol: "hand.raised.fill", tint: FleetPalette.stop)
            } else if let same = check.sameAs {
                NoticeLine(text: "This is the same computer as \(same). Add \(pairing.target) as an alias in \(same)'s settings instead, so they share one lock.", symbol: "hand.raised.fill", tint: FleetPalette.stop)
            } else if check.reachable, let health = check.health {
                let kind = DeviceKind.classify(model: health.model, os: health.os, names: [pairing.target, health.host ?? ""])
                HStack(alignment: .top, spacing: 12) {
                    DeviceGlyph(kind: kind, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Label("Reached \(health.host ?? pairing.target) as \(health.user ?? "?")", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(FleetPalette.cleared)
                        Text(summary(health)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                NoticeLine(text: "Couldn't reach it\(check.error.map { ": \($0)" } ?? ""). You can still add it; it shows as unreachable until it's online.")
            }
        }
    }

    private func summary(_ health: WorkerHealth) -> String {
        var parts: [String] = []
        if let chip = health.cpuBrand { parts.append(chip) }
        if let cores = health.cpuCount { parts.append("\(cores) cores") }
        if let memory = health.memTotalBytes { parts.append(FleetFormat.memory(memory)) }
        if let free = health.diskFreeBytes { parts.append("\(FleetFormat.disk(free)) free") }
        if health.os == "Darwin", let version = health.osVersion { parts.append("macOS \(version)") }
        return parts.joined(separator: " · ")
    }
}

struct NoPairingsView: View {
    let found: Bool
    let configPath: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(found ? "No paired computers" : "Agent Bridge isn't set up").font(.headline)
            Text(found ? "Pair one with Agent Bridge, then check again." : "Install Agent Bridge and pair a computer, then check again.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            CommandBlock(command: "agent-bridge pair")
            Text("For a computer on another network, use its Tailscale address as the pairing's internet_host.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(FleetFormat.path(configPath)).font(.data(10)).foregroundStyle(.tertiary).textSelection(.enabled)
            Button("Check again", action: retry)
        }
    }
}
