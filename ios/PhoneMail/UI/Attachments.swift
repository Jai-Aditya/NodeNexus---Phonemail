import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// Limits the server enforces (per file, per message, count).
enum AttachmentLimits {
    static let perFile: Int64 = 25 * 1024 * 1024
    static let perMessage: Int64 = 25 * 1024 * 1024
    static let count = 20
}

/// Files being attached to one email: each uploads as soon as it is picked; the message is sent with their ids.
@MainActor
@Observable
final class AttachmentTray {
    struct Item: Identifiable {
        let id = UUID()
        let filename: String
        let contentType: String
        let size: Int64
        var progress = 0.0
        var uploaded: Attachment?
        var error: String?
    }

    private(set) var items: [Item] = []
    /// Why the last pick was refused (too big, too many).
    var problem = ""
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]

    var ids: [Int64] { items.compactMap { $0.uploaded?.id } }
    var uploading: Bool { items.contains { $0.uploaded == nil && $0.error == nil } }
    var failed: Bool { items.contains { $0.error != nil } }
    var isEmpty: Bool { items.isEmpty }

    func add(_ data: Data, filename: String, contentType: String, api: API) {
        problem = ""
        let size = Int64(data.count)
        let total = items.reduce(0) { $0 + $1.size } + size
        if items.count >= AttachmentLimits.count {
            problem = L("At most %lld files per email.", AttachmentLimits.count); return
        }
        if size > AttachmentLimits.perFile {
            problem = L("%@ is too big: files can be up to 25 MB.", filename); return
        }
        if total > AttachmentLimits.perMessage {
            problem = L("Files on one email can add up to 25 MB."); return
        }
        let item = Item(filename: filename, contentType: contentType, size: size)
        items.append(item)
        let id = item.id
        tasks[id] = Task {
            do {
                let a = try await api.uploadAttachment(data, filename: filename, contentType: contentType) { p in
                    Task { @MainActor in self.update(id) { $0.progress = p } }
                }
                update(id) { $0.uploaded = a; $0.progress = 1 }
            } catch is CancellationError {
            } catch {
                update(id) { $0.error = error.localizedDescription }
            }
            tasks[id] = nil
        }
    }

    func remove(_ id: UUID, api: API) {
        tasks[id]?.cancel()
        tasks[id] = nil
        if let a = items.first(where: { $0.id == id })?.uploaded {
            Task.detached { try? await api.discardAttachment(a.id) }
        }
        items.removeAll { $0.id == id }
    }

    /// After a send: the files now belong to the message.
    func clearSent() {
        items.removeAll()
        problem = ""
    }

    /// Leaving without sending: drop the uploads from the server too.
    func discardAll(api: API) {
        for i in items { remove(i.id, api: api) }
    }

    private func update(_ id: UUID, _ change: (inout Item) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
    }
}

/// The paperclip: a menu to attach photos or files, feeding a tray.
struct AttachButton: View {
    @Environment(Session.self) private var session
    let tray: AttachmentTray
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label(L("Photos"), systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label(L("Files"), systemImage: "folder") }
        } label: {
            Image(systemName: "paperclip").font(.system(size: 20)).foregroundStyle(Palette.muted).frame(width: 36, height: 44)
        }
        .accessibilityLabel(L("Attach"))
        .accessibilityIdentifier("attach")
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { addFile(url) }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { for (n, item) in items.enumerated() { await addPhoto(item, number: n + 1) } }
        }
    }

    private func addFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            tray.problem = L("Could not read %@.", url.lastPathComponent); return
        }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        tray.add(data, filename: url.lastPathComponent, contentType: type, api: session.api)
    }

    private func addPhoto(_ item: PhotosPickerItem, number: Int) async {
        guard var data = try? await item.loadTransferable(type: Data.self) else {
            tray.problem = L("Could not read that photo."); return
        }
        var type = item.supportedContentTypes.first ?? .jpeg
        // HEIC and other camera formats become JPEG, so every mail program can open them.
        if type.conforms(to: .image), type != .jpeg, type != .png, type != .gif,
           let img = UIImage(data: data), let jpeg = img.jpegData(compressionQuality: 0.85) {
            data = jpeg
            type = .jpeg
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = f.string(from: Date())
        let ext = type.preferredFilenameExtension ?? "jpg"
        let name = (type.conforms(to: .movie) ? "Video-" : "Photo-") + stamp + (number > 1 ? "-\(number)" : "") + "." + ext
        tray.add(data, filename: name, contentType: type.preferredMIMEType ?? "application/octet-stream", api: session.api)
    }
}

/// The picked files as chips above the text: name, size or progress, and a remove button.
struct TrayChips: View {
    @Environment(Session.self) private var session
    let tray: AttachmentTray

    var body: some View {
        if !tray.isEmpty || !tray.problem.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(tray.items) { i in chip(i) }
                    }
                    .padding(.horizontal, 4)
                }
                if !tray.problem.isEmpty {
                    Text(tray.problem).font(.footnote).foregroundStyle(Palette.danger).padding(.horizontal, 6)
                }
            }
        }
    }

    private func chip(_ i: AttachmentTray.Item) -> some View {
        HStack(spacing: 6) {
            Image(systemName: FileIcon.symbol(i.contentType)).foregroundStyle(Palette.header)
            VStack(alignment: .leading, spacing: 1) {
                Text(i.filename).font(.footnote.weight(.semibold)).lineLimit(1).frame(maxWidth: 150, alignment: .leading)
                if let e = i.error {
                    Text(e).font(.caption2).foregroundStyle(Palette.danger).lineLimit(1)
                } else if i.uploaded == nil {
                    ProgressView(value: i.progress).tint(Palette.header).frame(width: 90)
                } else {
                    Text(Format.fileSize(i.size)).font(.caption2).foregroundStyle(Palette.muted)
                }
            }
            Button { tray.remove(i.id, api: session.api) } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.muted)
            }
            .accessibilityLabel(L("Remove %@", i.filename))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.divider))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trayChip")
    }
}

enum FileIcon {
    static func symbol(_ contentType: String) -> String {
        let t = contentType.lowercased()
        if t.hasPrefix("image/") { return "photo" }
        if t.hasPrefix("video/") { return "film" }
        if t.hasPrefix("audio/") { return "waveform" }
        if t == "application/pdf" { return "doc.richtext" }
        if t.contains("zip") || t.contains("compressed") || t.contains("x-tar") { return "doc.zipper" }
        if t.contains("sheet") || t.contains("excel") || t == "text/csv" { return "tablecells" }
        if t.contains("presentation") || t.contains("powerpoint") { return "rectangle.on.rectangle" }
        if t.hasPrefix("text/") || t.contains("word") || t.contains("document") { return "doc.text" }
        return "doc"
    }
}

/// The files on a message. Tapping one downloads it (once) and opens it in Quick Look, which can share it.
struct AttachmentList: View {
    @Environment(Session.self) private var session
    let attachments: [Attachment]
    var compact = false
    @State private var preview: URL?
    @State private var loading: Int64?
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments) { a in
                Button { open(a) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        if a.isImage { AttachmentThumb(attachment: a, height: compact ? 150 : 220) }
                        HStack(spacing: 10) {
                            Image(systemName: FileIcon.symbol(a.contentType)).font(.title3).foregroundStyle(Palette.header).frame(width: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.filename).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                                Text(Format.fileSize(a.size)).font(.caption).foregroundStyle(Palette.muted)
                            }
                            Spacer(minLength: 0)
                            if loading == a.id { ProgressView().tint(Palette.header) }
                        }
                    }
                    .padding(8)
                    .background(Palette.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("attachment-\(a.filename)")
            }
            ErrorText(text: error)
        }
        .quickLookPreview($preview)
    }

    private func open(_ a: Attachment) {
        guard loading == nil else { return }
        Task {
            loading = a.id
            error = ""
            do { preview = try await session.api.download(a) } catch { self.error = error.localizedDescription }
            loading = nil
        }
    }
}

/// An image attachment's picture (downloaded with the sign-in token, cached on the phone).
struct AttachmentThumb: View {
    @Environment(Session.self) private var session
    let attachment: Attachment
    let height: CGFloat
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Rectangle().fill(Palette.chipBg)
                ProgressView().tint(Palette.header)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: attachment.id) {
            guard image == nil, let url = try? await session.api.download(attachment) else { return }
            image = await Task.detached { UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 800, height: 800)) }.value
        }
    }
}
