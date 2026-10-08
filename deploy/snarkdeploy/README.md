# SnarkDeploy v0.2

Reproducible disaster-recovery layer for the local Snark workstation.

## What the recovery bundle preserves

- SnarkRoute and other Git-backed components: exact Git commit plus an embedded offline Git bundle, any local working patch and non-ignored untracked files. Restore uses the embedded bundle first and falls back to the network only for older recovery archives that do not contain one.
- PersonaCore, including its portable data/state, project registry, browser extension source/build and local host mappings.
- Modified Mixar source, installed Mixar files, Mixar profile/startup scripts, Jabberwock Mixar Local and Jabberwock Blender.
- ArcEngine plus local previs/tools layered on top of the upstream Git checkout.
- Hollywood 2 and FreeToken Desktop.
- Bonsai runtime source/configuration without duplicating the large GGUF weights.
- H3/local-upscale model manifests and model inventories.
- Logical service registry for SnarkRoute, Mixar, H3, local upscale, Bonsai, Ollama and FreeToken.
- Machine inventory: Windows/Python/tool versions, GPU/driver, WSL distributions, global npm packages and Ollama model list.
- Strong SHA-256 checksum for the entire bundle and ZIP CRC validation. Snapshots are written to a `.partial` file and only become a `.zip` after the archive is complete and its checksum sidecar is ready, so an interrupted backup cannot masquerade as the newest valid recovery.
- Heavy model SHA-256 values are cached by absolute path, size and nanosecond mtime. The cache can seed itself from the previous recovery's `heavy-inventory.json`, so unchanged multi-gigabyte model files are not reread on every backup.

Large model weights remain outside the ZIP. Their paths, sizes and hashes (where practical) are stored in heavy-inventory.json; H3's pinned upstream checksums remain in workers/minimax-h3/model-manifest.yaml.

Secrets are deliberately excluded from the ordinary recovery ZIP. `SNARK_BACKUP.cmd` also creates a separate AES-256 encrypted `snark-secrets-*.zip`; its password is stored on a different physical disk.

## One-click backup and restore

Double-click `SNARK_BACKUP.cmd`. It can be placed anywhere. If it is not inside the recovery folder itself, it scans all mounted drive letters for a `SnarkBackups\SnarkDeploy` folder and uses that recovery disk. It then finds `SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt` on any mounted drive. Drive letters are not part of the recovery contract.

Double-click `SNARK_RESTORE.cmd` to restore the newest recovery bundle. It can also be placed anywhere: it scans mounted drives for the recovery folder, then restores the newest encrypted secrets archive and finds the password disk regardless of its drive letter. `LATEST.txt` is regenerated automatically after every successful local backup and always names the current recovery and encrypted-secrets archives with their checksums. When a recovery bundle is supplied, `bootstrap.ps1` restores SnarkRoute from the portable recovery tools and embedded offline Git bundle before attempting any GitHub clone, so the bundle can recover the core repositories even if GitHub is unavailable.

The current workstation happens to use `X:\SnarkBackups` and `I:\SnarkRecoveryKey`, but those are examples, not requirements. FreeToken Desktop is treated as a local runtime; no external account/sign-in requirement is assumed.

### Beget remote copy

After the two local archives are created, `SNARK_BACKUP.cmd` calls `beget_sync.py`. It uploads the newest recovery ZIP, its SHA-256 sidecar, the newest AES-256 secrets ZIP, its SHA-256 sidecar, recovery instructions and the portable SnarkDeploy tools to Beget.

The transport is a portable `rclone` bundled on the recovery disk. It uses the SFTP backend with the Beget host key pinned explicitly and wraps it in rclone's `chunker` backend. Large files are stored as 16 MiB physical chunks under `~/snark-backups-rclone`; rclone exposes them again as normal logical files. This avoids the long-transfer disconnects observed with plain SFTP/SCP and lets retries happen at chunk granularity.

After upload, SnarkDeploy checks that the logical remote recovery and secrets files exist with exactly the local sizes; rclone only publishes the logical file after the chunk transaction completes. The original SHA-256 sidecars are uploaded alongside them. Retention is automatic: keep the newest 5 recovery generations and newest 5 encrypted secrets generations. A Beget/network failure does not invalidate the already completed local backup; the launcher prints a warning and exits successfully for the local backup.

## Create a snapshot manually

    python deploy\snarkdeploy\snarkdeploy.py doctor
    python deploy\snarkdeploy\snarkdeploy.py snapshot --output X:\SnarkBackups

The command creates:

    snark-recovery-YYYYMMDD-HHMMSS.zip
    snark-recovery-YYYYMMDD-HHMMSS.zip.sha256

Verify it immediately:

    python deploy\snarkdeploy\snarkdeploy.py verify X:\SnarkBackups\snark-recovery-YYYYMMDD-HHMMSS.zip

## Restore on a clean Windows PC

    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Bundle X:\SnarkBackups\snark-recovery-YYYYMMDD-HHMMSS.zip

bootstrap.ps1 installs Git/Python/Node/Corepack plus uv, ffmpeg and Ollama when missing, clones SnarkRoute, verifies the bundle, restores all preserved components, reinstalls component dependencies, rewrites the service registry and runs doctor.

Defaults on the current workstation:

- SNARK_PROCESS_ROOT=Y:\Процесс
- SNARK_APPS_ROOT=Y:\Приложения
- SNARK_AI_ROOT=I:\AI
- PERSONA_HOME=I:\PersonaCore

If those drives do not exist, bootstrap falls back to C:\Snark\.... Override any root with -ProcessRoot, -AppsRoot, -AiRoot or -PersonaHome.

A non-destructive restore preview is also available:

    python deploy\snarkdeploy\snarkdeploy.py restore <bundle.zip> --dry-run

## What is not silently restored

- The ordinary recovery ZIP never contains API keys, provider tokens, passwords or SSH private keys. Those live only in the separate AES-256 secrets archive and are restored only when explicitly selected.
- The encrypted secrets archive includes portable Snark/Persona secrets, H3/Hugging Face tokens when present, and the Beget SSH config/key used by remote backup.
- FreeToken external login is not required by the current installed runtime; no account-specific recovery step is recorded.
- NVIDIA drivers. Hardware/driver state is inventoried, but driver installation is hardware-specific.
- Huge model weights. Use heavy-inventory.json and the pinned model manifests to redownload/copy the exact files.
- WSL installation/reboot. If WSL2 + Ubuntu-24.04 are absent, bootstrap restores everything else and doctor reports the missing H3 prerequisite.

## Recovery acceptance criterion

A release is considered recoverable only when:

1. verify passes the bundle checksum and ZIP integrity.
2. Restore into empty alternate roots succeeds without touching the live installation.
3. Git-backed components land on the recorded commits and local overlays reappear.
4. Copied components contain the expected files.
5. doctor runs from the restored SnarkRoute and resolves the reconstructed service registry.
6. Missing secrets/models are reported explicitly rather than failing mysteriously.

Keep at least one copy of the resulting bundle outside the computer being protected.
