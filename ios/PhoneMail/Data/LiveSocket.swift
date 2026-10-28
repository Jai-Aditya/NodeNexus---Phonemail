import Foundation

/// Live updates from the api's event stream (GET /api/events, Server-Sent Events), without a third-party library.
/// Every event means something changed for this person, so the open screen reloads; that includes "ready", sent on
/// each connect, so nothing sent while disconnected is missed. Reconnects by itself 3 s after a drop.
/// (The name is kept from the earlier Socket.IO version; Session uses it the same way.)
final class LiveSocket {
    private let url: URL
    private let token: String
    private let onMail: () -> Void
    private var task: Task<Void, Never>?

    init?(apiBase: String, token: String, onMail: @escaping () -> Void) {
        guard let u = URL(string: apiBase + "/events") else { return nil }
        url = u
        self.token = token
        self.onMail = onMail
    }

    func start() {
        task?.cancel()
        let url = url, token = token, onMail = onMail
        task = Task.detached {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 90 // the api pings every 25 s
            config.timeoutIntervalForResource = .infinity
            let session = URLSession(configuration: config)
            while !Task.isCancelled {
                var req = URLRequest(url: url)
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                do {
                    let (bytes, response) = try await session.bytes(for: req)
                    if (response as? HTTPURLResponse)?.statusCode == 200 {
                        for try await line in bytes.lines {
                            if Task.isCancelled { break }
                            if line.hasPrefix("event:") { DispatchQueue.main.async { onMail() } }
                        }
                    }
                } catch {
                    // dropped: try again below
                }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
