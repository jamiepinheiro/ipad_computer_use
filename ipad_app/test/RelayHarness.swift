import Foundation

// Runs the exact app networking implementation against a simulated dongle.
@main struct RelayHarness {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        let relay = RelayConnection(dongle: DongleClient(baseURL: URL(string: args[2])!))
        relay.screenshotProvider = {
            ScreenShot(jpeg: Data([255,216,255,217]), width: 10, height: 20,
                       capturedAt: Date().timeIntervalSince1970 * 1000, frameID: "native-frame")
        }
        relay.connect(address: args[1], name: "Swift integration test",
                      deviceID: args.count > 4 ? args[4] : nil, sessionID: args.count > 3 ? args[3] : nil)
        await relay.reportActivity(updating: false)
        try? await Task.sleep(for: .seconds(30))
        relay.disconnect()
    }
}
