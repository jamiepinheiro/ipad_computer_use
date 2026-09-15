import ActivityKit
import Foundation

struct SessionActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
    }
    let sessionID: String
}

@MainActor enum SessionActivity {
    private static var watchers: [String: Task<Void, Never>] = [:]
    private static var registrations: [String: (token: Data, date: Date)] = [:]
    private static var lastAttempt: [String: Date] = [:]
    private static var pushWarning: String?
    private static var pushEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "LiveActivityPushEnabled") as? String == "YES" }
    private static var freshness: TimeInterval { pushEnabled ? 180 : 20 }

    static func start(_ sessionID: String) async -> String? {
        for activity in Activity<SessionActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return "Live Activity unavailable" }
        do {
            _ = try Activity.request(attributes: SessionActivityAttributes(sessionID: sessionID),
                                     content: ActivityContent(state: .init(status: "Waiting for screen sharing"), staleDate: Date().addingTimeInterval(freshness)),
                                     pushType: pushEnabled ? .token : nil)
            return nil
        } catch { return "Live Activity unavailable" }
    }

    @discardableResult static func update(_ sessionID: String, status: String) async -> Bool {
        var found = false
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.sessionID == sessionID {
            found = true
            await activity.update(ActivityContent(state: .init(status: status), staleDate: Date().addingTimeInterval(freshness)))
        }
        return found
    }

    static func end(_ sessionID: String, status: String = "Session ended") async {
        for activity in Activity<SessionActivityAttributes>.activities where activity.attributes.sessionID == sessionID {
            await activity.end(ActivityContent(state: .init(status: status), staleDate: nil),
                               dismissalPolicy: status == "Session ended" ? .immediate : .default)
            watchers.removeValue(forKey: activity.id)?.cancel()
            registrations.removeValue(forKey: activity.id)
            lastAttempt.removeValue(forKey: activity.id)
        }
    }

    static func syncPush(address: String, deviceID: String) async -> String? {
        guard pushEnabled else { return "Background Live Activity updates require a push-enabled build." }
        let activities = Activity<SessionActivityAttributes>.activities
        let ids = Set(activities.map(\.id))
        for id in Array(watchers.keys) where !ids.contains(id) {
            watchers.removeValue(forKey: id)?.cancel()
            registrations.removeValue(forKey: id)
            lastAttempt.removeValue(forKey: id)
        }
        for activity in activities {
            if watchers[activity.id] == nil {
                watchers[activity.id] = Task {
                    for await pushToken in activity.pushTokenUpdates {
                        guard !Task.isCancelled else { return }
                        // Token rotation invalidates the previous registration immediately.
                        registrations.removeValue(forKey: activity.id)
                        lastAttempt.removeValue(forKey: activity.id)
                        await register(activity, pushToken: pushToken, address: address, deviceID: deviceID)
                    }
                }
            }
            if let pushToken = activity.pushToken {
                await register(activity, pushToken: pushToken, address: address, deviceID: deviceID)
            }
        }
        return pushWarning
    }

    private static func register(_ activity: Activity<SessionActivityAttributes>, pushToken: Data, address: String, deviceID: String) async {
        if let registered = registrations[activity.id], registered.token == pushToken,
           Date().timeIntervalSince(registered.date) < 60 { return }
        if let attempted = lastAttempt[activity.id], Date().timeIntervalSince(attempted) < 15 { return }
        lastAttempt[activity.id] = Date()
        guard var url = URLComponents(string: address), ["ws", "wss"].contains(url.scheme) else { return }
        url.scheme = url.scheme == "wss" ? "https" : "http"
        url.path = "/session/live-activity"; url.query = nil; url.fragment = nil
        guard let endpoint = url.url else { return }
        let environment = Bundle.main.object(forInfoDictionaryKey: "LiveActivityPushEnvironment") as? String
        var request = URLRequest(url: endpoint, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceID": deviceID, "sessionID": activity.attributes.sessionID,
            "pushToken": pushToken.map { String(format: "%02x", $0) }.joined(),
            "environment": environment == "production" ? "production" : "sandbox"
        ])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 202 else {
                pushWarning = "Live Activity push updates are unavailable. Check the control server's APNs settings."
                return
            }
            registrations[activity.id] = (pushToken, Date())
            pushWarning = nil
        } catch {
            pushWarning = "Live Activity push registration could not reach the control server."
        }
    }
}
