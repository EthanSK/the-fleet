// Edits one worker's settings in machines.json through the service.
//
// Only changed fields are sent, with the revision the form was opened from:
// if settings changed somewhere else meanwhile, the save is refused rather
// than overwriting them. Saved environment values are never shown; each is
// kept, replaced or removed. Connection and remote folder are locked while the
// worker has work or a reservation (the service enforces this too).

import SwiftUI
import FleetKit

struct EnvRow: Identifiable, Equatable {
    let id = UUID()
    var name: String
    /// The saved name this row came from; nil for a new variable.
    var savedName: String?
    /// nil keeps the saved value.
    var newValue: String?
}

struct WorkerDraft: Equatable {
    var description: String
    var target: String
    var aliases: [String]
    var remoteRoot: String
    var pathPrepend: [String]
    var env: [EnvRow]
    var limits: WorkerLimits
    var isDefault: Bool

    init(_ settings: WorkerSettings) {
        description = settings.description ?? ""
        target = settings.target
        aliases = settings.aliases
        remoteRoot = settings.remoteRoot
        pathPrepend = settings.pathPrepend
        env = settings.envNames.map { EnvRow(name: $0, savedName: $0, newValue: nil) }
        limits = settings.limits
        isDefault = settings.isDefault
    }

    var problems: [String] {
        var problems: [String] = []
        let aliasList = aliases.filter { !$0.isEmpty }
        if let bad = aliasList.first(where: { FleetValidation.aliasProblem($0) != nil }) { problems.append("Alias “\(bad)”: \(FleetValidation.aliasProblem(bad) ?? "")") }
        if Set(aliasList.map { $0.lowercased() }).count != aliasList.count { problems.append("Each alias can appear once.") }
        if let problem = FleetValidation.remoteRootProblem(remoteRoot) { problems.append(problem) }
        if let bad = pathPrepend.filter({ !$0.isEmpty }).first(where: { FleetValidation.pathEntryProblem($0) != nil }) { problems.append("PATH addition “\(bad)”: \(FleetValidation.pathEntryProblem(bad) ?? "")") }
        let names = env.map(\.name)
        if let bad = names.first(where: { FleetValidation.envNameProblem($0) != nil }) { problems.append("Variable “\(bad)”: \(FleetValidation.envNameProblem(bad) ?? "")") }
        if Set(names).count != names.count { problems.append("Each variable can appear once.") }
        if env.contains(where: { $0.newValue == nil && $0.savedName != $0.name }) { problems.append("Give renamed or new variables a value.") }
        problems += FleetValidation.limitProblems(limits)
        return problems
    }

    /// The request body: only fields that differ from the saved settings.
    func changes(from original: WorkerSettings) -> [String: JSONValue] {
        var body: [String: JSONValue] = [:]
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != (original.description ?? "") { body["description"] = trimmed.isEmpty ? .null : .string(trimmed) }
        if target != original.target { body["target"] = .string(target) }
        let aliasList = aliases.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if aliasList != original.aliases { body["aliases"] = .strings(aliasList) }
        let root = remoteRoot.trimmingCharacters(in: .whitespaces)
        if root != original.remoteRoot { body["remoteRoot"] = .string(root) }
        let paths = pathPrepend.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if paths != original.pathPrepend { body["pathPrepend"] = .strings(paths) }
        if env.map(\.name).sorted() != original.envNames.sorted() || env.contains(where: { $0.newValue != nil }) {
            var entries: [String: JSONValue] = [:]
            for row in env {
                entries[row.name] = row.newValue.map { .object(["value": .string($0)]) } ?? .object(["keep": .bool(true)])
            }
            body["env"] = .object(entries)
        }
        if limits != original.limits {
            body["limits"] = .object([
                "minFreeDiskGiB": .number(limits.minFreeDiskGiB), "minAvailableMemoryGiB": .number(limits.minAvailableMemoryGiB),
                "memoryPressure": .string(limits.memoryPressure), "heavyProcessNames": .strings(limits.heavyProcessNames),
                "heavyProcessAction": .string(limits.heavyProcessAction), "keepJobs": .number(Double(limits.keepJobs)),
                "uploadTimeoutMinutes": .number(limits.uploadTimeoutMinutes), "terminateGraceSeconds": .number(Double(limits.terminateGraceSeconds)),
            ])
        }
        if isDefault != original.isDefault { body["isDefault"] = .bool(isDefault) }
        return body
    }
}

struct WorkerSettingsSheet: View {
    @Bindable var store: FleetStore
    let workerID: String
    @Environment(\.dismiss) private var dismiss

    @State private var original: WorkerSettings?
    @State private var revision: String?
    @State private var draft: WorkerDraft?
    @State private var iconChoice = ""
    @State private var heavyText = ""
    @State private var saving = false
    @State private var error: String?
    @State private var conflict = false
    @State private var confirmingRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                if let worker = store.worker(workerID) { DeviceGlyph(kind: worker.kind, size: 40) }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Worker Settings").font(.nameplate(18, weight: .bold))
                    Text(workerID).font(.data(12)).foregroundStyle(.secondary)
                }
            }
            .padding(20)
            Divider()
            if draft != nil, let original {
                form(original)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack(spacing: 12) {
                if let error {
                    Text(error).font(.callout).foregroundStyle(FleetPalette.stop).lineLimit(3).textSelection(.enabled)
                } else if let problems = draft?.problems, let first = problems.first {
                    Text(first).font(.callout).foregroundStyle(FleetPalette.hold).lineLimit(2)
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
            .padding(16)
        }
        .frame(width: 640, height: 700)
        .onAppear {
            store.pairingsWanted = true
            load()
            Task { await store.reloadPairings() }
        }
        .onDisappear { store.pairingsWanted = false }
        .alert("These settings changed somewhere else", isPresented: $conflict) {
            Button("Reload") { Task { await store.reloadConfiguration(); load() } }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Reload them to see the newer values. Your edits here will be discarded.")
        }
        .confirmationDialog("Remove \(workerID)?", isPresented: $confirmingRemove) {
            Button("Remove", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its Agent Bridge pairing, remote folder and run history stay as they are. You can add it again later.")
        }
    }

    private func load() {
        guard let settings = store.configuration?.machines.first(where: { $0.id == workerID }) else { return }
        original = settings
        revision = store.configuration?.revision
        draft = WorkerDraft(settings)
        heavyText = settings.limits.heavyProcessNames.joined(separator: ", ")
        iconChoice = store.preferences.deviceKinds[workerID] ?? ""
        error = nil
    }

    private var routeLocked: Bool {
        guard let status = store.worker(workerID)?.status else { return false }
        return status.job != nil || status.reservation != nil
    }

    private var canSave: Bool {
        guard let draft, let original, !saving else { return false }
        let iconChanged = iconChoice != (store.preferences.deviceKinds[workerID] ?? "")
        return draft.problems.isEmpty && (!draft.changes(from: original).isEmpty || iconChanged)
    }

    private func binding<T>(_ keyPath: WritableKeyPath<WorkerDraft, T>, fallback: T) -> Binding<T> {
        Binding(get: { draft?[keyPath: keyPath] ?? fallback }, set: { draft?[keyPath: keyPath] = $0 })
    }

    @ViewBuilder private func form(_ original: WorkerSettings) -> some View {
        Form {
            Section("General") {
                TextField("Description", text: binding(\.description, fallback: ""), prompt: Text("Optional"))
                Toggle("Default worker", isOn: binding(\.isDefault, fallback: false))
                    .help("Preferred when worker load and available resources are equal.")
                Picker("Icon", selection: $iconChoice) {
                    Text("Automatic (\(store.automaticDeviceKind(id: workerID).title))").tag("")
                    Divider()
                    ForEach(DeviceKind.allCases) { kind in
                        Label(kind.title, systemImage: kind.symbolName).tag(kind.rawValue)
                    }
                }
            }

            Section {
                pairingPicker(original)
                StringListEditor(title: "Aliases", items: binding(\.aliases, fallback: []), placeholder: "Another name for this computer", addTitle: "Add alias")
            } header: {
                Text("Connection")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Agent Bridge keeps the address, user and key. Aliases are other names for this same computer and share its lock.")
                    if routeLocked { Text("The pairing and remote folder can't change while \(workerID) has work or a reservation.").foregroundStyle(FleetPalette.hold) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                TextField("Remote folder", text: binding(\.remoteRoot, fallback: ""))
                    .font(.data(12))
                    .disabled(routeLocked)
            } header: {
                Text("Remote Folder")
            } footer: {
                Text("Jobs run here and the job lock lives here, so it only moves while \(workerID) is idle and its lock is confirmed free. Results already kept in the old folder stay there.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                StringListEditor(title: "PATH additions", items: binding(\.pathPrepend, fallback: []), placeholder: "/opt/homebrew/bin", addTitle: "Add folder", monospaced: true)
                EnvEditor(rows: binding(\.env, fallback: []))
            } header: {
                Text("Tools")
            } footer: {
                Text("PATH additions come before the worker's own PATH for every job. Environment values stay in the worker settings and are never shown here.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                LabeledContent("Minimum free disk") {
                    HStack { TextField("", value: binding(\.limits.minFreeDiskGiB, fallback: 0), format: .number).frame(width: 70); Text("GiB") }
                }
                LabeledContent("Minimum available memory") {
                    HStack { TextField("", value: binding(\.limits.minAvailableMemoryGiB, fallback: 0), format: .number).frame(width: 70); Text("GiB") }
                }
                Picker("Memory pressure", selection: binding(\.limits.memoryPressure, fallback: "refuse-critical")) {
                    ForEach(PressurePolicy.options, id: \.0) { option in Text(option.1).tag(option.0) }
                }
                Picker("Other heavy work", selection: binding(\.limits.heavyProcessAction, fallback: "refuse")) {
                    Text("Refuse new jobs").tag("refuse")
                    Text("Warn only").tag("warn")
                }
                .help("Builds started outside The Fleet don't take its lock, so they're recognized by process name.")
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Heavy processes", text: $heavyText, axis: .vertical)
                        .font(.data(11))
                        .lineLimit(2...4)
                        .onChange(of: heavyText) { _, text in
                            draft?.limits.heavyProcessNames = text.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init)
                        }
                    if let defaults = store.configuration?.defaults.limits.heavyProcessNames, defaults != draft?.limits.heavyProcessNames {
                        Button("Use defaults") { heavyText = defaults.joined(separator: ", ") }.buttonStyle(.link)
                    }
                }
                Stepper("Finished job folders kept: \(draft?.limits.keepJobs ?? 0)", value: binding(\.limits.keepJobs, fallback: 20), in: 1...500)
                LabeledContent("Upload time limit") {
                    HStack { TextField("", value: binding(\.limits.uploadTimeoutMinutes, fallback: 15), format: .number).frame(width: 70); Text("minutes") }
                }
                Stepper("Stop grace: \(draft?.limits.terminateGraceSeconds ?? 0) seconds", value: binding(\.limits.terminateGraceSeconds, fallback: 20), in: 1...600)
                    .help("Time between asking a job's processes to stop and forcing them.")
            } header: {
                Text("Admission")
            } footer: {
                Text("The Fleet refuses new jobs on this worker when these limits aren't met. Running jobs keep the settings they started with.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Button("Remove worker…", role: .destructive) { confirmingRemove = true }
            } footer: {
                Text("Removes only this entry. The pairing, remote folder and run history stay.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder private func pairingPicker(_ original: WorkerSettings) -> some View {
        let options = (store.pairings?.targets ?? []).filter { $0.usable && ($0.registeredAs == nil || $0.registeredAs == workerID) }.map(\.target)
        let choices = options.contains(original.target) ? options : [original.target] + options
        Picker("Agent Bridge pairing", selection: binding(\.target, fallback: original.target)) {
            ForEach(choices, id: \.self) { Text($0).tag($0) }
        }
        .disabled(routeLocked || choices.count < 2)
    }

    private func save() async {
        guard let draft, let original, let revision else { return }
        saving = true
        error = nil
        defer { saving = false }
        let iconChanged = iconChoice != (store.preferences.deviceKinds[workerID] ?? "")
        let body = draft.changes(from: original)
        do {
            if !body.isEmpty {
                var request = body
                request["revision"] = .string(revision)
                _ = try await store.updateWorker(id: workerID, request)
            }
            if iconChanged { store.preferences.deviceKinds[workerID] = iconChoice.isEmpty ? nil : iconChoice }
            store.notice = FleetNotice(text: "Saved \(workerID)'s settings.")
            dismiss()
        } catch let failure as FleetAPIError {
            if case .revisionConflict = failure { conflict = true } else { error = failure.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove() async {
        guard let revision else { return }
        do {
            _ = try await store.removeWorker(id: workerID, revision: revision)
            dismiss()
        } catch let failure as FleetAPIError {
            if case .revisionConflict = failure { conflict = true } else { error = failure.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Edits a short list of strings with add and remove controls.
struct StringListEditor: View {
    let title: String
    @Binding var items: [String]
    let placeholder: String
    let addTitle: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
            ForEach(items.indices, id: \.self) { index in
                HStack {
                    TextField(placeholder, text: Binding(get: { index < items.count ? items[index] : "" }, set: { if index < items.count { items[index] = $0 } }))
                        .font(monospaced ? .data(12) : .body)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        items.remove(at: index)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(index < items.count ? items[index] : "")")
                }
            }
            Button(addTitle) { items.append("") }.buttonStyle(.link)
        }
    }
}

struct EnvEditor: View {
    @Binding var rows: [EnvRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Environment")
            ForEach($rows) { $row in
                HStack(spacing: 8) {
                    TextField("NAME", text: $row.name).font(.data(12)).textFieldStyle(.roundedBorder).frame(width: 170)
                    if let value = row.newValue {
                        TextField("Value", text: Binding(get: { value }, set: { row.newValue = $0 })).font(.data(12)).textFieldStyle(.roundedBorder)
                        if row.savedName != nil {
                            Button("Keep saved") { row.newValue = nil; if let saved = row.savedName { row.name = saved } }.buttonStyle(.link)
                        }
                    } else {
                        Text("Saved value").foregroundStyle(.secondary)
                        Spacer()
                        Button("Replace") { row.newValue = "" }.buttonStyle(.link)
                    }
                    Button {
                        rows.removeAll { $0.id == row.id }
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(row.name)")
                }
            }
            Button("Add variable") { rows.append(EnvRow(name: "", savedName: nil, newValue: "")) }.buttonStyle(.link)
        }
    }
}
