import ReplayKit
import ImageIO

final class SampleHandler: RPBroadcastSampleHandler {
    private let capture = FrameCapture()
    private let lifecycleLock = NSLock()
    private var generation = 0
    @MainActor private var relay: RelayConnection?
    @MainActor private var monitor: Task<Void, Never>?
    @MainActor private var sessionID: String?
    @MainActor private var activityStatus = "Starting"

    private func nextGeneration() -> Int {
        lifecycleLock.lock(); defer { lifecycleLock.unlock() }
        generation += 1
        return generation
    }

    private func isCurrent(_ value: Int) -> Bool {
        lifecycleLock.lock(); defer { lifecycleLock.unlock() }
        return generation == value
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        startConnection()
    }

    private func startConnection() {
        let current = nextGeneration()
        capture.setEnabled(true)
        Task { @MainActor in
            guard isCurrent(current) else { return }
            relay?.disconnect()
            do {
                let configuration = try SharedConfiguration.load()
                guard let id = configuration.sessionID else { throw RelayError(message: "Start a session in iPad Computer Use first") }
                sessionID = id
                let connection = RelayConnection()
                connection.screenshotProvider = { [capture] in try await capture.request() }
                connection.onDisconnect = { [weak self] error in
                    guard let self, self.isCurrent(current) else { return }
                    self.capture.setEnabled(false)
                    self.stopConnection()
                    self.finishWithDiagnostic("Control server connection ended: \(error)")
                }
                connection.onState = { [weak self] state in
                    guard let self, self.isCurrent(current) else { return }
                    self.activityStatus = state == "Ready" ? "Session active" : state
                    Task { await SessionActivity.update(id, status: self.activityStatus) }
                }
                connection.onSessionEnded = { [weak self] in
                    guard let self, self.isCurrent(current) else { return }
                    self.stopConnection()
                    self.finishBroadcastWithError(RelayError(message: "Session ended"))
                }
                relay = connection
                connection.connect(address: configuration.address, name: "iPad Session", deviceID: configuration.deviceID, sessionID: id)
                if !connection.connecting { throw RelayError(message: connection.status) }
                monitor?.cancel()
                monitor = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, self.isCurrent(current) else { return }
                        if (try? SharedConfiguration.load().sessionID) != id {
                            self.stopConnection()
                            self.finishBroadcastWithError(RelayError(message: "Session ended")); return
                        }
                        let updating = await SessionActivity.update(id, status: self.activityStatus)
                        await connection.reportActivity(updating: updating)
                        do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    }
                }
            } catch {
                stopConnection()
                finishWithDiagnostic("Could not start screen sharing: \(error.localizedDescription)")
            }
        }
    }

    private func finishWithDiagnostic(_ message: String) {
        SharedConfiguration.recordBroadcastError(message)
        // Pass an explicit Foundation error across ReplayKit's process boundary.
        finishBroadcastWithError(NSError(domain: RelayError.errorDomain, code: 1,
                                         userInfo: [NSLocalizedDescriptionKey: message]))
    }

    override func broadcastPaused() {
        stopConnection()
    }

    override func broadcastResumed() { startConnection() }

    override func broadcastFinished() {
        stopConnection()
    }

    private func stopConnection() {
        let current = nextGeneration()
        capture.setEnabled(false)
        Task { @MainActor in
            guard isCurrent(current) else { return }
            monitor?.cancel(); monitor = nil
            let connection = relay; relay = nil
            connection?.disconnect(reason: "Session ended")
            let stopped = await connection?.endInput() ?? true
            if let id = sessionID {
                await SessionActivity.end(id, status: stopped ? "Session ended" : "Input stop unconfirmed")
            }
            sessionID = nil
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        let raw = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?.uint32Value ?? 1
        capture.consume(sampleBuffer, orientation: CGImagePropertyOrientation(rawValue: raw) ?? .up)
    }
}
