package org.jaiaditya.phonemail.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Folder
import org.jaiaditya.phonemail.data.Session
import java.time.LocalDateTime

/**
 * Applies [action] to the chats [ids] and confirms it with [done] in the snackbar. When [undo] has calls (see undoFor:
 * archive, snooze, move and unfile can be put back), Undo is offered and makes them. [after] redraws the screen, after
 * the change and again after an undo.
 */
suspend fun applyChatAction(
    session: Session, snack: SnackbarHostState, context: Context, ids: List<Long>, action: String, done: String,
    undo: List<ChatUndo> = emptyList(), until: String? = null, folderId: Long? = null, after: suspend () -> Unit,
) {
    val failed = runCatching { session.api.chatAction(ids, action, until, folderId) }.exceptionOrNull()
    if (failed != null) {
        snack.showSnackbar(failed.message ?: context.getString(R.string.could_not_update))
        return
    }
    after()
    val canUndo = undo.isNotEmpty()
    val undoLabel = if (canUndo) context.getString(R.string.undo) else null
    val r = snack.showSnackbar(done, actionLabel = undoLabel, duration = if (canUndo) SnackbarDuration.Long else SnackbarDuration.Short)
    if (r == SnackbarResult.ActionPerformed && canUndo) {
        runCatching { undo.forEach { session.api.chatAction(it.ids, it.action, folderId = it.folderId) } }
            .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_update)) }
        after()
    }
}

/**
 * Snooze until…: later today, tomorrow, this weekend or next week, each with its time. The times are worked out again
 * on a tap, so a dialog left open past 18:00 (or midnight) never snoozes into the past: a choice gone by then is dropped.
 */
@Composable
fun SnoozeDialog(onDismiss: () -> Unit, onPick: (LocalDateTime) -> Unit) {
    var choices by remember { mutableStateOf(snoozeChoices(LocalDateTime.now())) }
    fun pick(choice: Snooze) {
        val fresh = snoozeChoices(LocalDateTime.now())
        val time = fresh.firstOrNull { it.first == choice }?.second
        if (time != null) onPick(time) else choices = fresh
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.snooze_title)) },
        text = {
            Column {
                choices.forEach { (choice, time) ->
                    Row(
                        Modifier.fillMaxWidth().clickable { pick(choice) }.padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(choice.label), color = Palette.Text, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        Text(dayTime(time), color = Palette.Muted, fontSize = 14.sp)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
        containerColor = Palette.Surface,
    )
}

/**
 * Asks for a folder name (a new folder, or a new name for one). [save] gets the tidied name; when it fails, the api's
 * message (a name already used, a built-in name…) shows in the dialog. [save] closes the dialog itself on success.
 */
@Composable
fun FolderNameDialog(title: String, confirm: String, initial: String = "", onDismiss: () -> Unit, save: suspend (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var name by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    name, { name = it; error = "" }, singleLine = true, placeholder = { Text(stringResource(R.string.folder_name)) },
                    colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.folder_name_hint, FOLDER_NAME_MAX), color = Palette.Muted, fontSize = 13.sp)
                ErrorText(error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = folderNameOk(name) && !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        error = ""
                        runCatching { save(cleanFolderName(name)) }.onFailure { error = it.message ?: context.getString(R.string.could_not_save) }
                        busy = false
                    }
                },
            ) { Text(confirm, color = Palette.Header, fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
        containerColor = Palette.Surface,
    )
}

/** Move to folder: the user's folders, and "New folder" (made, then picked). */
@Composable
fun MoveToFolderDialog(session: Session, onDismiss: () -> Unit, onPick: (Folder) -> Unit) {
    val context = LocalContext.current
    var folders by remember { mutableStateOf<List<Folder>?>(null) }
    var error by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        runCatching { session.api.folders() }
            .onSuccess { folders = it }
            .onFailure { folders = emptyList(); error = it.message ?: context.getString(R.string.could_not_load) }
    }

    if (creating) {
        FolderNameDialog(stringResource(R.string.new_folder), stringResource(R.string.create), onDismiss = { creating = false }) { name ->
            val made = session.api.createFolder(name)
            creating = false
            onPick(made)
        }
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.move_to_folder)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                val list = folders
                if (list == null) CircularProgressIndicator(color = Palette.Header, modifier = Modifier.padding(12.dp).size(24.dp))
                list?.forEach { f ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onPick(f) }.padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Folder, null, tint = Palette.Muted)
                        Text(f.name, color = Palette.Text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 16.dp))
                    }
                }
                if (list != null && list.isEmpty() && error.isEmpty()) Text(stringResource(R.string.no_folders_yet), color = Palette.Muted, fontSize = 14.sp)
                ErrorText(error)
                Row(
                    Modifier.fillMaxWidth().clickable { creating = true }.padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.CreateNewFolder, null, tint = Palette.Header)
                    Text(stringResource(R.string.new_folder), color = Palette.Header, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp))
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
        containerColor = Palette.Surface,
    )
}
