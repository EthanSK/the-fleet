// Headless rendering of the real views with the service's data shapes, in
// light and dark appearance and at narrow and wide sizes. This proves the view
// bodies evaluate and draw for every worker condition; physical window checks
// (focus, hover, sheets, resizing) remain a manual step.

import XCTest
import SwiftUI
import ImageIO
@testable import FleetUI
@testable import FleetKit

@MainActor
final class RenderingTests: XCTestCase {
    /// Screens lay out inline here: ImageRenderer can't draw AppKit-backed scroll views.
    private func render<V: View>(_ view: V, width: CGFloat, scheme: ColorScheme, file: StaticString = #filePath, line: UInt = #line) -> CGImage? {
        let renderer = ImageRenderer(content: view.frame(width: width).padding(12).background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme).environment(\.fleetInlineScroll, true))
        renderer.scale = 1
        let image = renderer.cgImage
        XCTAssertNotNil(image, "renders", file: file, line: line)
        if let image {
            XCTAssertGreaterThanOrEqual(CGFloat(image.width), width, file: file, line: line)
            XCTAssertTrue(hasInk(image), "draws something visible", file: file, line: line)
        }
        return image
    }

    /// True when some pixel differs from the first pixel, so content was drawn over the background.
    private func hasInk(_ image: CGImage) -> Bool {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let first = Array(pixels[0..<4])
        return stride(from: 0, to: pixels.count, by: 4 * 7).contains { Array(pixels[$0..<$0 + 4]) != first }
    }

    private func loadedStore() async throws -> FleetStore {
        let api = FakeFleetAPI()
        api.setHealth(version: "0.3.0")
        api.operationsList = [UIFixture.operation("aaaaaaaaaaaaaaaaaaaaaaaa")]
        let preferences = FleetPreferences(defaults: UserDefaults(suiteName: "fleet-render-\(UUID().uuidString)")!)
        let store = FleetStore(preferences: preferences, discovery: FleetDiscovery(userHome: NSTemporaryDirectory(), environment: [:]), makeClient: { _ in api })
        await store.refreshHealth()
        try await store.loadConfiguration()
        try await store.loadState(fresh: false)
        try await store.loadOperations()
        try await store.loadRuns()
        return store
    }

    func testEveryWorkerConditionRendersOnItsFaceplate() throws {
        let health = WorkerHealth(os: "Darwin", host: "desk-host", model: "Mac16,10", cpuBrand: "Apple M4", osVersion: "26.1", diskFreeBytes: 3e9,
                                  memTotalBytes: 17_179_869_184, memAvailableBytes: 2e9, memPressureLevel: 4, cpuCount: 10, loadAverage: [12.6, 8, 4])
        let healthJSON = String(decoding: try JSONEncoder().encode(health), as: UTF8.self)
        let observation = decode(WorkerObservation.self, #"{"id":"desk","aliases":[],"observedAt":"2026-11-01T22:00:00.000Z","available":false,"reasons":["Not enough free disk"],"warnings":["desk is under critical memory pressure"],"health":\#(healthJSON)}"#)
        let limits = decode(WorkerLimits.self, UIFixture.limits)
        for condition in WorkerCondition.allCases {
            let job = condition == .running ? CurrentJob(label: "example/test", jobID: "job", startedAt: Date().addingTimeInterval(-75), owner: "The Fleet app", operationID: "a", orphaned: false) : nil
            let worker = WorkerItem(id: "desk", settings: nil, observation: observation, status: WorkerStatus(condition: condition, detail: "Detail for \(condition.title)", job: job, reservation: nil),
                                    kind: .macMini, isDefault: condition == .available)
            let card = DeviceCard(worker: worker, limits: limits, now: Date())
            _ = render(card, width: 320, scheme: .light)
            _ = render(card, width: 520, scheme: .dark)
            _ = render(DeviceCard(worker: WorkerItem(id: "desk", settings: nil, observation: nil, status: WorkerStatus(condition: condition, detail: nil, job: nil, reservation: nil),
                                                    kind: .linux, isDefault: false), limits: nil, now: Date()), width: 300, scheme: .dark)
        }
    }

    func testCoreStripsHandleTinyAndHugeMachines() {
        for (load, cores) in [(0.0, 1), (4.47, 10), (13.0, 10), (40.0, 64)] {
            _ = render(CoreStrip(reading: CoreLoad(load: load, cores: cores), tint: FleetPalette.taxiway), width: 300, scheme: .light)
        }
    }

    func testWorkerDetailRendersFromRealShapes() async throws {
        let store = try await loadedStore()
        XCTAssertEqual(store.worker("desk")?.status.condition, .running)
        _ = render(WorkerDetailView(store: store, workerID: "desk"), width: 900, scheme: .light)
        _ = render(WorkerDetailView(store: store, workerID: "laptop"), width: 560, scheme: .dark)
        _ = render(WorkerDetailView(store: store, workerID: "removed-elsewhere"), width: 560, scheme: .light)
    }

    func testWorkStripsAndOverviewRender() async throws {
        let store = try await loadedStore()
        _ = render(OperationStrip(store: store, operation: UIFixture.operation("aaaaaaaaaaaaaaaaaaaaaaaa")), width: 640, scheme: .light)
        _ = render(OperationStrip(store: store, operation: UIFixture.operation("cccccccccccccccccccccccc", status: "complete", exitCode: 4, finishedAt: "2026-11-01T22:07:00.000Z", machine: nil)), width: 420, scheme: .dark)
        _ = render(OperationStrip(store: store, operation: UIFixture.operation("dddddddddddddddddddddddd", status: "complete", exitCode: 2, outcome: "aborted", finishedAt: "2026-11-01T22:07:00.000Z")), width: 640, scheme: .light)
        for outcome in ["running", "passed", "failed", "timed-out", "cancelled", "aborted", "refused", "error"] {
            _ = render(OutcomeBadge(outcome: outcome), width: 140, scheme: .dark)
        }
        if let run = store.runs?.runs.first { _ = render(RunStrip(store: store, run: run), width: 640, scheme: .dark) }
        _ = render(OverviewView(store: store), width: 1100, scheme: .light)
        _ = render(NoWorkersView(store: store), width: 620, scheme: .dark)
    }

    /// Opt-in design review: writes offscreen renders as PNG files. No window is opened.
    func testWritesReviewImagesWhenAsked() async throws {
        guard let directory = ProcessInfo.processInfo.environment["FLEET_RENDER_DIR"] else { throw XCTSkip("Set FLEET_RENDER_DIR to write review images.") }
        let store = try await loadedStore()
        let workers = store.workers
        let available = WorkerItem(id: "studio", settings: nil, observation: decode(WorkerObservation.self, #"{"id":"studio","aliases":[],"observedAt":"2026-11-01T22:09:50.000Z","available":true,"reasons":[],"warnings":[],"health":{"complete":true,"os":"Darwin","model":"Mac13,1","cpuBrand":"Apple M1 Max","osVersion":"15.6","diskFreeBytes":43049885696,"memTotalBytes":34359738368,"memAvailableBytes":15249506304,"memPressureLevel":1,"cpuCount":10,"loadAverage":[1.44,1.82,1.97],"lock":{"state":"free"}}}"#),
                                   status: WorkerStatus(condition: .available, detail: nil, job: nil, reservation: nil), kind: .macStudio, isDefault: false)
        let board = VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(workers + [available]) { worker in
                    DeviceCard(worker: worker, limits: worker.settings?.limits, now: Date(timeIntervalSince1970: 1_793_570_996)).frame(width: 340)
                }
            }
            VStack(spacing: 6) {
                OperationStrip(store: store, operation: UIFixture.operation("aaaaaaaaaaaaaaaaaaaaaaaa"))
                if let run = store.runs?.runs.first { RunStrip(store: store, run: run) }
                OperationStrip(store: store, operation: UIFixture.operation("cccccccccccccccccccccccc", status: "complete", exitCode: 4, finishedAt: "2026-11-01T22:07:00.000Z", machine: nil))
                OperationStrip(store: store, operation: UIFixture.operation("dddddddddddddddddddddddd", status: "complete", exitCode: 1, outcome: "failed", finishedAt: "2026-11-01T22:07:00.000Z"))
                OperationStrip(store: store, operation: UIFixture.operation("eeeeeeeeeeeeeeeeeeeeeeee", status: "complete", exitCode: 2, outcome: "aborted", finishedAt: "2026-11-01T22:07:00.000Z"))
                OperationStrip(store: store, operation: UIFixture.operation("ffffffffffffffffffffffff", status: "complete", exitCode: 5, outcome: "error", finishedAt: "2026-11-01T22:07:00.000Z"))
            }
            .frame(width: 760)
        }
        func write<V: View>(_ view: V, _ name: String, scheme: ColorScheme) throws {
            let renderer = ImageRenderer(content: view.padding(24).background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme).environment(\.fleetInlineScroll, true))
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(scheme == .light ? "light" : "dark").png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        for scheme in [ColorScheme.light, .dark] {
            try write(board, "faceplates", scheme: scheme)
            try write(WorkerDetailView(store: store, workerID: "desk").frame(width: 980), "worker-detail", scheme: scheme)
            try write(OverviewView(store: store).frame(width: 1100), "overview", scheme: scheme)
            try write(LocationSettings(store: store, preferences: store.preferences).frame(width: 600), "locations", scheme: scheme)
        }
    }

    func testSetupAndServiceStatesRender() async throws {
        let store = try await loadedStore()
        _ = render(ServiceDownView(store: store, problem: nil), width: 700, scheme: .light)
        _ = render(ServiceDownView(store: store, problem: "Another program owns The Fleet's socket."), width: 700, scheme: .dark)
        _ = render(OutdatedServiceBanner(), width: 700, scheme: .light)
        _ = render(NoPairingsView(found: false, configPath: "/tmp/config", retry: {}), width: 300, scheme: .dark)
        _ = render(NoProjectsView(), width: 640, scheme: .light)
        _ = render(FleetHelpView(), width: 680, scheme: .dark)
        _ = render(LocationSettings(store: store, preferences: store.preferences).frame(height: 550), width: 600, scheme: .light)
        _ = render(LocationSettings(store: store, preferences: store.preferences).frame(height: 550), width: 600, scheme: .dark)
    }

    func testAppUpdateControlsRenderWithoutAServiceOrLiveFeed() {
        // XCTest has no app feed/key, so this draws the actual settings without
        // starting Sparkle, touching the service, or downloading an update.
        let updater = FleetAppUpdater()
        XCTAssertFalse(updater.canCheck)
        _ = render(AppUpdateSettings(updater: updater), width: 560, scheme: .light)
        _ = render(AppUpdateSettings(updater: updater), width: 560, scheme: .dark)
    }
}
