'use strict';

// Minimal PNG IHDR reader. percy-api's screenshot records validate height presence
// (`Validation failed: Height can't be blank` from AfterRenderJob), and neither the
// /percy/comparison CLI endpoint nor the client-direct seed path enriches tag dimensions the way
// the newer /percy/screenshot endpoint does — so the SDK must send accurate dims itself. The PNG
// bytes are the source of truth: IHDR is always the first chunk, width/height big-endian at
// offsets 16/20.
function pngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // \x89PNG\r\n\x1a\n signature + "IHDR" chunk type at offset 12.
  if (buf.readUInt32BE(12) !== 0x49484452) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

module.exports = { pngDimensions };
