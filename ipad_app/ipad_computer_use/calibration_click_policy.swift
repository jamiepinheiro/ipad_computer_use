import Foundation

enum CalibrationClickPolicy {
    static func acceptsDirectTouch(running: Bool, hasTarget: Bool) -> Bool {
        // Report the actual tap even when it disagrees with hover; the server measures that error.
        running && hasTarget
    }
}
