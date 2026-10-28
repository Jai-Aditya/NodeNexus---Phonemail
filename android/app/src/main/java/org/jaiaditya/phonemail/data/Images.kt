package org.jaiaditya.phonemail.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * A small image loader for avatar photos (public, cached for good: their names never change) and attachment
 * thumbnails (need the sign-in). Images are kept on disk in the cache folder and decoded down to the size shown.
 */
class Images(context: Context, private val http: OkHttpClient) {
    private val dir = File(context.cacheDir, "images").apply { mkdirs() }
    private val memory = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val lock = Mutex()

    fun cached(url: String, px: Int): Bitmap? = memory.get("$px|$url")

    /** Returns the image at [url] decoded to about [px] pixels on its short side, or null. */
    suspend fun load(url: String, px: Int, auth: String? = null): Bitmap? {
        memory.get("$px|$url")?.let { return it }
        return withContext(Dispatchers.IO) {
            val file = File(dir, sha1(url))
            if (!file.exists()) {
                lock.withLock {
                    if (!file.exists()) {
                        val req = Request.Builder().url(url).apply { auth?.let { header("Authorization", it) } }.build()
                        runCatching {
                            http.newCall(req).execute().use { res ->
                                if (!res.isSuccessful) return@use
                                val tmp = File(dir, file.name + ".part")
                                res.body!!.byteStream().use { input -> tmp.outputStream().use { input.copyTo(it) } }
                                tmp.renameTo(file)
                            }
                        }
                    }
                }
            }
            if (!file.exists()) return@withContext null
            decode(file, px)?.also { memory.put("$px|$url", it) }
        }
    }

    private fun decode(file: File, px: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= px) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
