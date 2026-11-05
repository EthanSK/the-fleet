// How the app names and colours run outcomes. Failing tests are a valid result
// shown amber; work that never reached a verdict is grey; red is only for The
// Fleet's own errors. The service decides the outcome; exit codes are the
// fallback for older services.

import XCTest
@testable import FleetUI
import FleetKit

final class OutcomeTests: XCTestCase {
    func testFailuresAreAmberAndOnlyFleetErrorsAreRed() {
        let outcomes = ["passed", "running", "failed", "timed-out", "cancelled", "aborted", "refused", "error", "from-a-newer-service"]
        XCTAssertEqual(outcomes.map(FleetPalette.lamp(forOutcome:)), [.cleared, .taxiway, .hold, .hold, .idle, .idle, .idle, .stop, .idle])
    }

    func testRunsThatNeverRanKeepDistinctNames() {
        XCTAssertEqual(["passed", "failed", "timed-out", "cancelled", "aborted", "refused", "error"].map(OutcomeText.title),
                       ["Passed", "Failed", "Timed out", "Cancelled", "Aborted", "Refused", "Error"])
        let explanations = ["cancelled", "aborted", "refused", "failed", "error"].compactMap(OutcomeText.help)
        XCTAssertEqual(Set(explanations).count, 5, "cancellation, a source-change abort and a refusal each explain themselves")
        XCTAssertNil(OutcomeText.help("passed"))
    }

    func testTheServicesOutcomeWinsOverTheExitCode() {
        // A source-change stop still exits 2, the code for an invalid request.
        XCTAssertEqual(OutcomeText.outcome(running: false, reported: "aborted", exitCode: 2), "aborted")
        XCTAssertEqual(OutcomeText.meaning(of: "aborted", exitCode: 2), "Source changed before the job started, so nothing ran.")
        // An unexpected crash exits 1 without any test having failed.
        XCTAssertEqual(OutcomeText.outcome(running: false, reported: "error", exitCode: 1), "error")
        XCTAssertEqual(OutcomeText.meaning(of: "error", exitCode: 1), "The Fleet couldn't run, verify or clean up this job.")
        // When they agree, the exit code's more specific meaning is kept.
        XCTAssertEqual(OutcomeText.meaning(of: "failed", exitCode: 1), "Failed")
        XCTAssertEqual(OutcomeText.meaning(of: "error", exitCode: 8), "Outputs failed verification")
        XCTAssertEqual(OutcomeText.outcome(running: true, reported: nil, exitCode: nil), "running")
    }

    func testOlderServicesAreNamedLikeTheServiceNamesExitCodes() {
        // Mirrors outcomeForExitCode in src/run/receipt.ts; exit 8 (outputs failed verification) is an error.
        let codes: [Int?] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 42, nil]
        XCTAssertEqual(codes.map { OutcomeText.outcome(running: false, reported: nil, exitCode: $0) },
                       ["passed", "failed", "error", "refused", "refused", "error", "timed-out", "cancelled", "error", "error", "error"])
    }

    func testAWorkersRecentJobUsesItsReceiptAndOtherwiseStaysConservative() {
        func job(_ reason: String, _ exitCode: String) -> RemoteJob {
            decode(#"{"jobId":"20261105-151102-example-test-a1b2c3","reason":"\#(reason)","exitCode":"\#(exitCode)","label":"example/test"}"#)
        }
        XCTAssertEqual(OutcomeText.outcome(of: job("aborted", "-"), recorded: "aborted"), "aborted")
        XCTAssertEqual(OutcomeText.outcome(of: job("completed", "0"), recorded: "error"), "error", "outputs that failed verification")
        XCTAssertEqual(OutcomeText.outcome(of: job("completed", "0"), recorded: nil), "passed")
        XCTAssertEqual(OutcomeText.outcome(of: job("completed", "1"), recorded: nil), "failed")
        XCTAssertEqual(OutcomeText.outcome(of: job("timeout", "-"), recorded: nil), "timed-out")
        XCTAssertEqual(OutcomeText.outcome(of: job("cancelled", "-"), recorded: nil), "cancelled")
        XCTAssertEqual(OutcomeText.outcome(of: job("disconnected", "-"), recorded: nil), "cancelled", "as the service records it")
        // Without a receipt, an abort could be a source change or a failed upload.
        for reason in ["aborted", "abandoned", "upload-failed"] {
            XCTAssertEqual(OutcomeText.outcome(of: job(reason, "-"), recorded: nil), "error", reason)
        }
    }
}
