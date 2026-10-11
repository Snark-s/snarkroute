"""Windowless task entrypoint; deploy beside START_SNARKBRIDGE.ps1 and use pythonw.exe."""
import os
from pathlib import Path
import subprocess
import sys


def main():
    if len(sys.argv) != 2:
        return 64
    registry = Path(sys.argv[1])
    root = Path(__file__).resolve().parent
    launcher = root / 'START_SNARKBRIDGE.ps1'
    if not registry.is_absolute() or not registry.is_file() or not launcher.is_file():
        return 66
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    environment = dict(os.environ)
    environment['SNARKROUTE_PORT_REGISTRY'] = str(registry)
    logs = root / 'workspace'
    logs.mkdir(exist_ok=True)
    # The fixed managed script uses Quiet tunnel startup; no credential values are logged.
    with (logs / 'scheduled-startup.log').open('ab', buffering=0) as output:
        process = subprocess.run(
            [str(powershell), '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
             '-ExecutionPolicy', 'Bypass', '-File', str(launcher)],
            cwd=root, env=environment, stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.STDOUT, shell=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    return process.returncode


if __name__ == '__main__':
    sys.exit(main())
