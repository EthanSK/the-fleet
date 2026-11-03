// Minimal HTTP/1.1 over the coordinator's user-private Unix socket.
//
// Every request uses a fresh, short-lived connection with `Connection: close`,
// matching the CLI client. A reused keep-alive connection can make a stopped
// service look reachable through an old socket (see LEARNINGS.md).

import Foundation
import Darwin

public struct HTTPResponse: Sendable, Equatable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

public enum HTTPParseError: Error, Equatable {
    /// More bytes are needed before the response is complete.
    case incomplete
    case malformed(String)
}

public enum HTTPResponseParser {
    private static let separator = Data([13, 10, 13, 10])
    private static let lineEnd = Data([13, 10])

    /// Parses a complete response. With `atEOF` false, a response whose length
    /// is only known from connection close reports `.incomplete`.
    public static func parse(_ data: Data, atEOF: Bool) throws -> HTTPResponse {
        guard let headerEnd = data.range(of: separator) else {
            throw atEOF ? HTTPParseError.malformed("Response ended before its headers.") : HTTPParseError.incomplete
        }
        guard let head = String(data: data[data.startIndex..<headerEnd.lowerBound], encoding: .utf8) else {
            throw HTTPParseError.malformed("Response headers are not text.")
        }
        var lines = head.components(separatedBy: "\r\n")
        let statusLine = lines.removeFirst()
        let statusParts = statusLine.split(separator: " ", maxSplits: 2)
        guard statusParts.count >= 2, statusParts[0].hasPrefix("HTTP/1."), let status = Int(statusParts[1]), (100...599).contains(status) else {
            throw HTTPParseError.malformed("Unexpected status line.")
        }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { throw HTTPParseError.malformed("Malformed header line.") }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let rest = data[headerEnd.upperBound...]
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            return HTTPResponse(status: status, headers: headers, body: try decodeChunked(Data(rest), atEOF: atEOF))
        }
        if let lengthText = headers["content-length"] {
            guard let length = Int(lengthText), length >= 0 else { throw HTTPParseError.malformed("Invalid Content-Length.") }
            if rest.count < length {
                throw atEOF ? HTTPParseError.malformed("Response ended early.") : HTTPParseError.incomplete
            }
            return HTTPResponse(status: status, headers: headers, body: Data(rest.prefix(length)))
        }
        guard atEOF else { throw HTTPParseError.incomplete }
        return HTTPResponse(status: status, headers: headers, body: Data(rest))
    }

    static func decodeChunked(_ data: Data, atEOF: Bool) throws -> Data {
        var body = Data()
        var index = data.startIndex
        while true {
            guard let end = data.range(of: lineEnd, in: index..<data.endIndex) else {
                throw atEOF ? HTTPParseError.malformed("Chunked body ended early.") : HTTPParseError.incomplete
            }
            let sizeLine = String(decoding: data[index..<end.lowerBound], as: UTF8.self)
            let sizeText = sizeLine.split(separator: ";", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard let size = Int(sizeText, radix: 16), size >= 0 else { throw HTTPParseError.malformed("Invalid chunk size.") }
            index = end.upperBound
            if size == 0 { return body }
            guard data.distance(from: index, to: data.endIndex) >= size + 2 else {
                throw atEOF ? HTTPParseError.malformed("Chunk ended early.") : HTTPParseError.incomplete
            }
            let chunkEnd = data.index(index, offsetBy: size)
            body.append(data[index..<chunkEnd])
            guard data[chunkEnd..<data.index(chunkEnd, offsetBy: 2)] == lineEnd else { throw HTTPParseError.malformed("Chunk is missing its line end.") }
            index = data.index(chunkEnd, offsetBy: 2)
        }
    }
}

public enum SocketError: Error, Equatable {
    /// No service owns the socket (missing file or refused connection).
    case serviceNotRunning
    case pathTooLong
    case timedOut
    case responseTooLarge
    case system(String, Int32)
}

/// Sends one request per connection to a Unix-domain socket.
public protocol HTTPTransport: Sendable {
    func send(method: String, path: String, body: Data?, timeout: TimeInterval) async throws -> HTTPResponse
}

public struct UnixSocketHTTPClient: HTTPTransport {
    public let socketPath: String
    public let maxResponseBytes: Int

    public init(socketPath: String, maxResponseBytes: Int = 16 * 1024 * 1024) {
        self.socketPath = socketPath
        self.maxResponseBytes = maxResponseBytes
    }

    public func send(method: String, path: String, body: Data?, timeout: TimeInterval) async throws -> HTTPResponse {
        let socketPath = self.socketPath, limit = self.maxResponseBytes
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    continuation.resume(returning: try Self.exchange(socketPath: socketPath, method: method, path: path, body: body, timeout: timeout, limit: limit))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func exchange(socketPath: String, method: String, path: String, body: Data?, timeout: TimeInterval, limit: Int) throws -> HTTPResponse {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw SocketError.system("socket", errno) }
        defer { close(descriptor) }

        var noSignal: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var interval = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else { throw SocketError.pathTooLong }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if connected != 0 {
            let code = errno
            if code == ENOENT || code == ECONNREFUSED { throw SocketError.serviceNotRunning }
            throw SocketError.system("connect", code)
        }

        var head = "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\n"
        if let body {
            head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
        }
        head += "\r\n"
        var request = Data(head.utf8)
        if let body { request.append(body) }
        try request.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let written = write(descriptor, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if written < 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN || errno == EWOULDBLOCK { throw SocketError.timedOut }
                    throw SocketError.system("write", errno)
                }
                sent += written
            }
        }

        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(descriptor, &buffer, buffer.count)
            if count > 0 {
                response.append(buffer, count: count)
                if response.count > limit { throw SocketError.responseTooLarge }
                if let complete = try? HTTPResponseParser.parse(response, atEOF: false) { return complete }
            } else if count == 0 {
                return try HTTPResponseParser.parse(response, atEOF: true)
            } else {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { throw SocketError.timedOut }
                throw SocketError.system("read", errno)
            }
        }
    }
}
