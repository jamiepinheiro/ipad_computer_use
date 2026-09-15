import Foundation

enum ConnectionDiagnostics {
    static func describe(_ error: Error, task: URLSessionWebSocketTask, endpoint: URL? = nil) -> String {
        let failure = error as NSError
        var lines = [
            "URL: \((endpoint ?? task.originalRequest?.url ?? task.currentRequest?.url)?.absoluteString ?? "unavailable")",
            "Error domain: \(failure.domain)",
            "Error code: \(failure.code)",
            "Description: \(failure.localizedDescription)",
            "Error details: \(String(reflecting: failure.userInfo))",
            "WebSocket close code: \(task.closeCode.rawValue)",
            "WebSocket close reason: \(task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? "not supplied")"
        ]
        if let response = task.response as? HTTPURLResponse {
            lines.append("HTTP status: \(response.statusCode)")
            lines.append("HTTP headers: \(String(reflecting: response.allHeaderFields))")
        } else {
            lines.append("HTTP response: not provided by URLSession")
        }
        return lines.joined(separator: "\n")
    }
}

struct RelayError: LocalizedError, CustomNSError {
    let message: String
    var errorDescription: String? { message }
    static var errorDomain: String { "iPadComputerUse" }
    var errorCode: Int { 1 }
    var errorUserInfo: [String: Any] { [NSLocalizedDescriptionKey: message] }
}

struct DongleStatus: Decodable {
    let device: String?
    let running: Bool
    let state: String
    let hidReady: Bool
}

actor DongleClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = URL(string: "http://172.31.254.1")!) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 5
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    private func request(_ path: String, secret: String? = nil, body: String? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        if let secret {
            request.httpMethod = "POST"
            request.setValue(secret, forHTTPHeaderField: "X-Input-Device-Secret")
            request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
            request.httpBody = (body ?? "").data(using: .utf8)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw RelayError(message: "XIAO rejected the request: \(String(data: data, encoding: .utf8) ?? "unknown error")")
        }
        return data
    }

    func status() async throws -> DongleStatus {
        try JSONDecoder().decode(DongleStatus.self, from: await request("status"))
    }

    func run(hex: String, secret: String) async throws {
        guard !hex.isEmpty, hex.count <= 5120, hex.count.isMultiple(of: 10),
              hex.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw RelayError(message: "Invalid input records")
        }
        _ = try await request("input", secret: secret, body: hex)
    }

    func stop(secret: String) async throws { _ = try await request("stop", secret: secret) }
}
