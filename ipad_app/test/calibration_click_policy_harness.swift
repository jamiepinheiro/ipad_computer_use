import Foundation

@main struct CalibrationClickPolicyHarness {
    static func main() {
        for running in [false, true] {
            for target in [false, true] {
                precondition(CalibrationClickPolicy.acceptsDirectTouch(
                    running: running, hasTarget: target) == (running && target))
            }
        }
        print("Calibration click policy: 4 checks passed")
    }
}
