/**
 * Encodes an RGBA frame as a PNG (used for snapshot thumbnails).
 * @returns {Promise<Blob | null>}
 */
export function frameToBlob(frame, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(frame.slice(), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
