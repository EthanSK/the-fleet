// The desktop app updates through Sparkle; the separately owned coordinator
// keeps its existing socket, settings, jobs and process across an app restart.
import AppKit
import Combine
import Sparkle

@MainActor public final class FleetAppUpdater: NSObject, ObservableObject {
    @Published public private(set) var canCheck = false
    private var controller: SPUStandardUpdaterController?
    private var observations = Set<AnyCancellable>()

    public override init() {
        super.init()
        guard let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false,
            updaterDelegate: nil, userDriverDelegate: nil)
        self.controller = controller
        controller.updater.publisher(for: \.canCheckForUpdates)
            .sink { [weak self] in self?.canCheck = $0 }.store(in: &observations)
        controller.updater.publisher(for: \.automaticallyChecksForUpdates)
            .sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &observations)
        controller.updater.publisher(for: \.automaticallyDownloadsUpdates)
            .sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &observations)
        controller.startUpdater()
    }

    public var automaticChecks: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set { controller?.updater.automaticallyChecksForUpdates = newValue }
    }
    public var automaticDownloads: Bool {
        get { controller?.updater.automaticallyDownloadsUpdates ?? false }
        set { controller?.updater.automaticallyDownloadsUpdates = newValue }
    }
    public func checkForUpdates() {
        guard canCheck else { return }
        controller?.checkForUpdates(nil)
    }
}
