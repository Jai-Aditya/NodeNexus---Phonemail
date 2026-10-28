package org.jaiaditya.phonemail.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScheduleSend
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AllInbox
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Attachment
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.MoveToInbox
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Report
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Drafts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.BuildConfig
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Contacts
import org.jaiaditya.phonemail.data.Conversation
import org.jaiaditya.phonemail.data.Folder
import org.jaiaditya.phonemail.data.Session

private val CHIPS = listOf(
    "all" to R.string.chip_all, "unread" to R.string.chip_unread,
    "attachments" to R.string.chip_attachments, "favorites" to R.string.chip_favorites,
)

/** The menu's icon for each chat list (FILTERS). */
private val FILTER_ICONS = mapOf(
    "all" to Icons.Filled.Inbox, "unread" to Icons.Filled.MarkEmailUnread, "attachments" to Icons.Filled.Attachment,
    "favorites" to Icons.Filled.Star, "snoozed" to Icons.Filled.Snooze, "everything" to Icons.Filled.AllInbox, "archived" to Icons.Filled.Archive,
)

/** A chat's name: the group's name, the person's PhoneMail name, their name in this phone's contacts, or the address. */
@Composable
fun chatTitle(session: Session, c: Conversation): String = when {
    c.isGroup -> c.name ?: stringResource(R.string.group)
    else -> c.peerName ?: session.contactName(c.peerAddress) ?: c.peerAddress ?: stringResource(R.string.conversation)
}

/**
 * Home: no separate Inbox or Sent; every email lives in a chat (brief: "Refer Spike Mail"). The menu switches the list
 * (Inbox, Unread, Snoozed, All mail, Archived, the user's folders…), the same lists as the web app. A long press picks
 * chats, and the top bar then acts on all of them (archive, delete, read, snooze, move to a folder).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    session: Session,
    openChat: (Conversation, String) -> Unit,
    newChat: (number: String, name: String?) -> Unit,
    compose: () -> Unit,
    openFolder: (String) -> Unit,
    openSettings: () -> Unit,
) {
    val context = LocalContext.current
    val user by session.user.collectAsState()
    val contacts by session.contacts.collectAsState()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var filter by rememberSaveable { mutableStateOf("all") }
    var query by rememberSaveable { mutableStateOf("") }
    var chats by remember { mutableStateOf<List<Conversation>>(emptyList()) }
    var folders by remember { mutableStateOf<List<Folder>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    // Picking chats (long press, or Select in the menu).
    var picking by rememberSaveable { mutableStateOf(false) }
    var picked by remember { mutableStateOf<Set<Long>>(emptySet()) }
    var menuOpen by remember { mutableStateOf(false) }
    var pickMenuOpen by remember { mutableStateOf(false) }
    var snoozing by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var newFolder by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    suspend fun load() {
        loading = true
        val asked = filter
        runCatching { session.api.conversations(asked) }
            .onSuccess { if (asked == filter) { chats = it; error = "" } }
            .onFailure { if (asked == filter) error = it.message ?: context.getString(R.string.could_not_load) }
        // The folders (and their unread counts) for the menu; a server without folders just shows none.
        runCatching { session.api.folders() }.onSuccess { folders = it }
        loading = false
        loaded = true
    }

    LaunchedEffect(filter) {
        picked = emptySet()
        picking = false
        load()
    }
    LaunchedEffect(Unit) { session.mail.collect { load() } } // live: new mail arrived
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { load() } } // back from a chat

    // Back closes the menu first (and does nothing else), then leaves picking, then a list other than the Inbox.
    BackHandler(enabled = drawer.isOpen || picking || filter != "all") {
        when {
            drawer.isOpen -> scope.launch { drawer.close() }
            picking -> { picking = false; picked = emptySet() }
            else -> filter = "all"
        }
    }

    val folderId = folderIdOf(filter)
    val folder = folders.firstOrNull { it.id == folderId }
    val listTitle = filterTitle(filter)?.let { stringResource(it) } ?: folder?.name ?: stringResource(R.string.folder)

    val q = query.trim().lowercase()
    val titles = chats.associate { it.id to chatTitle(session, it) }
    val shown = if (q.isEmpty()) chats else chats.filter { c ->
        listOf(titles[c.id], c.peerAddress, c.snippet).any { it?.lowercase()?.contains(q) == true }
    }
    val number = tenDigits(query)?.takeIf { query.filter(Char::isDigit).length >= 10 }
    // People from the phone's contacts who match, and are not already the typed number.
    val suggestions = remember(q, contacts) { Contacts.search(contacts, q).filter { it.digits != number } }
    val pickedChats = chats.filter { it.id in picked }

    /** Acts on the picked chats, then leaves picking; Undo is offered when the action can be put back (undoFor). */
    fun act(action: String, done: String, until: String? = null, folderId: Long? = null) {
        val ids = picked.toList()
        if (ids.isEmpty()) return
        val undo = undoFor(action, filter, chats.filter { it.id in picked })
        picking = false
        picked = emptySet()
        scope.launch { applyChatAction(session, snack, context, ids, action, done, undo, until, folderId) { load() } }
    }

    fun toggle(c: Conversation) {
        picked = if (c.id in picked) picked - c.id else picked + c.id
    }

    StatusBarIcons(darkIcons = false)
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    user?.let { u ->
                        Row(Modifier.padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(u.displayName, u.address, u.avatar, size = 52.dp)
                            Column(Modifier.padding(start = 14.dp)) {
                                Text(u.displayName ?: stringResource(R.string.app_name), color = Palette.Header, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                                Text(u.address, color = Palette.Muted, fontSize = 13.sp)
                            }
                        }
                    }
                    HorizontalDivider(color = Palette.Divider)
                    val go = { action: () -> Unit -> scope.launch { drawer.close() }; action() }
                    FILTERS.forEach { key ->
                        DrawerItem(stringResource(filterTitle(key)!!), FILTER_ICONS.getValue(key), selected = filter == key) { go { filter = key } }
                    }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Palette.Divider)
                    DrawerItem(stringResource(R.string.menu_drafts), Icons.Outlined.Drafts) { go { openFolder("drafts") } }
                    DrawerItem(stringResource(R.string.menu_scheduled), Icons.AutoMirrored.Filled.ScheduleSend) { go { openFolder("scheduled") } }
                    DrawerItem(stringResource(R.string.menu_spam), Icons.Filled.Report) { go { openFolder("spam") } }
                    DrawerItem(stringResource(R.string.menu_trash), Icons.Filled.Delete) { go { openFolder("trash") } }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Palette.Divider)
                    Text(
                        stringResource(R.string.menu_folders), color = Palette.Muted, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(start = 28.dp, top = 4.dp, bottom = 8.dp),
                    )
                    folders.forEach { f ->
                        DrawerItem(f.name, Icons.Filled.Folder, selected = folderId == f.id, badge = f.unreadCount) { go { filter = folderFilter(f.id) } }
                    }
                    DrawerItem(stringResource(R.string.new_folder), Icons.Filled.CreateNewFolder) { go { newFolder = true } }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Palette.Divider)
                    DrawerItem(stringResource(R.string.menu_settings), Icons.Filled.Settings) { go(openSettings) }
                    Spacer(Modifier.height(12.dp))
                }
            }
        },
    ) {
        Scaffold(
            topBar = {
                val barColors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, titleContentColor = Palette.OnBar,
                    navigationIconContentColor = Palette.OnBar, actionIconContentColor = Palette.OnBar,
                )
                if (picking) {
                    // The picked chats' actions (the same as the web app's).
                    val some = picked.isNotEmpty()
                    TopAppBar(
                        navigationIcon = { IconButton(onClick = { picking = false; picked = emptySet() }) { Icon(Icons.Filled.Close, stringResource(R.string.close)) } },
                        title = { Text(stringResource(R.string.selected_count, picked.size)) },
                        actions = {
                            if (offersUnarchive(filter, pickedChats)) {
                                IconButton(enabled = some, onClick = { act(moveToInboxAction(filter, pickedChats), context.getString(R.string.done_unarchived)) }) {
                                    Icon(Icons.Filled.MoveToInbox, stringResource(R.string.move_to_inbox))
                                }
                            } else {
                                IconButton(enabled = some, onClick = { act("archive", context.getString(R.string.done_archived)) }) {
                                    Icon(Icons.Filled.Archive, stringResource(R.string.archive))
                                }
                            }
                            IconButton(enabled = some, onClick = { act("trash", context.getString(R.string.done_trashed)) }) {
                                Icon(Icons.Filled.Delete, stringResource(R.string.delete))
                            }
                            if (offersUnsnooze(filter, pickedChats)) {
                                IconButton(enabled = some, onClick = { act("unsnooze", context.getString(R.string.done_unsnoozed)) }) {
                                    Icon(Icons.Filled.Inbox, stringResource(R.string.unsnooze))
                                }
                            } else {
                                IconButton(enabled = some, onClick = { snoozing = true }) { Icon(Icons.Filled.Snooze, stringResource(R.string.snooze)) }
                            }
                            Box {
                                IconButton(onClick = { pickMenuOpen = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.more)) }
                                DropdownMenu(expanded = pickMenuOpen, onDismissRequest = { pickMenuOpen = false }) {
                                    MenuItem(stringResource(R.string.mark_read), enabled = some) { pickMenuOpen = false; act("read", context.getString(R.string.done_read)) }
                                    MenuItem(stringResource(R.string.mark_unread), enabled = some) { pickMenuOpen = false; act("unread", context.getString(R.string.done_unread)) }
                                    MenuItem(stringResource(R.string.move_to_folder_ellipsis), enabled = some) { pickMenuOpen = false; moving = true }
                                    if (folderId != null) {
                                        MenuItem(stringResource(R.string.remove_from_folder), enabled = some) { pickMenuOpen = false; act("unfile", context.getString(R.string.done_unfiled)) }
                                    }
                                    MenuItem(stringResource(R.string.select_all)) { pickMenuOpen = false; picked = shown.mapTo(HashSet()) { it.id } }
                                }
                            }
                        },
                        colors = barColors,
                    )
                } else {
                    TopAppBar(
                        title = { Text(if (filter == "all") stringResource(R.string.app_name) else listTitle, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        navigationIcon = { IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Filled.Menu, stringResource(R.string.menu)) } },
                        actions = {
                            IconButton(onClick = openSettings) {
                                Avatar(user?.displayName, user?.address, user?.avatar, size = 32.dp)
                            }
                            Box {
                                IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.more)) }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    MenuItem(stringResource(R.string.select)) { menuOpen = false; picking = true }
                                    if (folder != null) {
                                        MenuItem(stringResource(R.string.rename_folder)) { menuOpen = false; renaming = true }
                                        MenuItem(stringResource(R.string.delete_folder), color = Palette.Danger) { menuOpen = false; confirmDelete = true }
                                    }
                                }
                            }
                        },
                        colors = barColors,
                    )
                }
            },
            floatingActionButton = {
                if (!picking) {
                    FloatingActionButton(onClick = compose, containerColor = Palette.Accent, contentColor = Palette.OnAccent, shape = RoundedCornerShape(16.dp)) {
                        Icon(Icons.Filled.Edit, stringResource(R.string.compose))
                    }
                }
            },
            snackbarHost = { SnackbarHost(snack) },
            containerColor = Palette.Bg,
        ) { inner ->
            Column(Modifier.padding(inner).fillMaxSize()) {
                TextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.search_hint), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = { Icon(Icons.Filled.Search, null) },
                    singleLine = true,
                    shape = RoundedCornerShape(24.dp),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Palette.ChipBg, unfocusedContainerColor = Palette.ChipBg,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Palette.Header,
                        focusedTextColor = Palette.Text, unfocusedTextColor = Palette.Text,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp),
                )
                // The quick chips stay for the Home lists they cover.
                if (CHIPS.any { it.first == filter }) {
                    LazyRow(
                        Modifier.padding(vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp),
                    ) {
                        items(CHIPS) { (key, label) ->
                            FilterChip(
                                selected = filter == key, onClick = { filter = key }, label = { Text(stringResource(label)) },
                                shape = RoundedCornerShape(16.dp), border = null,
                                colors = FilterChipDefaults.filterChipColors(
                                    containerColor = Palette.ChipBg, labelColor = Palette.Muted,
                                    selectedContainerColor = Palette.ChipOnBg, selectedLabelColor = Palette.Header,
                                ),
                            )
                        }
                    }
                } else {
                    Spacer(Modifier.height(8.dp))
                }
                if (!picking) {
                    if (number != null) {
                        val name = session.contactName(number)
                        NewChatRow(name, number) { newChat(number, name) }
                    }
                    suggestions.forEach { c -> NewChatRow(c.name, c.digits, fromContacts = true) { newChat(c.digits, c.name) } }
                }
                PullToRefreshBox(isRefreshing = loading && loaded, onRefresh = { scope.launch { load() } }, modifier = Modifier.weight(1f)) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (shown.isEmpty() && loaded) {
                            item {
                                Text(
                                    error.ifEmpty { stringResource(if (filter == "all" && q.isEmpty()) R.string.no_chats else R.string.nothing_here) },
                                    color = Palette.Muted, textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(top = 48.dp, start = 32.dp, end = 32.dp),
                                )
                            }
                        }
                        items(shown, key = { it.id }) { c ->
                            val title = titles[c.id].orEmpty()
                            ChatRow(
                                c, title, filter, picking = picking, checked = c.id in picked,
                                onClick = { if (picking) toggle(c) else openChat(c, title) },
                                onLongClick = { picking = true; toggle(c) },
                            )
                        }
                        item { Spacer(Modifier.height(88.dp)) } // room above the FAB
                    }
                }
            }
        }
    }

    if (snoozing) {
        SnoozeDialog(onDismiss = { snoozing = false }) { t ->
            snoozing = false
            act("snooze", context.getString(R.string.done_snoozed, dayTime(t)), until = isoUtc(t))
        }
    }

    if (moving) {
        MoveToFolderDialog(session, onDismiss = { moving = false }) { f ->
            moving = false
            act("move", context.getString(R.string.done_moved, f.name), folderId = f.id)
        }
    }

    if (newFolder) {
        FolderNameDialog(stringResource(R.string.new_folder), stringResource(R.string.create), onDismiss = { newFolder = false }) { name ->
            val made = session.api.createFolder(name)
            newFolder = false
            filter = folderFilter(made.id) // opens the new (empty) folder
            scope.launch { snack.showSnackbar(context.getString(R.string.folder_created, made.name)) }
        }
    }

    if (renaming && folder != null) {
        FolderNameDialog(stringResource(R.string.rename_folder), stringResource(R.string.rename), initial = folder.name, onDismiss = { renaming = false }) { name ->
            session.api.renameFolder(folder.id, name)
            renaming = false
            scope.launch { load(); snack.showSnackbar(context.getString(R.string.folder_renamed)) }
        }
    }

    if (confirmDelete && folder != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.delete_folder_question, folder.name)) },
            text = { Text(stringResource(R.string.delete_folder_explain)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        runCatching { session.api.deleteFolder(folder.id) }
                            .onSuccess {
                                filter = "all"
                                snack.showSnackbar(context.getString(R.string.folder_deleted))
                            }
                            .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_update)) }
                    }
                }) { Text(stringResource(R.string.delete), color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
            containerColor = Palette.Surface,
        )
    }
}

@Composable
private fun DrawerItem(label: String, icon: ImageVector, selected: Boolean = false, badge: Int = 0, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }, icon = { Icon(icon, null) }, selected = selected,
        badge = { if (badge > 0) Text("$badge", fontWeight = FontWeight.SemiBold) },
        onClick = onClick,
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = Palette.ChipOnBg, selectedTextColor = Palette.Header, selectedIconColor = Palette.Header,
            selectedBadgeColor = Palette.Header, unselectedContainerColor = Color.Transparent, unselectedTextColor = Palette.Text,
            unselectedIconColor = Palette.Muted, unselectedBadgeColor = Palette.Muted,
        ),
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 1.dp),
    )
}

@Composable
private fun MenuItem(text: String, enabled: Boolean = true, color: Color = Palette.Text, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(text, color = if (enabled) color else Palette.Muted) }, enabled = enabled, onClick = onClick)
}

/** "Chat with …": the typed number, or a matching phone contact. */
@Composable
private fun NewChatRow(name: String?, number: String, fromContacts: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(name, number, size = 44.dp)
        Column(Modifier.padding(start = 14.dp).weight(1f)) {
            Text(stringResource(R.string.chat_with, name ?: number), fontWeight = FontWeight.SemiBold, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$number@${BuildConfig.MAIL_DOMAIN}", color = Palette.Muted, fontSize = 14.sp)
        }
        Icon(if (fromContacts) Icons.Filled.Contacts else Icons.AutoMirrored.Filled.Send, null, tint = Palette.Header)
    }
}

/**
 * One chat in a list. While picking, a check box shows and a tap picks it. In Snoozed the time is when it comes back
 * ("Until …"); in All mail, archived chats carry an "Archived" label.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(
    c: Conversation, title: String, filter: String, picking: Boolean, checked: Boolean,
    onClick: () -> Unit, onLongClick: () -> Unit,
) {
    val unread = c.unreadCount > 0
    Row(
        Modifier.fillMaxWidth().background(if (checked) Palette.ChipOnBg else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (picking) {
            Checkbox(
                checked = checked, onCheckedChange = null, modifier = Modifier.padding(end = 12.dp),
                colors = CheckboxDefaults.colors(checkedColor = Palette.Header, checkmarkColor = Palette.OnHeader, uncheckedColor = Palette.Muted),
            )
        }
        Avatar(c.peerName ?: title.takeIf { it != c.peerAddress }, c.peerAddress, c.peerAvatar, group = c.isGroup)
        Column(Modifier.padding(start = 14.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    title, fontSize = 16.5.sp, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold,
                    color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (c.muted) Icon(Icons.Filled.NotificationsOff, stringResource(R.string.muted), tint = Palette.Muted, modifier = Modifier.padding(end = 4.dp).size(14.dp))
                val snoozed = filter == "snoozed" && c.snoozedUntil != null
                Text(
                    if (snoozed) stringResource(R.string.until_time, laterTime(c.snoozedUntil)) else chatTime(c.lastMessageAt, stringResource(R.string.yesterday)),
                    fontSize = 12.sp, color = if (unread || snoozed) Palette.Header else Palette.Muted,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (filter == "everything" && c.archived) {
                    Text(
                        stringResource(R.string.archived_label), fontSize = 11.sp, color = Palette.Muted, maxLines = 1,
                        modifier = Modifier.padding(end = 6.dp).background(Palette.ChipBg, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
                if (c.hasAttachments) Icon(Icons.Filled.Attachment, null, tint = Palette.Muted, modifier = Modifier.size(16.dp).padding(end = 2.dp))
                if (c.favouriteCount > 0) Icon(Icons.Filled.Star, null, tint = Palette.Star, modifier = Modifier.size(16.dp).padding(end = 2.dp))
                Text(
                    c.snippet.ifEmpty { if (c.isGroup) stringResource(R.string.group_created) else "" },
                    fontSize = 14.sp, color = if (unread) Palette.Text else Palette.Muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (unread) {
                    Box(
                        Modifier.padding(start = 8.dp).defaultMinSize(minWidth = 22.dp, minHeight = 22.dp)
                            .background(Palette.Accent, CircleShape).padding(horizontal = 6.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text("${c.unreadCount}", color = Palette.OnAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}
