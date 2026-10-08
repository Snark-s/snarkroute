# SnarkDeploy v0.2

Reproducible disaster-recovery layer for the local Snark workstation.

## What the recovery bundle preserves

- SnarkRoute: exact Git commit plus any local working patch and non-ignored untracked files.
- PersonaCore, including its portable data/state, project registry, browser extension source/build and local host mappings.
- Modified Mixar source, installed Mixar files, Mixar profile/startup scripts, Jabberwock Mixar Local and Jabberwock Blender.
- ArcEngine plus local previs/tools layered on top of the upstream Git checkout.
- Hollywood 2 and FreeToken Desktop.
- Bonsai runtime source/configuration without duplicating the large GGUF weights.
- H3/local-upscale model manifests and model inventories.
- Logical service registry for SnarkRoute, Mixar, H3, local upscale, Bonsai, Ollama and FreeToken.
- Machine inventory: Windows/Python/tool versions, GPU/driver, WSL distributions, global npm packages and Ollama model list.
- Strong SHA-256 checksum for the entire bundle and ZIP CRC validation.

Large model weights remain outside the ZIP. Their paths, sizes and hashes (where practical) are stored in heavy-inventory.json; H3's pinned upstream checksums remain in workers/minimax-h3/model-manifest.yaml.

Secrets are deliberately excluded from the ordinary recovery ZIP. `SNARK_BACKUP.cmd` also creates a separate AES-256 encrypted `snark-secrets-*.zip`; its password is stored on a different physical disk.

## One-click backup and restore

Double-click `SNARK_BACKUP.cmd`. It can be placed anywhere. If it is not inside the recovery folder itself, it scans all mounted drive letters for a `SnarkBackups\SnarkDeploy` folder and uses that recovery disk. It then finds `SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt` on any mounted drive. Drive letters are not part of the recovery contract.

Double-click `SNARK_RESTORE.cmd` to restore the newest recovery bundle. It can also be placed anywhere: it scans mounted drives for the recovery folder, then restores the newest encrypted secrets archive and finds the password disk regardless of its drive letter.

The current workstation happens to use `X:\SnarkBackups` and `I:\SnarkRecoveryKey`, but those are examples, not requirements. FreeToken Desktop is treated as a local runtime; no external account/sign-in requirement is assumed.

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

- API keys, provider tokens and passwords.
- FreeToken external login is not required by the current installed runtime; no account-specific recovery step is recorded.
- The H3 worker token. Regenerate it.
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
