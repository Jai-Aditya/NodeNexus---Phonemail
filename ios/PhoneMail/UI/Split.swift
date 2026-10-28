import Observation
import SwiftUI

/// Which layout the mail screens use: the iPhone's stack, or (regular width: an iPad, or a wide window of one) the
/// menu, the chat list and the open chat side by side. A narrow iPad window (Slide Over, a third of Split View)
/// is compact and gets the iPhone's stack.
enum MainLayout: Equatable {
    case stack, split

    static func choose(_ sizeClass: UserInterfaceSizeClass?) -> MainLayout { sizeClass == .regular ? .split : .stack }
}

/// A place in the iPad sidebar: a list of chats (a menu filter, or "folder:<id>"), or Drafts, Scheduled, Spam, Trash.
enum Place: Hashable {
    case chats(String)
    case folder(String)
}

/// Where a screen's navigation request (the same `Route`s the iPhone pushes) goes in the split view.
enum SplitTarget: Equatable {
    /// Shown in the right-hand column, in place of what is there.
    case detail(Route)
    /// Pushed onto the right-hand column (an email opened from the chat shown there).
    case push(Route)
    /// The editor, as a sheet.
    case compose(ComposeArgs)
    /// Settings, as a sheet.
    case settings
    /// Another place in the sidebar.
    case place(Place)

    static func of(_ route: Route, fromDetail: Bool) -> SplitTarget {
        switch route {
        case .chat: return .detail(route)
        case .message: return fromDetail ? .push(route) : .detail(route)
        case .compose(let args): return .compose(args)
        case .settings: return .settings
        case .folder(let name): return .place(.folder(name))
        case .chats(let filter): return .place(.chats(filter))
        }
    }
}

/// What the split view shows: the sidebar's place, the right column (and what was pushed on it), and its sheets.
struct SplitState: Equatable {
    var place: Place = .chats("all")
    var detail: Route?
    var detailPath: [Route] = []
    var composing: ComposeArgs?
    var settings = false

    /// The same screens as the iPhone's stack, e.g. a folder's list, a chat in it and the editor on top.
    var stack: [Route] {
        var path: [Route] = []
        switch place {
        case .chats(let f) where f != "all": path.append(.chats(f))
        case .folder(let name): path.append(.folder(name))
        default: break
        }
        if let detail { path.append(detail) }
        path += detailPath
        if settings { path.append(.settings) }
        if let composing { path.append(.compose(composing)) }
        return path
    }

    /// The stack's screens laid out side by side (the editor and Settings become sheets; only one can show).
    init(stack path: [Route]) {
        for route in path {
            switch route {
            case .chats(let f): place = .chats(f); detail = nil; detailPath = []
            case .folder(let name): place = .folder(name); detail = nil; detailPath = []
            case .chat: detail = route; detailPath = []
            case .message: if detail == nil { detail = route } else { detailPath.append(route) }
            case .compose(let args): composing = args
            case .settings: settings = true
            }
        }
        if composing != nil { settings = false }
    }

    init() {}
}

/// Where the person is in the mail screens, kept above both layouts: an iPad window resized between wide and
/// narrow (Slide Over, Split View, Stage Manager) keeps the open list, chat, editor and Settings.
@MainActor
@Observable
final class MainNavModel {
    /// The stack (narrow).
    var path: [Route] = []
    /// The split view (wide).
    var split = SplitState()
    /// The layout on show; nil until the window's width is known.
    private(set) var layout: MainLayout?

    /// Moves the open screens over to `layout` (the first time, just takes it).
    func switchTo(_ new: MainLayout) {
        guard new != layout else { return }
        defer { layout = new }
        guard layout != nil else { return }
        switch new {
        case .split:
            split = SplitState(stack: path)
            path = []
        case .stack:
            path = split.stack
            split = SplitState()
        }
    }
}

extension ComposeArgs: Identifiable {
    var id: UUID { instance }
}

/// The iPad layout: the ☰ menu as a sidebar, the chosen list in the middle, the open chat on the right. The
/// screens are the iPhone's own; what they push is routed here instead (SplitTarget), and the editor and Settings
/// open as sheets.
struct SplitMainView: View {
    @Environment(Session.self) private var session
    @Bindable var model: MainNavModel
    /// The chat list always starts in view (portrait too), beside the chat.
    @State private var columns: NavigationSplitViewVisibility = .doubleColumn
    @State private var creating = false

    private var state: SplitState { model.split }

    private var openChatId: Int64? {
        if case .chat(let ref)? = state.detail { return ref.id }
        return nil
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } content: {
            content
        } detail: {
            NavigationStack(path: $model.split.detailPath) {
                detailRoot
                    .navigationDestination(for: Route.self) { route in pushed(route) }
            }
        }
        .navigationSplitViewStyle(.balanced) // the list sits beside the chat, never over it
        .sheet(item: $model.split.composing) { args in
            NavigationStack {
                ComposeView(args: args)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { model.split.composing = nil } } }
            }
        }
        .sheet(isPresented: $model.split.settings) {
            NavigationStack {
                SettingsView()
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { model.split.settings = false } } }
            }
        }
        .sheet(isPresented: $creating) {
            FolderNameSheet(title: L("New folder")) { name in
                let f = try await session.createFolder(name)
                model.split.place = .chats(Mailbox.folderFilter(f.id))
            }
        }
        // A folder deleted (from its own list) leaves for the Inbox.
        .onChange(of: session.folders) {
            if case .chats(let f) = state.place, let id = Mailbox.folderId(f), !session.folders.contains(where: { $0.id == id }) {
                model.split.place = .chats("all")
            }
        }
        .onChange(of: Nav.shared.composeTick) { compose(ComposeArgs()) }
        .onChange(of: Nav.shared.searchTick) { if columns == .detailOnly { columns = .doubleColumn } }
        .onChange(of: Nav.shared.pendingChat, initial: true) {
            Task {
                guard let ref = await Nav.shared.takePending(session) else { return }
                model.split.place = .chats("all")
                show(.chat(ref))
            }
        }
    }

    // MARK: columns

    private var sidebar: some View {
        List(selection: Binding<Place?>(get: { state.place }, set: { if let p = $0 { model.split.place = p } })) {
            Section {
                ForEach(Mailbox.filters, id: \.self) { f in
                    Label(Mailbox.title(f), systemImage: Mailbox.icon(f)).tag(Place.chats(f))
                }
            }
            Section {
                Label(L("Drafts"), systemImage: "doc").tag(Place.folder("drafts"))
                Label(L("Scheduled"), systemImage: "calendar.badge.clock").tag(Place.folder("scheduled"))
                Label(L("Spam"), systemImage: "exclamationmark.octagon").tag(Place.folder("spam"))
                Label(L("Trash"), systemImage: "trash").tag(Place.folder("trash"))
            }
            Section(L("Folders")) {
                ForEach(session.folders) { f in
                    Label(f.name, systemImage: "folder").badge(f.unreadCount).tag(Place.chats(Mailbox.folderFilter(f.id)))
                }
                Button { creating = true } label: { Label(L("New folder"), systemImage: "folder.badge.plus") }
                    .accessibilityIdentifier("newFolder")
            }
            Section {
                Button { model.split.settings = true } label: { Label(L("Settings"), systemImage: "gearshape") }
                    .accessibilityIdentifier("Settings")
            }
        }
        .navigationTitle(L("PhoneMail"))
        .task { await session.refreshFolders() }
    }

    @ViewBuilder private var content: some View {
        switch state.place {
        case .chats(let f):
            ChatListView(path: router(fromDetail: false), filter: f, home: f == "all", split: true, current: openChatId).id(f)
        case .folder(let name):
            FolderView(name: name, path: router(fromDetail: false)).id(name)
        }
    }

    @ViewBuilder private var detailRoot: some View {
        switch state.detail {
        case .chat(let ref)?:
            ChatView(ref: ref, path: router(fromDetail: true), onLeave: { model.split.detail = nil }).id(ref)
        case .message(let id)?:
            MessageDetailView(id: id, path: router(fromDetail: true), onLeave: { model.split.detail = nil }).id(id)
        default:
            ContentUnavailableView(L("Choose a conversation"), systemImage: "bubble.left.and.bubble.right")
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.chatBg)
        }
    }

    /// What the right-hand column pushes: an email from the chat shown there.
    @ViewBuilder private func pushed(_ route: Route) -> some View {
        switch route {
        case .message(let id): MessageDetailView(id: id, path: router(fromDetail: true))
        case .chat(let ref): ChatView(ref: ref, path: router(fromDetail: true))
        default: EmptyView()
        }
    }

    // MARK: routing

    /// The `path` the screens push onto: new routes go where SplitTarget says; going back pops the right column.
    private func router(fromDetail: Bool) -> Binding<[Route]> {
        Binding(
            get: { fromDetail ? model.split.detailPath : [] },
            set: { new in
                let old = fromDetail ? model.split.detailPath : []
                if new.count > old.count && new.starts(with: old) {
                    for r in new.dropFirst(old.count) { go(r, fromDetail: fromDetail) }
                } else if fromDetail {
                    model.split.detailPath = new
                }
            }
        )
    }

    private func go(_ route: Route, fromDetail: Bool) {
        switch SplitTarget.of(route, fromDetail: fromDetail) {
        case .detail(let r): show(r)
        case .push(let r): model.split.detailPath.append(r)
        case .compose(let args): compose(args)
        case .settings: model.split.settings = true
        case .place(let p): model.split.place = p
        }
    }

    private func show(_ route: Route) {
        model.split.detailPath = []
        model.split.detail = route
    }

    /// One sheet at a time: Settings (⌘N while it is open) closes first, then the editor opens.
    private func compose(_ args: ComposeArgs) {
        guard model.split.settings else { model.split.composing = args; return }
        model.split.settings = false
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            model.split.composing = args
        }
    }
}
