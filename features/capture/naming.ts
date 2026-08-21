/** Naming a file, and handing it to the tools that can fetch it. */
import type { Item } from '@/features/capture/types';

/** Strips what the filesystem and the downloads API will not take. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video.mp4';
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** kisskh gates the stream on a Referer, so hand it to the tool as well. */
export function ffmpegCommand(item: Item, origin: string): string {
  return `ffmpeg -referer "${origin}/" -i "${item.url}" -c copy -bsf:a aac_adtstoasc "${safeName(item.name)}"`;
}

export function ytDlpCommand(item: Item, origin: string): string {
  return `yt-dlp --referer "${origin}/" -o "${safeName(item.name)}" "${item.url}"`;
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers where clipboard access is not granted.
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}
