import Foundation
import CoreMedia
import CoreVideo
import ImageIO

@main struct FrameHarness {
    static func main() async throws {
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 2560, 1280, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel, [])
        let bytes = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pixel)
        for y in 0..<1280 {
            for x in 0..<2560 {
                let i = y * stride + x * 4
                bytes[i] = 0; bytes[i + 1] = x < 1280 ? 0 : 255
                bytes[i + 2] = x < 1280 ? 255 : 0; bytes[i + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        var description: CMVideoFormatDescription?
        precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixel,
            formatDescriptionOut: &description) == noErr)
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixel,
            formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr)
        let capture = FrameCapture()
        capture.setEnabled(true)
        for orientation in [CGImagePropertyOrientation.up, .right] {
            let request = Task { try await capture.request() }
            try await Task.sleep(for: .milliseconds(30))
            capture.consume(sample!, orientation: orientation)
            let shot = try await request.value
            precondition(shot.width == (orientation == .up ? 1280 : 640))
            precondition(shot.height == (orientation == .up ? 640 : 1280))
            let source = CGImageSourceCreateWithData(shot.jpeg as CFData, nil)!
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
            precondition(image.width == shot.width && image.height == shot.height)
            precondition(shot.jpeg.count > 1000)
            try shot.jpeg.write(to: URL(fileURLWithPath: "build/frame-test-\(orientation.rawValue).jpg"))
        }
        let cancelled = Task { try await capture.request() }
        try await Task.sleep(for: .milliseconds(20)); cancelled.cancel()
        do { _ = try await cancelled.value; preconditionFailure("Expected cancellation") } catch {}
        let paused = Task { try await capture.request() }
        try await Task.sleep(for: .milliseconds(20)); capture.setEnabled(false)
        do { _ = try await paused.value; preconditionFailure("Expected pause failure") } catch {}
        print("Real frame encoding, scaling, orientation, cancellation, and pause tests passed.")
    }
}
