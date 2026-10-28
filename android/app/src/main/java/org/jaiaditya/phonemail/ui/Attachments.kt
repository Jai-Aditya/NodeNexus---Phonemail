package org.jaiaditya.phonemail.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.AudioFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.VideoFile
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Attachment
import org.jaiaditya.phonemail.data.Session
import java.io.File

const val MAX_FILE = 25L * 1024 * 1024
const val MAX_FILES = 20

/** A file being attached: uploaded as soon as it is picked; its server id goes with the email. */
class PendingFile(val name: String, val type: String, val size: Long, val uri: Uri) {
    var progress by mutableStateOf(0f)
    var id by mutableStateOf<Long?>(null)
    var failed by mutableStateOf(false)
    var job: Job? = null
}

/** The files attached to one email being written. */
class Uploads(private val session: Session, private val scope: CoroutineScope, private val context: Context) {
    val files = mutableStateListOf<PendingFile>()
    val busy get() = files.any { it.id == null && !it.failed }
    val ids get() = files.mapNotNull { it.id }
    val isEmpty get() = files.isEmpty()

    fun add(uris: List<Uri>, onError: (String) -> Unit) {
        for (uri in uris) {
            if (files.size >= MAX_FILES) { onError(context.getString(R.string.too_many_files)); return }
            val (name, size) = describe(uri)
            if (size > MAX_FILE) { onError(context.getString(R.string.file_too_big, name)); continue }
            if (size > 0 && files.sumOf { it.size } + size > MAX_FILE) { onError(context.getString(R.string.files_total_too_big)); continue }
            val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
            val f = PendingFile(name, type, size, uri)
            files += f
            f.job = scope.launch {
                runCatching {
                    session.api.uploadAttachment(name, type, size, { context.contentResolver.openInputStream(uri)!! }) { f.progress = it }
                }.onSuccess { f.id = it.id; f.progress = 1f }
                    .onFailure { f.failed = true; onError(it.message ?: context.getString(R.string.upload_failed)) }
            }
        }
    }

    fun remove(f: PendingFile) {
        f.job?.cancel()
        files.remove(f)
        f.id?.let { id -> session.scope.launch { runCatching { session.api.discardAttachment(id) } } }
    }

    /** After sending: the files now belong to the email. */
    fun sent() = files.clear()

    /** Leaving without sending: throw the uploads away on the server too. */
    fun discardAll() = files.toList().forEach { remove(it) }

    private fun describe(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = -1L
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return name to size
    }
}

@Composable
fun rememberUploads(session: Session): Uploads {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    return remember { Uploads(session, scope, context) }
}

/** The system file picker (no storage permission): any number of files of any type. */
@Composable
fun rememberFilePicker(onPicked: (List<Uri>) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) onPicked(it) }
    return { launcher.launch(arrayOf("*/*")) }
}

fun fileIcon(type: String, name: String): ImageVector {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when {
        type.startsWith("image/") -> Icons.Filled.Image
        type == "application/pdf" || ext == "pdf" -> Icons.Filled.PictureAsPdf
        type.startsWith("audio/") -> Icons.Filled.AudioFile
        type.startsWith("video/") -> Icons.Filled.VideoFile
        type.contains("zip") || ext in setOf("zip", "rar", "7z", "gz") -> Icons.Filled.FolderZip
        type.startsWith("text/") || ext in setOf("doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "csv", "ppt", "pptx") -> Icons.Filled.Description
        else -> Icons.AutoMirrored.Filled.InsertDriveFile
    }
}

/** Chips for the files being attached: name, size or upload progress, and a remove button. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PendingFiles(uploads: Uploads, modifier: Modifier = Modifier) {
    if (uploads.isEmpty) return
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        uploads.files.forEach { f ->
            Column(
                Modifier.widthIn(max = 260.dp).background(if (f.failed) Palette.FailedBg else Palette.Surface, RoundedCornerShape(10.dp))
                    .clickable(enabled = f.failed) { uploads.remove(f) }.padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(fileIcon(f.type, f.name), null, tint = Palette.Header, modifier = Modifier.size(20.dp))
                    Column(Modifier.padding(start = 6.dp).weight(1f, fill = false)) {
                        Text(f.name, fontSize = 13.sp, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            when {
                                f.failed -> stringResource(R.string.upload_failed)
                                f.id == null -> stringResource(R.string.uploading, (f.progress * 100).toInt())
                                else -> if (f.size >= 0) sizeText(f.size) else ""
                            },
                            fontSize = 11.sp, color = if (f.failed) Palette.Danger else Palette.Muted,
                        )
                    }
                    Box(Modifier.size(32.dp).clickable { uploads.remove(f) }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, stringResource(R.string.remove), tint = Palette.Muted, modifier = Modifier.size(16.dp))
                    }
                }
                if (f.id == null && !f.failed) {
                    LinearProgressIndicator(
                        progress = { f.progress }, color = Palette.Header,
                        modifier = Modifier.padding(end = 8.dp, top = 2.dp).fillMaxWidth().height(2.dp),
                    )
                }
            }
        }
    }
}

/** An email's files: images as thumbnails, everything else as a row; tap to open. */
@Composable
fun AttachmentList(attachments: List<Attachment>, modifier: Modifier = Modifier) {
    if (attachments.isEmpty()) return
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        attachments.forEach { AttachmentRow(it) }
    }
}

@Composable
private fun AttachmentRow(a: Attachment) {
    val session = LocalSession.current ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var opening by remember { mutableStateOf(false) }
    val open = {
        if (!opening) {
            opening = true
            scope.launch {
                openAttachment(context, session, a)
                opening = false
            }
        }
    }
    Column(
        Modifier.fillMaxWidth().background(Palette.Shade, RoundedCornerShape(8.dp)).clickable { open() }.padding(6.dp),
    ) {
        if (a.isImage) Thumbnail(session, a)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(fileIcon(a.contentType, a.filename), null, tint = Palette.Header, modifier = Modifier.size(22.dp))
            Column(Modifier.padding(start = 8.dp).weight(1f)) {
                Text(a.filename, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(sizeText(a.size), fontSize = 11.sp, color = Palette.Muted)
            }
            if (opening) CircularProgressIndicator(color = Palette.Header, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Thumbnail(session: Session, a: Attachment) {
    val px = with(LocalDensity.current) { 240.dp.roundToPx() }
    val url = session.api.attachmentUrl(a.id)
    val bitmap by produceState<Bitmap?>(session.images.cached(url, px), url) {
        if (value == null) value = session.images.load(url, px, session.api.authHeader())
    }
    bitmap?.let {
        Image(
            it.asImageBitmap(), contentDescription = a.filename, contentScale = ContentScale.Crop,
            modifier = Modifier.padding(bottom = 4.dp).fillMaxWidth().heightIn(max = 200.dp).height(160.dp)
                .background(Palette.Shade, RoundedCornerShape(6.dp)),
        )
    }
}

/** Downloads the file into the app's cache (with the sign-in) and hands it to an app that can show it. */
suspend fun openAttachment(context: Context, session: Session, a: Attachment) {
    val safe = a.filename.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifBlank { "file" }
    val file = File(context.cacheDir, "attachments/${a.id}/$safe")
    try {
        if (!file.exists()) session.api.downloadAttachment(a.id, file)
    } catch (e: Exception) {
        Toast.makeText(context, e.message ?: context.getString(R.string.could_not_open), Toast.LENGTH_LONG).show()
        return
    }
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
        context.startActivity(Intent.createChooser(view, a.filename).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(context, context.getString(R.string.no_app_to_open), Toast.LENGTH_LONG).show()
    }
}
