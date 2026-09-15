import Foundation
import Observation

private struct DeviceSetupStatus: Decodable {
    let connected: Bool
    let pointerCalibrated: Bool
    let calibrating: Bool
    let screenBroadcast: Bool
    let sessionID: String?
    let sessionState: String?
    let sendingInput: Bool?
}

@MainActor @Observable
final class SetupStatus {
    var inputReady: Bool?
    var inputCompatible = false
    var inputDetail = "Checking USB connection"
    var serverConnected = false
    var serverDetail = "Not connected"
    var calibrated: Bool?
    var calibrating = false
    var screenBroadcast = false
    var serverReachable = false
    var sessionID: String?
    var sessionState = "idle"
    var sendingInput = false
    var checkingInput = false
    var checkingServer = false
    var checkingPointer = false
    var hasCheckedServer = false
    var retryDelay = 2
    var nextCheck: Date?
    var isChecking: Bool { checkingInput || checkingServer || checkingPointer }

    func retryNow() {
        retryDelay = 2
        nextCheck = nil
    }
    private var generation = 0
    private let dongle = DongleClient()
    private let session: URLSession

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 4
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = session ?? URLSession(configuration: configuration)
    }

    var readyCount: Int { (inputReady == true ? 1 : 0) + (serverConnected ? 1 : 0) + (calibrated == true ? 1 : 0) }
    var allReady: Bool { readyCount == 3 && !calibrating }
    var nextStep: Int { inputReady != true ? 0 : (!serverConnected ? 1 : 2) }

    func reset() {
        generation += 1
        inputReady = nil; inputDetail = "Checking USB connection"
        inputCompatible = false
        serverConnected = false; serverDetail = "Checking connection"
        calibrated = nil; calibrating = false; screenBroadcast = false
        serverReachable = false
        checkingInput = false; checkingServer = false; checkingPointer = false; hasCheckedServer = false
        retryNow()
    }

    func refresh(address: String, checkInput: Bool = true, background: Bool = false) async {
        generation += 1
        let current = generation
        let checkInput = checkInput && (!background || inputReady != true)
        let checkServer = !background || !serverReachable || calibrated != true || sessionID != nil
        checkingInput = checkInput
        checkingServer = checkServer && (!background || !serverReachable)
        checkingPointer = checkServer && (!background || calibrated != true)
        nextCheck = nil
        defer {
            if generation == current {
                checkingInput = false; checkingServer = false; checkingPointer = false
            }
        }
        if checkInput {
            do {
                let status = try await dongle.status()
                try Task.checkCancellation()
                guard generation == current else { return }
                inputReady = status.hidReady
                // Older working firmware uses different display names. Decoding
                // the required status fields checks the status protocol, not branding.
                inputCompatible = true
                inputDetail = status.hidReady ? (status.running ? "Input tool is sending input" : "XIAO RP2040 · USB") : "Input tool found; USB input not ready"
            } catch {
                guard !Task.isCancelled, generation == current else { return }
                inputReady = false
                inputCompatible = false
                if let error = error as? URLError {
                    switch error.code {
                    case .timedOut:
                        inputDetail = "Timed out reaching 172.31.254.1"
                    case .notConnectedToInternet, .networkConnectionLost:
                        inputDetail = "No route to 172.31.254.1"
                    case .cannotConnectToHost:
                        inputDetail = "Cannot connect to 172.31.254.1"
                    default:
                        inputDetail = "USB check failed: \(error.code.rawValue)"
                    }
                } else {
                    inputDetail = error.localizedDescription
                }
            }
        }
        guard !Task.isCancelled, generation == current else { return }
        checkingInput = false
        guard checkServer else { return }
        guard var url = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["ws", "wss"].contains(url.scheme), url.host != nil, url.path == "/device",
              url.user == nil, url.password == nil, url.query == nil else {
            serverConnected = false; serverDetail = "Connection details needed"
            serverReachable = false; hasCheckedServer = true
            calibrated = nil; calibrating = false; screenBroadcast = false; return
        }
        url.scheme = url.scheme == "wss" ? "https" : "http"
        url.path = "/device-status/" + SharedConfiguration.localDeviceID(); url.fragment = nil
        guard let endpoint = url.url else { return }
        do {
            let request = URLRequest(url: endpoint)
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                throw RelayError(message: "Server status unavailable")
            }
            let status = try JSONDecoder().decode(DeviceSetupStatus.self, from: data)
            try Task.checkCancellation()
            guard generation == current else { return }
            serverConnected = status.connected; calibrated = status.pointerCalibrated
            serverReachable = true; sessionID = status.sessionID; sessionState = status.sessionState ?? "idle"
            sendingInput = status.sendingInput ?? false
            calibrating = status.calibrating; screenBroadcast = status.screenBroadcast
            serverDetail = status.connected ? "Session connected" : "Available"
            hasCheckedServer = true
            retryDelay = 2
        } catch {
            guard !Task.isCancelled, generation == current else { return }
            serverConnected = false; calibrated = nil; calibrating = false; screenBroadcast = false
            serverReachable = false; sendingInput = false
            serverDetail = (error as? RelayError)?.message ?? "Control server not reachable"
            hasCheckedServer = true
            retryDelay = min(retryDelay * 2, 30)
        }
    }

    func sessionRequest(address: String, end id: String? = nil) async throws -> String? {
        guard var url = URLComponents(string: address), ["ws", "wss"].contains(url.scheme),
              url.host != nil, url.user == nil, url.password == nil else { throw RelayError(message: "Invalid control server address") }
        url.scheme = url.scheme == "wss" ? "https" : "http"
        url.path = id == nil ? "/session/start" : "/session/end"; url.query = nil; url.fragment = nil
        guard let endpoint = url.url else { throw RelayError(message: "Invalid control server address") }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = ["deviceID": SharedConfiguration.localDeviceID()]
        if let id { body["sessionID"] = id }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw RelayError(message: value?["error"] as? String ?? "Session request failed")
        }
        if id == nil {
            guard let created = value?["sessionID"] as? String, UUID(uuidString: created) != nil else {
                throw RelayError(message: "Invalid session response")
            }
            return created
        }
        return nil
    }
}
