// swift-tools-version: 5.10
// The Fleet desktop app: a native client of the one local The Fleet
// coordinator. It never runs jobs, stores worker settings or holds
// connection details itself; everything goes through the service's socket.
import PackageDescription

let package = Package(
    name: "TheFleetDesktop",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "TheFleet", targets: ["TheFleet"]),
        .executable(name: "fleet-app-icon", targets: ["FleetAppIcon"])
    ],
    targets: [
        // Socket client, API models and pure derivations (status, device kind,
        // formatting, discovery). No UI, so it is tested directly.
        .target(name: "FleetKit", path: "Sources/FleetKit"),

        // SwiftUI views and the observable store driving them.
        .target(name: "FleetUI", dependencies: ["FleetKit"], path: "Sources/FleetUI"),

        .executableTarget(name: "TheFleet", dependencies: ["FleetUI"], path: "Sources/TheFleet"),

        // Exports the canonical transparent PNG at every macOS .iconset size.
        .executableTarget(name: "FleetAppIcon", path: "Sources/FleetAppIcon"),

        .testTarget(name: "FleetKitTests", dependencies: ["FleetKit"], path: "Tests/FleetKitTests"),
        .testTarget(name: "FleetUITests", dependencies: ["FleetUI", "FleetKit"], path: "Tests/FleetUITests")
    ]
)
