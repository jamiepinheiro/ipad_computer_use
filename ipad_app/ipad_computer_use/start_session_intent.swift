import AppIntents
import Observation

@MainActor @Observable
final class SessionLaunchRequest {
    static let shared = SessionLaunchRequest()
    private(set) var revision = 0
    private(set) var pending = false
    var handling = false

    func request() {
        guard !pending, !handling else { return }
        pending = true
        revision += 1
    }

    func consume() -> Bool {
        guard pending else { return false }
        pending = false
        return true
    }
}

struct StartSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Start iPad Computer Use Session"
    static let description = IntentDescription("Open iPad Computer Use and request screen sharing for a session.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        SessionLaunchRequest.shared.request()
        return .result()
    }
}

struct ComputerUseShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartSessionIntent(),
                    phrases: ["Start a session in \(.applicationName)"],
                    shortTitle: "Start Session", systemImageName: "cursorarrow.motionlines")
    }
}
