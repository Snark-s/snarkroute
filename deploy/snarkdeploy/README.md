# SnarkDeploy v0.1

Reproducible recovery layer for the local Snark workstation.

## Preserved state

- SnarkRoute: Git commit + dirty patch + untracked files.
- Modified Mixar source: `Jabberwock-Mixar-full`.
- Installed Mixar directory and Mixar user profile/startup scripts.
- `Jabberwock Mixar Local` backend and `Jabberwock Blender` client.
- H3/local-upscale model manifests and checksums, but not huge model weights.
- Logical service registry for SnarkRoute, Mixar bridge, H3 and local upscale.

Known endpoints: SnarkRoute `127.0.0.1:4317`, Mixar bridge `:18765`, Mixar local backend `:18880`, H3 `:18080`, local upscale `:8091`.

## Snapshot

    python deploy\snarkdeploy\snarkdeploy.py doctor
    python deploy\snarkdeploy\snarkdeploy.py snapshot --output E:\SnarkBackups

Keep the resulting `snark-recovery-*.zip` off the workstation being protected.

## Restore on a clean Windows PC

    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Bundle E:\SnarkBackups\snark-recovery-YYYYMMDD-HHMMSS.zip

`bootstrap.ps1` installs Git/Python/Node through winget when missing, clones SnarkRoute, restores the bundle, installs dependencies, writes the service registry, and runs `doctor`.

Default roots are `Y:\Процесс` and `Y:\Приложения` when drive Y: exists; otherwise `C:\Snark\Process` and `C:\Snark\Apps`. Override with `-ProcessRoot` and `-AppsRoot`.

## Registry

`%LOCALAPPDATA%\SnarkRoute\service-registry.json` is also exposed as `SNARK_SERVICE_REGISTRY`. New integrations should resolve logical service names from it instead of hardcoding another application's physical path.

## Safety boundaries in v0.1

- API keys and secrets are deliberately excluded until portable password-based encryption is added.
- Large model weights are not duplicated. Their pinned manifests/checksums are retained for re-download.
- Local-only Git repositories without a remote are copied in full. A patch alone is not sufficient after total disk loss.
- This branch still requires a real Windows disaster-recovery test before merge.
