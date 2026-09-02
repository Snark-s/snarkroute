import { execFile } from "node:child_process";
import { type LocalAssetKind } from "@snarkroute/nodes";

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

export function browseLocalFile(kind: LocalAssetKind): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Local Browse is currently implemented for Windows in this MVP. Paste an absolute path manually.");
  }
  const filter =
    kind === "image"
      ? "Images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All files (*.*)|*.*"
      : kind === "video"
        ? "Videos (*.mp4;*.mov;*.webm;*.mkv;*.avi)|*.mp4;*.mov;*.webm;*.mkv;*.avi|All files (*.*)|*.*"
        : kind === "audio"
          ? "Audio (*.wav;*.mp3;*.aac;*.m4a;*.flac;*.ogg)|*.wav;*.mp3;*.aac;*.m4a;*.flac;*.ogg|All files (*.*)|*.*"
        : "All files (*.*)|*.*";
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = '${filter}'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.FileName
}
`;
  return new Promise((resolvePromise, reject) => {
    execFile("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: false }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
}
