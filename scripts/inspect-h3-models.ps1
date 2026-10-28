$ErrorActionPreference='Stop'
& wsl.exe -d Ubuntu-24.04 -- bash -lc "for f in /home/serge/h3/models/TenStrip/10Eros-Max/*14gb_optimized.safetensors /home/serge/h3/models/MATLOWAI/minimax-h3-fused-turbo-int8-convrot/diffusion_models/*.safetensors; do if test -f \"\$f\"; then du -h \"\$f\"; fi; done"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
