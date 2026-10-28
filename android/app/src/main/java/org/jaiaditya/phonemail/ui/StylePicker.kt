package org.jaiaditya.phonemail.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.jaiaditya.phonemail.R

private val STYLE_NAMES = mapOf(
    PhotoStyle.Original to R.string.style_original,
    PhotoStyle.Oil to R.string.style_oil,
    PhotoStyle.Pixel to R.string.style_pixel,
    PhotoStyle.Outline to R.string.style_outline,
    PhotoStyle.Pencil to R.string.style_pencil,
)

/** Runs a style on the 512×512 photo (off the main thread). */
suspend fun styled(src: Bitmap, style: PhotoStyle): Bitmap = withContext(Dispatchers.Default) {
    val w = src.width; val h = src.height
    val px = IntArray(w * h).also { src.getPixels(it, 0, w, 0, 0, w, h) }
    Bitmap.createBitmap(PhotoStyles.apply(style, px, w, h), w, h, Bitmap.Config.ARGB_8888)
}

/**
 * After a photo is picked: five styles made on the phone, each as a live tile, a large preview, and "Use this
 * picture". Only the chosen result is uploaded.
 */
@Composable
fun StylePicker(photo: Bitmap, onCancel: () -> Unit, onUse: (Bitmap) -> Unit) {
    val results = remember(photo) { mutableStateMapOf<PhotoStyle, Bitmap>(PhotoStyle.Original to photo) }
    var chosen by remember { mutableStateOf(PhotoStyle.Original) }
    LaunchedEffect(photo) {
        coroutineScope {
            PhotoStyle.entries.filter { it != PhotoStyle.Original }
                .map { s -> async { s to styled(photo, s) } }
                .forEach { val (s, b) = it.await(); results[s] = b }
        }
    }
    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.fillMaxSize().background(Palette.Bg).safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.choose_style), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text, modifier = Modifier.weight(1f))
                IconButton(onClick = onCancel) { Icon(Icons.Filled.Close, stringResource(R.string.cancel), tint = Palette.Muted) }
            }
            Box(Modifier.widthIn(max = 320.dp).fillMaxWidth().aspectRatio(1f).clip(CircleShape).background(Palette.ChipBg), contentAlignment = Alignment.Center) {
                val big = results[chosen]
                if (big != null) Image(big.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else CircularProgressIndicator(color = Palette.Header)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                PhotoStyle.entries.forEach { s ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f).clickable { if (results[s] != null) chosen = s }) {
                        Box(
                            Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)).background(Palette.ChipBg)
                                .border(3.dp, if (s == chosen) Palette.Header else Color.Transparent, RoundedCornerShape(12.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            val t = results[s]
                            if (t != null) Image(t.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            else CircularProgressIndicator(color = Palette.Header, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        }
                        Text(
                            stringResource(STYLE_NAMES.getValue(s)), fontSize = 11.sp, lineHeight = 13.sp, textAlign = TextAlign.Center,
                            color = if (s == chosen) Palette.Header else Palette.Text, modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.background(Palette.ChipBg, RoundedCornerShape(12.dp)).padding(12.dp)) {
                Icon(Icons.Filled.Lock, null, tint = Palette.Muted, modifier = Modifier.size(16.dp))
                Text(stringResource(R.string.styles_private), color = Palette.Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 8.dp))
            }
            PrimaryButton(stringResource(R.string.use_this_picture), enabled = results[chosen] != null, onClick = { results[chosen]?.let(onUse) })
        }
    }
}
