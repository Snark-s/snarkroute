$ErrorActionPreference='Stop'
Write-Host '10Eros files:'
& wsl.exe -d Ubuntu-24.04 -- ls -lh /home/serge/h3/models/TenStrip/10Eros-Max/
Write-Host 'MATLOW files:'
& wsl.exe -d Ubuntu-24.04 -- ls -lh /home/serge/h3/models/MATLOWAI/minimax-h3-fused-turbo-int8-convrot/diffusion_models/
