// Registered projects and their saved profiles, read from live manifests.
// Running one is an intentional, previewed action; the coordinator chooses and
// admits the worker exactly as it does for the CLI.

import SwiftUI
import FleetKit

struct ProjectsView: View {
    @Bindable var store: FleetStore

    var body: some View {
        FleetScroll {
            VStack(alignment: .leading, spacing: 16) {
                if let list = store.projects {
                    if let error = list.error {
                        NoticeLine(text: "Couldn't read project registrations: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                    }
                    if list.projects.isEmpty {
                        NoProjectsView()
                    } else {
                        ForEach(list.projects) { project in ProjectCard(store: store, project: project) }
                    }
                } else if let error = store.projectsError {
                    NoticeLine(text: "Couldn't read projects: \(error)", symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop)
                } else if store.serviceNeedsUpdate {
                    Text("Projects appear once the service is restarted on the current version.").foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(24)
            .frame(maxWidth: 1000, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Projects")
        .toolbar { ToolbarItem { RefreshButton(store: store) } }
    }
}

struct ProjectCard: View {
    let store: FleetStore
    let project: ProjectSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(project.id).font(.nameplate(16))
                Spacer()
                Text(project.defaultMachine.map { "Runs on \($0)" } ?? "First available worker")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let description = project.description { Text(description).foregroundStyle(.secondary) }
            Text(FleetFormat.path(project.sourceRoot)).font(.data(11)).foregroundStyle(.secondary).textSelection(.enabled)
            if let error = project.error {
                NoticeLine(text: error, symbol: "exclamationmark.triangle.fill", tint: FleetPalette.stop).textSelection(.enabled)
            }
            if !project.profiles.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(project.profiles.enumerated()), id: \.element.id) { index, profile in
                        if index > 0 { Divider() }
                        ProfileRow(store: store, project: project, profile: profile)
                    }
                }
                .padding(.horizontal, 12)
                .recessed(cornerRadius: 10)
            }
            if !project.localOnly.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow("Stays on its own Mac")
                    ForEach(project.localOnly, id: \.self) { note in
                        Text("\(note.command) — \(note.reason)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .faceplate()
    }
}

struct ProfileRow: View {
    let store: FleetStore
    let project: ProjectSummary
    let profile: ProfileSummary

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            KindChip(kind: profile.kind).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(profile.name).font(.data(13, weight: .semibold))
                Text(profile.description).font(.callout).foregroundStyle(.secondary)
                Text(FleetFormat.command(profile.command)).font(.data(11)).foregroundStyle(.tertiary).lineLimit(1).textSelection(.enabled)
                if !profile.tools.isEmpty || profile.guiSession {
                    Text(requirements).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Text(FleetFormat.minutes(profile.timeoutMinutes)).font(.data(11)).foregroundStyle(.secondary).help("Time limit")
            if let blocked = profile.blocked {
                Label("Blocked", systemImage: "lock.fill").font(.caption).foregroundStyle(.secondary).help(blocked)
            } else {
                Button("Run…") { store.sheet = .runProfile(project: project.id, profile: profile.name) }
                    .disabled(store.workers.isEmpty || store.serviceNeedsUpdate)
                    .help(store.workers.isEmpty ? "Add a worker first" : "Run \(project.id)/\(profile.name) on a worker")
            }
        }
        .padding(.vertical, 10)
    }

    private var requirements: String {
        var parts: [String] = []
        if !profile.tools.isEmpty { parts.append("Needs \(profile.tools.joined(separator: ", "))") }
        if profile.guiSession { parts.append("needs the worker's screen session") }
        return parts.joined(separator: " · ")
    }
}

struct NoProjectsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No projects registered").font(.nameplate(18))
            Text("A project registers its the-fleet.json, which names the files to send, the command, its time limit and how to tell it passed. Register one from Terminal:")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            CommandBlock(command: "the-fleet register /path/to/project/the-fleet.json --source /path/to/project")
            Text("Agents can also send one-time requests without registering anything.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(maxWidth: 640, alignment: .leading)
        .faceplate()
    }
}

struct RunProfileSheet: View {
    @Bindable var store: FleetStore
    let projectID: String
    let profileName: String
    @Environment(\.dismiss) private var dismiss

    @State private var worker: String?
    @State private var plan: RunPlan?
    @State private var planError: String?
    @State private var planning = false
    @State private var planVersion = 0
    @State private var plannedWorker: String?
    @State private var starting = false
    @State private var startError: String?

    private var project: ProjectSummary? { store.projects?.projects.first { $0.id == projectID } }
    private var profile: ProfileSummary? { project?.profiles.first { $0.name == profileName } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Run \(projectID)/\(profileName)").font(.nameplate(18, weight: .bold))
                if let profile { Text(profile.description).foregroundStyle(.secondary) }
            }
            .padding(20)
            Divider()
            Form {
                Section {
                    Picker("Worker", selection: $worker) {
                        Text(project?.defaultMachine.map { "Project worker (\($0))" } ?? "First available").tag(String?.none)
                        Divider()
                        ForEach(store.workers) { item in
                            Text("\(item.id) — \(item.status.condition.title)").tag(Optional(item.id))
                        }
                    }
                } footer: {
                    Text(placementNote).font(.caption).foregroundStyle(.secondary)
                }
                Section("What It Sends") { planContent }
            }
            .formStyle(.grouped)
            Divider()
            HStack(spacing: 12) {
                if let startError {
                    Text(startError).font(.callout).foregroundStyle(FleetPalette.stop).lineLimit(3).textSelection(.enabled)
                } else {
                    Text("Runs on the worker and keeps going if you quit The Fleet.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Run") { Task { await start() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(starting || planning || plan == nil || plannedWorker != worker || planError != nil || profile == nil || profile?.blocked != nil)
            }
            .padding(16)
        }
        .frame(width: 620, height: 600)
        .task(id: worker) { await loadPlan() }
    }

    private var placementNote: String {
        if worker != nil { return "Runs only on this worker. If it's busy, nothing starts." }
        if let pinned = project?.defaultMachine { return "\(projectID) names \(pinned) as its worker." }
        return "Tries workers in order, default first. A run that started never moves to another worker."
    }

    @ViewBuilder private var planContent: some View {
        if planning {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading source…").foregroundStyle(.secondary) }
        } else if let planError {
            NoticeLine(text: planError, symbol: "xmark.octagon.fill", tint: FleetPalette.stop)
        } else if let plan {
            LabeledContent("Sends", value: "\(FleetFormat.plural(plan.source.files, "file"))\(plan.source.symlinks > 0 ? " and \(FleetFormat.plural(plan.source.symlinks, "link"))" : ""), \(FleetFormat.disk(plan.source.bytes))")
            LabeledContent("From") { Text(FleetFormat.path(plan.source.root)).font(.data(11)).textSelection(.enabled) }
            if let git = plan.source.git { LabeledContent("Git", value: GitText.describe(git)) }
            if plan.skippedCount > 0 {
                LabeledContent("Not sent") {
                    Text("\(FleetFormat.plural(plan.skippedCount, "file")) by safety or size rules")
                        .help(plan.skipped.map { "\($0.path): \($0.detail)" }.joined(separator: "\n"))
                }
            }
            if !plan.unmatchedIncludes.isEmpty {
                NoticeLine(text: "No files match \(plan.unmatchedIncludes.joined(separator: ", ")).")
            }
            ForEach(Array(plan.prepare.enumerated()), id: \.offset) { _, step in
                LabeledContent("Prepare") { Text(FleetFormat.command(step)).font(.data(11)).textSelection(.enabled) }
            }
            LabeledContent("Command") { Text(FleetFormat.command(plan.command)).font(.data(11)).textSelection(.enabled) }
            LabeledContent("Time limit", value: FleetFormat.minutes(plan.timeoutMinutes))
            LabeledContent("Passes when") { Text(plan.success).font(.callout).multilineTextAlignment(.trailing) }
            if !plan.artifacts.isEmpty { LabeledContent("Returns", value: plan.artifacts.joined(separator: ", ")) }
        }
    }

    private func loadPlan() async {
        planVersion &+= 1
        let version = planVersion
        let selectedWorker = worker
        plan = nil
        planning = true
        planError = nil
        defer { if version == planVersion { planning = false } }
        do {
            let result = try await store.plan(project: projectID, profile: profileName, worker: selectedWorker)
            guard !Task.isCancelled, version == planVersion, selectedWorker == worker else { return }
            plan = result
            plannedWorker = selectedWorker
        } catch {
            guard !Task.isCancelled, version == planVersion, selectedWorker == worker else { return }
            plan = nil
            planError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func start() async {
        guard !planning, plan != nil, plannedWorker == worker, planError == nil else { return }
        starting = true
        startError = nil
        defer { starting = false }
        do {
            try await store.startRun(project: projectID, profile: profileName, placement: worker.map(RunPlacement.worker) ?? .firstAvailable)
            dismiss()
        } catch {
            startError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
