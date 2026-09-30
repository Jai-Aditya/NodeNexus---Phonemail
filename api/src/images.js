// Removes hidden metadata from uploaded pictures before they're stored and shown to others.
// Phone cameras write EXIF data into photos: the GPS position where it was taken (often the
// person's home), the phone model, the time. A profile picture is visible to everyone who
// gets mail from you, so all of that is removed. The one thing kept is the photo's rotation
// (EXIF "Orientation"): without it, portrait photos would appear sideways.

import { badRequest } from './http/util.js';

/** Returns the image without metadata. `type` is the checked MIME type. */
export function stripMetadata(buf, type) {
  switch (type) {
    case 'image/jpeg': return stripJpeg(buf);
    case 'image/png': return stripPng(buf);
    case 'image/webp': return stripWebp(buf);
    default: return buf; // GIF: no EXIF/GPS in practice
  }
}

const invalid = () => badRequest("That file isn't a valid image of that type.");

// JPEG: a list of segments (0xFF, marker, 2-byte length, data) until the image data (SOS).
// Dropped: APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), COM (comments). Kept: everything
// needed to draw the image, including APP0 (JFIF) and APP2 (colour profile).
function stripJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw invalid();
  const out = [buf.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  for (;;) {
    if (i + 4 > buf.length || buf[i] !== 0xff) throw invalid();
    const marker = buf[i + 1];
    if (marker === 0xda) { // start of scan: the rest is image data
      out.push(buf.subarray(i));
      break;
    }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw invalid();
    const segment = buf.subarray(i, end);
    if (marker === 0xe1) {
      orientation = exifOrientation(buf.subarray(i + 4, end)) || orientation;
    } else if (marker !== 0xed && marker !== 0xfe) {
      out.push(segment);
    }
    i = end;
  }
  if (orientation !== 1) out.splice(1, 0, orientationSegment(orientation)); // right after SOI
  return Buffer.concat(out);
}

/** Reads the Orientation tag (0x0112) from an APP1 EXIF payload, or 0. */
function exifOrientation(p) {
  if (p.length < 14 || p.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
  const tiff = p.subarray(6);
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 0;
      }
    }
  } catch { /* malformed EXIF: treat as no orientation */ }
  return 0;
}

/** A minimal APP1 EXIF segment holding only the Orientation tag. */
function orientationSegment(value) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM\0*', 0, 'latin1'); // big-endian TIFF header
  tiff.writeUInt32BE(8, 4);         // first IFD right after the header
  tiff.writeUInt16BE(1, 8);         // one entry
  tiff.writeUInt16BE(0x0112, 10);   // Orientation
  tiff.writeUInt16BE(3, 12);        // type SHORT
  tiff.writeUInt32BE(1, 14);        // count 1
  tiff.writeUInt16BE(value, 18);    // value (left-justified in the 4-byte field)
  tiff.writeUInt32BE(0, 22);        // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// PNG: signature, then chunks (4-byte length, type, data, CRC). Dropped: eXIf (EXIF)
// and the text chunks (tEXt, iTXt, zTXt), which can hold XMP, GPS or comments.
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw invalid();
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw invalid();
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

// WebP: RIFF container of chunks (FourCC, little-endian size, data padded to even).
// Dropped: EXIF and XMP chunks, and their flags in the VP8X header.
function stripWebp(buf) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > buf.length + 1) throw invalid(); // (the last pad byte may be missing)
    let chunk = buf.subarray(i, Math.min(end, buf.length));
    if (fourcc === 'VP8X') {
      chunk = Buffer.from(chunk);
      chunk[8] &= ~(0x08 | 0x04); // clear the "has EXIF" and "has XMP" flags
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') chunks.push(chunk);
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from(buf.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4); // RIFF size: "WEBP" + chunks
  return Buffer.concat([head, body]);
}
