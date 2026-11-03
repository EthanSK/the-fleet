// The app reaches the coordinator only through its Unix socket. These tests
// use a real socket and the exact HTTP framings Node produces.

import XCTest
import Darwin
@testable import FleetKit

final class HTTPResponseParserTests: XCTestCase {
    func testContentLengthBodyStopsAtItsLength() throws {
        let data = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}trailing".utf8)
        let response = try HTTPResponseParser.parse(data, atEOF: false)
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(response.headers["content-type"], "application/json")
        XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "{\"ok\":true}")
    }

    func testChunkedBodyWithExtensionsIsReassembled() throws {
        let data = Data("HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"error\r\n6;name=value\r\n\":\"x\"}\r\n0\r\n\r\n".utf8)
        let response = try HTTPResponseParser.parse(data, atEOF: false)
        XCTAssertEqual(response.status, 409)
        XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "{\"error\":\"x\"}")
    }

    func testPartialResponsesWaitForMoreBytesAndFailAtEndOfStream() {
        let short = Data("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"a\"".utf8)
        XCTAssertThrowsError(try HTTPResponseParser.parse(short, atEOF: false)) { XCTAssertEqual($0 as? HTTPParseError, .incomplete) }
        XCTAssertThrowsError(try HTTPResponseParser.parse(short, atEOF: true)) { XCTAssertEqual($0 as? HTTPParseError, .malformed("Response ended early.")) }
        let unterminatedChunk = Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab".utf8)
        XCTAssertThrowsError(try HTTPResponseParser.parse(unterminatedChunk, atEOF: false)) { XCTAssertEqual($0 as? HTTPParseError, .incomplete) }
    }

    func testCloseDelimitedBodyNeedsEndOfStream() throws {
        let data = Data("HTTP/1.1 200 OK\r\n\r\n{\"pid\":1}".utf8)
        XCTAssertThrowsError(try HTTPResponseParser.parse(data, atEOF: false)) { XCTAssertEqual($0 as? HTTPParseError, .incomplete) }
        XCTAssertEqual(String(decoding: try HTTPResponseParser.parse(data, atEOF: true).body, as: UTF8.self), "{\"pid\":1}")
    }

    func testRejectsANonHTTPReply() {
        XCTAssertThrowsError(try HTTPResponseParser.parse(Data("SSH-2.0-OpenSSH\r\n\r\n".utf8), atEOF: true))
    }
}

/// A one-shot server on a real Unix socket that records the request it gets.
final class OneShotSocketServer: @unchecked Sendable {
    let path: String
    private let descriptor: Int32
    private let lock = NSLock()
    private var captured = Data()
    private let done = DispatchSemaphore(value: 0)

    init(response: Data) throws {
        path = "/tmp/fleet-ui-\(UUID().uuidString.prefix(8)).sock"
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(descriptor, 1) == 0 else { throw SocketError.system("bind", errno) }
        let listeningDescriptor = self.descriptor
        Thread.detachNewThread { [self] in
            let client = accept(listeningDescriptor, nil, nil)
            var buffer = [UInt8](repeating: 0, count: 65536)
            var request = Data()
            // Read the head, then exactly Content-Length body bytes.
            while true {
                let count = read(client, &buffer, buffer.count)
                if count <= 0 { break }
                request.append(buffer, count: count)
                if let end = request.range(of: Data([13, 10, 13, 10])) {
                    let head = String(decoding: request[..<end.lowerBound], as: UTF8.self).lowercased()
                    let length = head.components(separatedBy: "\r\n").first { $0.hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    if request.count - end.upperBound >= length { break }
                }
            }
            lock.lock(); captured = request; lock.unlock()
            response.withUnsafeBytes { raw in _ = write(client, raw.baseAddress, raw.count) }
            close(client)
            done.signal()
        }
    }

    var request: String {
        _ = done.wait(timeout: .now() + 5)
        lock.lock(); defer { lock.unlock() }
        return String(decoding: captured, as: UTF8.self)
    }

    deinit {
        close(descriptor)
        unlink(path)
    }
}

final class UnixSocketClientTests: XCTestCase {
    func testSendsAShortLivedRequestAndReadsNodesChunkedReply() async throws {
        let reply = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n".utf8)
        let server = try OneShotSocketServer(response: reply)
        let client = UnixSocketHTTPClient(socketPath: server.path)
        let response = try await client.send(method: "POST", path: "/v1/machines", body: Data("{\"a\":1}".utf8), timeout: 5)
        XCTAssertEqual(String(decoding: response.body, as: UTF8.self), "{\"ok\":true}")
        let request = server.request
        XCTAssertTrue(request.hasPrefix("POST /v1/machines HTTP/1.1\r\n"))
        XCTAssertTrue(request.contains("Connection: close\r\n"), "a reused connection can make a stopped service look alive")
        XCTAssertTrue(request.contains("Content-Length: 7\r\n"))
        XCTAssertTrue(request.hasSuffix("\r\n\r\n{\"a\":1}"))
    }

    func testMissingSocketMeansTheServiceIsNotRunning() async {
        let client = UnixSocketHTTPClient(socketPath: "/tmp/fleet-ui-absent-\(UUID().uuidString.prefix(8)).sock")
        do {
            _ = try await client.send(method: "GET", path: "/v1/health", body: nil, timeout: 2)
            XCTFail("Expected no service")
        } catch {
            XCTAssertEqual(error as? SocketError, .serviceNotRunning)
        }
    }

    func testSocketLeftByAStoppedServiceAlsoMeansNotRunning() async throws {
        // A crashed service can leave its socket file with nothing listening.
        let path = "/tmp/fleet-ui-stale-\(UUID().uuidString.prefix(8)).sock"
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        close(descriptor)
        defer { unlink(path) }
        do {
            _ = try await UnixSocketHTTPClient(socketPath: path).send(method: "GET", path: "/v1/health", body: nil, timeout: 2)
            XCTFail("Expected no service")
        } catch {
            XCTAssertEqual(error as? SocketError, .serviceNotRunning)
        }
    }

    func testRefusesAnswersLargerThanItsLimit() async throws {
        let body = String(repeating: "x", count: 4096)
        let server = try OneShotSocketServer(response: Data("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n\(body)".utf8))
        do {
            _ = try await UnixSocketHTTPClient(socketPath: server.path, maxResponseBytes: 1024).send(method: "GET", path: "/v1/state", body: nil, timeout: 5)
            XCTFail("Expected a size refusal")
        } catch {
            XCTAssertEqual(error as? SocketError, .responseTooLarge)
        }
    }

    func testRefusesSocketPathsTheKernelCannotAddress() async {
        let long = "/tmp/" + String(repeating: "a", count: 120) + ".sock"
        do {
            _ = try await UnixSocketHTTPClient(socketPath: long).send(method: "GET", path: "/v1/health", body: nil, timeout: 1)
            XCTFail("Expected a path refusal")
        } catch {
            XCTAssertEqual(error as? SocketError, .pathTooLong)
        }
    }
}
