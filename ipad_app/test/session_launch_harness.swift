import Foundation

@main struct SessionLaunchHarness {
    @MainActor static func main() async throws {
        let request = SessionLaunchRequest.shared
        precondition(!request.pending && request.revision == 0)
        _ = try await StartSessionIntent().perform()
        precondition(request.pending && request.revision == 1)
        _ = try await StartSessionIntent().perform()
        precondition(request.revision == 1)
        precondition(request.consume() && !request.consume())
        request.handling = true
        request.request()
        precondition(!request.pending && request.revision == 1)
        request.handling = false
        request.request()
        precondition(request.pending && request.revision == 2)
        print("Session launch passed: foreground handoff, pending request retention, deduplication, and reentry guard.")
    }
}
