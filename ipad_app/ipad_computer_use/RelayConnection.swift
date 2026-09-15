import Foundation
import Observation

private struct RelayMessage: Decodable {
    let type: String
    let id: String?
    let hex: String?
    let inputDeviceSecret: String?
}

struct ScreenShot {
    let jpeg: Data
    let width: Int
    let height: Int
    let capturedAt: Double
    let frameID: String
}

@MainActor @Observable
final class RelayConnection {
    private(set) var status = "Disconnected"
    private(set) var dongleStatus = "Not checked"
    private(set) var lastResult = "None"
    private(set) var connected = false
    private(set) var connecting = false
    private(set) var busy = false
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var execution: Task<Void, Never>?
    private var screenTask: Task<Void, Never>?
    var screenshotProvider: (() async throws -> ScreenShot)?
    var onDisconnect: ((String) -> Void)?
    var onState: ((String) -> Void)?
    var onSessionEnded: (() -> Void)?
    private var inputDeviceSecret: String?
    private var activeSecret: String?
    private var commandID: String?
    private var seenIDs = Set<String>()
    private let dongle: DongleClient
    private let session = URLSession(configuration: .ephemeral)

    init(dongle: DongleClient = DongleClient()) { self.dongle = dongle }

    func checkDongle() async {
        do {
            let state = try await dongle.status()
            dongleStatus = state.running ? "Busy" : (state.hidReady ? "Ready" : "Keyboard not ready")
        } catch { dongleStatus = error.localizedDescription }
    }

    func connect(address: String, name: String, deviceID: String? = nil, sessionID: String? = nil) {
        guard socket == nil, !busy else { return }
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["ws", "wss"].contains(url.scheme), url.host != nil, url.path == "/device",
              url.user == nil, url.password == nil, url.query == nil else {
            status = "Enter a ws://host:8765/device URL"; return
        }
        let request = URLRequest(url: url)
        let ws = session.webSocketTask(with: request)
        ws.maximumMessageSize = 16384
        socket = ws
        connected = false
        connecting = true
        status = "Connecting"
        ws.resume()
        receiver = Task {
            do {
                var hello: [String: Any] = ["type": "hello", "name": name,
                                           "capabilities": screenshotProvider == nil ? ["input"] : ["input", "screen"]]
                if let deviceID { hello["deviceID"] = deviceID }
                if let sessionID { hello["sessionID"] = sessionID }
                try await send(hello, on: ws)
                while !Task.isCancelled {
                    let message = try await ws.receive()
                    let data: Data
                    switch message {
                    case .data(let value): data = value
                    case .string(let value): data = Data(value.utf8)
                    @unknown default: throw RelayError(message: "Unsupported message")
                    }
                    let command = try JSONDecoder().decode(RelayMessage.self, from: data)
                    guard socket === ws else { return }
                    switch command.type {
                    case "ready":
                        inputDeviceSecret = command.inputDeviceSecret
                        connected = true; connecting = false; status = "Connected"
                        onState?("Ready")
                    case "end-session":
                        let stopped = await endInput()
                        try await send(["type": "session-ended", "stopConfirmed": stopped], on: ws)
                        disconnect(reason: stopped ? "Session ended" : "Input stop unconfirmed")
                        onSessionEnded?()
                        return
                    case "run":
                        guard connected, let id = command.id, let hex = command.hex else {
                            throw RelayError(message: "Invalid command")
                        }
                        if busy || seenIDs.contains(id) {
                            try await send(["type": "failed", "id": id, "error": "Busy or duplicate command"], on: ws)
                            continue
                        }
                        // A new socket is never allowed to replay a previously seen command.
                        guard seenIDs.count < 10000 else { throw RelayError(message: "Session limit reached. Restart the app.") }
                        seenIDs.insert(id)
                        busy = true; commandID = id
                        execution = Task { await execute(id: id, hex: hex, on: ws) }
                    case "screen":
                        guard let id = command.id else { throw RelayError(message: "Missing screenshot ID") }
                        guard let provider = screenshotProvider, screenTask == nil else {
                            try await send(["type": "failed", "id": id, "error": "Screen capture unavailable or busy"], on: ws)
                            continue
                        }
                        screenTask = Task {
                            defer { screenTask = nil }
                            do {
                                let shot = try await provider()
                                try Task.checkCancellation()
                                try await send(["type": "screenshot", "id": id, "mimeType": "image/jpeg",
                                                "data": shot.jpeg.base64EncodedString(), "width": shot.width,
                                                "height": shot.height, "capturedAt": shot.capturedAt, "frameID": shot.frameID], on: ws)
                            } catch {
                                try? await send(["type": "failed", "id": id, "error": error.localizedDescription], on: ws)
                            }
                        }
                    case "stop": execution?.cancel()
                    default: throw RelayError(message: "Unknown relay message")
                    }
                }
            } catch {
                if socket === ws {
                    let closeReason = ws.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                    let reason = closeReason?.isEmpty == false ? closeReason! : error.localizedDescription
                    disconnect(reason: reason)
                    onDisconnect?(reason)
                }
            }
        }
    }

    private func send(_ object: [String: Any], on ws: URLSessionWebSocketTask) async throws {
        guard socket === ws else { throw CancellationError() }
        guard object["type"] as? String == "hello" || connected else {
            throw RelayError(message: "Waiting for the control server handshake")
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        try await ws.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func execute(id: String, hex: String, on ws: URLSessionWebSocketTask) async {
        defer { busy = false; execution = nil; activeSecret = nil; commandID = nil; onState?(connected ? "Ready" : "Disconnected") }
        var attempted = false
        do {
            guard let secret = inputDeviceSecret, !secret.isEmpty else { throw RelayError(message: "Input device secret missing") }
            let initial = try await dongle.status()
            try Task.checkCancellation()
            guard !initial.running, initial.hidReady else { throw RelayError(message: "XIAO is busy or its keyboard is not ready") }
            activeSecret = secret
            attempted = true
            try await dongle.run(hex: hex, secret: secret)
            try Task.checkCancellation()
            dongleStatus = "Typing"
            lastResult = "Accepted by XIAO"
            onState?("Sending input")
            try await send(["type": "accepted", "id": id], on: ws)
            let deadline = Date().addingTimeInterval(75)
            while Date() < deadline {
                try await Task.sleep(for: .milliseconds(250))
                let state = try await dongle.status()
                try Task.checkCancellation()
                if !state.running {
                    guard state.state == "done" else { throw RelayError(message: "Sequence stopped before completion") }
                    lastResult = "Completed"
                    dongleStatus = "Ready"
                    try await send(["type": "completed", "id": id], on: ws)
                    return
                }
            }
            throw RelayError(message: "XIAO completion timed out; result unknown")
        } catch {
            // Cleanup uses a new task because the execution task may already be cancelled.
            if attempted, let secret = activeSecret {
                let cleanup = Task { try await dongle.stop(secret: secret) }
                do { try await cleanup.value }
                catch { dongleStatus = "Stop unconfirmed. Unplug XIAO to stop input." }
            }
            let message = Task.isCancelled ? "Cancelled; some keys may already have been sent" : error.localizedDescription
            lastResult = message
            try? await send(["type": "failed", "id": id, "error": message], on: ws)
        }
    }

    func stop() { execution?.cancel() }

    func reportActivity(updating: Bool) async {
        guard connected, let socket else { return }
        try? await send(["type": "activity-status", "updating": updating], on: socket)
    }

    func endInput() async -> Bool {
        execution?.cancel()
        await execution?.value
        do {
            guard let secret = inputDeviceSecret, !secret.isEmpty else { return false }
            _ = try await dongle.status()
            try await dongle.stop(secret: secret)
            let final = try await dongle.status()
            return !final.running
        } catch { return false }
    }

    func disconnect(reason: String = "Disconnected") {
        receiver?.cancel(); receiver = nil
        execution?.cancel()
        screenTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false; connecting = false; status = reason
        inputDeviceSecret = nil
    }
}
