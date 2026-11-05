// Verify the final bundle's loader before SwiftUI or service discovery starts.
// Normal launches still use TheFleetApp's existing SwiftUI lifecycle.
import Foundation

if CommandLine.arguments.contains("--check-packaged-launch") {
    let info = Bundle.main.infoDictionary ?? [:]
    let value = ["packagedLaunch": "ok", "version": info["CFBundleShortVersionString"] as? String ?? "dev",
                 "build": info["CFBundleVersion"] as? String ?? "dev"]
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

TheFleetApp.main()
