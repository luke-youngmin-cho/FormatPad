import LZString from 'lz-string';

export const SHARE_WARN_BYTES = 128 * 1024;
export const SHARE_GIST_BYTES = 256 * 1024;
export const SHARE_MAX_ENCODED_CHARS = 256 * 1024;
export const SHARE_MAX_CONTENT_BYTES = 512 * 1024;

export function sharedByteLength(text) {
  return new TextEncoder().encode(text || '').length;
}

export function compressSharedContent(text) {
  return LZString.compressToEncodedURIComponent(text || '');
}

export function decompressSharedContent(encoded) {
  if (String(encoded || '').length > SHARE_MAX_ENCODED_CHARS) {
    throw new Error('Shared fragment is too large.');
  }
  const text = LZString.decompressFromEncodedURIComponent(encoded || '');
  if (typeof text !== 'string') {
    throw new Error('Invalid shared fragment.');
  }
  if (sharedByteLength(text) > SHARE_MAX_CONTENT_BYTES) {
    throw new Error('Shared fragment expands beyond the safe size limit.');
  }
  return text;
}

export function buildFragmentShareUrl({ content, name, baseHref }) {
  const url = new URL(baseHref);
  url.search = '';
  url.hash = '';
  const hashParams = new URLSearchParams();
  hashParams.set('fragment', compressSharedContent(content || ''));
  if (name) hashParams.set('name', name);
  url.hash = hashParams.toString();
  return url.toString();
}
