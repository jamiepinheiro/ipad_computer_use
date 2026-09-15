import Foundation
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Retains no video buffers. Only a requested next frame is converted to JPEG.
final class FrameCapture: @unchecked Sendable {
    private struct Pending {
        let id: UUID
        let continuation: CheckedContinuation<ScreenShot, Error>
        var encoding = false
    }
    private let lock = NSLock()
    private var pending: Pending?
    private var enabled = false
    private let context = CIContext(options: [.useSoftwareRenderer: true, .cacheIntermediates: false])

    func setEnabled(_ value: Bool) {
        lock.lock()
        enabled = value
        let previous = value ? nil : pending
        if !value { pending = nil }
        lock.unlock()
        previous?.continuation.resume(throwing: RelayError(message: "Screen broadcast paused or stopped"))
    }

    func request() async throws -> ScreenShot {
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if Task.isCancelled || !enabled || pending != nil {
                    lock.unlock()
                    continuation.resume(throwing: RelayError(message: "Screen capture unavailable or busy"))
                    return
                }
                pending = Pending(id: id, continuation: continuation)
                lock.unlock()
                Task {
                    try? await Task.sleep(for: .seconds(5))
                    self.finish(id: id, result: .failure(RelayError(message: "No fresh screen frame received")))
                }
            }
        } onCancel: {
            self.finish(id: id, result: .failure(CancellationError()))
        }
    }

    private func finish(id: UUID, result: Result<ScreenShot, Error>) {
        lock.lock()
        let current = pending?.id == id ? pending : nil
        if current != nil { pending = nil }
        lock.unlock()
        current?.continuation.resume(with: result)
    }

    func consume(_ sample: CMSampleBuffer, orientation: CGImagePropertyOrientation) {
        lock.lock()
        guard enabled, var current = pending, !current.encoding else { lock.unlock(); return }
        current.encoding = true
        pending = current
        lock.unlock()
        let capturedAt = Date().timeIntervalSince1970 * 1000
        let result: Result<ScreenShot, Error> = autoreleasepool {
            do {
                guard let buffer = CMSampleBufferGetImageBuffer(sample) else { throw RelayError(message: "Missing video frame") }
                var image = CIImage(cvPixelBuffer: buffer).oriented(orientation)
                let scale = min(1, 1280 / max(image.extent.width, image.extent.height))
                image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                guard let cgImage = context.createCGImage(image, from: image.extent.integral,
                    format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else {
                    throw RelayError(message: "Could not render screenshot")
                }
                let data = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
                    throw RelayError(message: "Could not create JPEG")
                }
                CGImageDestinationAddImage(destination, cgImage, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
                guard CGImageDestinationFinalize(destination), data.length <= 2 * 1024 * 1024 else {
                    throw RelayError(message: "Screenshot encoding failed or exceeded size limit")
                }
                return .success(ScreenShot(jpeg: data as Data, width: cgImage.width, height: cgImage.height,
                                           capturedAt: capturedAt, frameID: UUID().uuidString))
            } catch { return .failure(error) }
        }
        context.clearCaches()
        finish(id: current.id, result: result)
    }
}
