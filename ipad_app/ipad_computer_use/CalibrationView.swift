import SwiftUI
import UIKit

@MainActor @Observable
final class CalibrationConnection {
    var connected = false
    var running = false
    var status = "Connecting"
    var connectionError: String?
    var pointer: CGPoint?
    var target: CGPoint?
    var lastClick: CGPoint?
    var error: Double?
    var hits = 0
    var clicks = 0
    var size = CGSize.zero
    var completed = 0
    var total = 19
    var startedAt: Date?
    private var autoStarted = false
    private var socket: URLSessionWebSocketTask?
    private var connectionURL: URL?
    private var reader: Task<Void, Never>?
    private var outbound: Task<Void, Never>?
    private var lastRevision = -1
    private let deviceID = SharedConfiguration.localDeviceID()

    func connect(address: String) {
        guard socket == nil else { return }
        connectionError = nil
        status = "Connecting"
        guard var url = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["ws", "wss"].contains(url.scheme), url.host != nil,
              url.user == nil, url.password == nil else {
            status = "Set the control server connection first"; return
        }
        // Local development uses a second port; TLS deployments route /native on the same origin.
        if url.scheme == "ws" { url.port = 8766 }
        url.path = "/native"; url.query = nil; url.fragment = nil
        guard let endpoint = url.url else { status = "Invalid control server address"; return }
        connectionURL = endpoint
        let request = URLRequest(url: endpoint)
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task; task.resume()
        reader = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = json["type"] as? String else { continue }
                    switch type {
                    case "ready":
                        self.connected = true; self.status = "Ready"
                        self.publish("viewport")
                        self.startWhenReady()
                    case "target":
                        if let t = json["target"] as? [String: Any], let x = t["x"] as? Double, let y = t["y"] as? Double {
                            self.target = CGPoint(x: x, y: y)
                        }
                    case "ack":
                        self.clicks = json["clicks"] as? Int ?? 0
                        if let click = json["lastClick"] as? [String: Any], let revision = click["revision"] as? Int,
                           revision != self.lastRevision {
                            self.lastRevision = revision
                            self.error = click["error"] as? Double
                            if click["hit"] as? Bool == true { self.hits += 1 }
                            if let x = click["x"] as? Double, let y = click["y"] as? Double { self.lastClick = CGPoint(x: x, y: y) }
                        }
                    case "run":
                        self.running = json["running"] as? Bool ?? false
                        self.status = json["status"] as? String ?? "Ready"
                        if let completed = json["completed"] as? Int { self.completed = completed }
                        if let total = json["total"] as? Int, total > 0 { self.total = total }
                        if let maxError = json["maxError"] as? Double { self.error = maxError }
                    default: break
                    }
                }
            } catch {
                guard let self, self.socket === task else { return }
                self.connected = false; self.running = false
                self.status = "Disconnected: " + error.localizedDescription
                self.connectionError = ConnectionDiagnostics.describe(error, task: task, endpoint: endpoint)
                task.cancel(with: .goingAway, reason: nil); self.socket = nil
            }
        }
    }

    private func send(_ value: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return }
        let previous = outbound
        outbound = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, self?.socket === socket else { return }
            do { try await socket.send(.string(text)) }
            catch {
                if self?.socket === socket {
                    self?.status = "Connection interrupted"
                    self?.connectionError = ConnectionDiagnostics.describe(error, task: socket, endpoint: self?.connectionURL)
                }
            }
        }
    }

    func publish(_ type: String) {
        guard connected, size.width > 0, size.height > 0 else { return }
        send(["type": type, "x": pointer.map { $0.x as Any } ?? NSNull(),
              "y": pointer.map { $0.y as Any } ?? NSNull(), "width": size.width, "height": size.height,
              "dpr": UIScreen.main.scale, "pointerType": "mouse", "deviceID": deviceID])
    }
    func resize(_ size: CGSize) {
        guard self.size != size else { return }
        self.size = size; pointer = nil; target = nil; publish("viewport")
        startWhenReady()
    }
    private func startWhenReady() {
        guard !autoStarted, connected, size.width > 0, size.height > 0 else { return }
        start()
    }
    func start() {
        guard connected, !running, size.width > 0, size.height > 0 else { return }
        autoStarted = true
        completed = 0; total = 19; startedAt = Date()
        hits = 0; clicks = 0; error = nil; lastClick = nil; target = nil; lastRevision = -1
        running = true; status = "Starting"; send(["type": "start"])
    }
    func stop() { send(["type": "stop"]); status = "Stopping" }
    func disconnect() {
        reader?.cancel(); outbound?.cancel()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false; running = false
    }
}

struct CalibrationView: View {
    let address: String
    var onCompleted: (() -> Void)? = nil
    @State private var connection = CalibrationConnection()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack(alignment: .top) {
            CalibrationSurface(connection: connection).ignoresSafeArea()
            VStack(spacing: 8) {
                HStack {
                    Text("Pointer Calibration").font(.headline)
                    Spacer()
                    if !connection.connected && connection.status == "Connecting" { ProgressView().controlSize(.small) }
                    Text(connection.status).font(.caption).lineLimit(2)
                    Button {
                        if connection.running { connection.stop() }
                        else if !connection.connected { connection.connect(address: address) }
                        else { connection.start() }
                    } label: {
                        Image(systemName: connection.running ? "stop.fill" : "arrow.clockwise").frame(width: 44, height: 44)
                    }
                        .accessibilityLabel(connection.running ? "Stop calibration" : "Retry calibration")
                    Button { connection.disconnect(); dismiss() } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }.accessibilityLabel("Close calibration")
                }
                if let details = connection.connectionError {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Connection Error").font(.headline)
                            Spacer()
                            Button { UIPasteboard.general.string = details } label: {
                                Image(systemName: "doc.on.doc")
                            }.accessibilityLabel("Copy full error details")
                        }
                        ScrollView {
                            Text(details).font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }.frame(maxHeight: 300)
                    }.padding(12).background(Color(uiColor: .secondarySystemBackground))
                }
                if connection.running || connection.completed == connection.total {
                    ProgressView(value: Double(connection.completed), total: Double(connection.total))
                        .accessibilityLabel("Calibration progress")
                    HStack {
                        if connection.running { ProgressView().controlSize(.small) }
                        Text("\(connection.completed) of \(connection.total) steps").font(.caption.monospacedDigit())
                        Spacer()
                        if connection.running, let start = connection.startedAt {
                            Text(start, style: .timer).font(.caption.monospacedDigit())
                                .accessibilityLabel("Elapsed calibration time")
                        }
                    }.allowsHitTesting(false)
                }
                HStack {
                    metric("Pointer", connection.pointer.map { String(format: "%.1f, %.1f", $0.x, $0.y) } ?? "--")
                    Spacer()
                    metric("Target", connection.target.map { String(format: "%.0f, %.0f", $0.x, $0.y) } ?? "--")
                    Spacer()
                    metric("Error", connection.error.map { String(format: "%.2f pt", $0) } ?? "--")
                    Spacer()
                    metric("Hits", "\(connection.hits) / \(connection.clicks)")
                }.allowsHitTesting(false)
            }
            .padding(.horizontal, 20).padding(.bottom, 12)
            .background(Color(uiColor: .systemBackground))
        }
        .task { connection.connect(address: address) }
        .onDisappear { connection.disconnect() }
        .onChange(of: connection.status) { _, status in
            if status == "Calibration complete", !connection.running,
               connection.completed == connection.total {
                onCompleted?()
            }
        }
        .onChange(of: phase) { _, phase in
            if phase != .active { connection.disconnect(); connection.status = "Paused" }
            else { connection.connect(address: address) }
        }
    }
    private func metric(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.callout.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
        }
    }
}

private struct CalibrationSurface: UIViewRepresentable {
    let connection: CalibrationConnection
    func makeUIView(context: Context) -> PointerSurface {
        let view = PointerSurface()
        view.onSize = { connection.resize($0) }
        view.onPointer = { point, click in
            connection.pointer = point; connection.publish(click ? "click" : "pointer")
        }
        return view
    }
    func updateUIView(_ view: PointerSurface, context: Context) {
        view.target = connection.target; view.pointer = connection.pointer
        view.lastClick = connection.lastClick; view.setNeedsDisplay()
    }
    static func dismantleUIView(_ view: PointerSurface, coordinator: ()) { view.detachHover() }
}

private final class PointerSurface: UIView {
    var onSize: ((CGSize) -> Void)?
    var onPointer: ((CGPoint, Bool) -> Void)?
    var target: CGPoint?
    var pointer: CGPoint?
    var lastClick: CGPoint?
    private weak var hoverWindow: UIWindow?
    private lazy var hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemGroupedBackground
        hover.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        hover.cancelsTouchesInView = false
        let click = UITapGestureRecognizer(target: self, action: #selector(clicked(_:)))
        click.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        addGestureRecognizer(click)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        detachHover()
        // Observe the header too, so clicking Start gives us a current pointer origin.
        hoverWindow = window; window?.addGestureRecognizer(hover)
    }
    func detachHover() { hoverWindow?.removeGestureRecognizer(hover); hoverWindow = nil }
    override func layoutSubviews() { super.layoutSubviews(); onSize?(bounds.size); setNeedsDisplay() }
    @objc private func hovered(_ recognizer: UIHoverGestureRecognizer) {
        let point = recognizer.location(in: self)
        if (recognizer.state == .began || recognizer.state == .changed) && bounds.contains(point) { onPointer?(point, false) }
    }
    @objc private func clicked(_ recognizer: UITapGestureRecognizer) {
        if recognizer.state == .ended { onPointer?(recognizer.location(in: self), true) }
    }
    override func draw(_ rect: CGRect) {
        guard let c = UIGraphicsGetCurrentContext() else { return }
        c.setStrokeColor(UIColor.separator.withAlphaComponent(0.25).cgColor); c.setLineWidth(0.5)
        for x in stride(from: CGFloat(0), to: bounds.width, by: 50) { c.move(to: CGPoint(x: x, y: 0)); c.addLine(to: CGPoint(x: x, y: bounds.height)) }
        for y in stride(from: CGFloat(0), to: bounds.height, by: 50) { c.move(to: CGPoint(x: 0, y: y)); c.addLine(to: CGPoint(x: bounds.width, y: y)) }
        c.strokePath()
        if let target {
            c.setFillColor(UIColor.systemPink.cgColor)
            c.fillEllipse(in: CGRect(x: target.x - 18, y: target.y - 18, width: 36, height: 36))
            c.setStrokeColor(UIColor.white.cgColor); c.setLineWidth(2)
            c.move(to: CGPoint(x: target.x - 9, y: target.y)); c.addLine(to: CGPoint(x: target.x + 9, y: target.y))
            c.move(to: CGPoint(x: target.x, y: target.y - 9)); c.addLine(to: CGPoint(x: target.x, y: target.y + 9)); c.strokePath()
        }
        if let lastClick {
            c.setStrokeColor(UIColor.systemGreen.cgColor); c.setLineWidth(2)
            c.strokeEllipse(in: CGRect(x: lastClick.x - 24, y: lastClick.y - 24, width: 48, height: 48))
        }
        if let pointer {
            c.setStrokeColor(UIColor.systemTeal.cgColor); c.setLineWidth(1)
            c.strokeEllipse(in: CGRect(x: pointer.x - 8, y: pointer.y - 8, width: 16, height: 16))
        }
    }
}
