"""Authenticated owned subprocesses and durable, configured workflow jobs.

Subprocess argv is always passed directly (shell=False). Safe execution requires
an exact configured argv or a fixed trusted workflow; general interpreter and
shell commands require a one-use owner approval bound to the entire request.
"""
from __future__ import annotations

import codecs
import contextvars
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time
import uuid

import bridge_security as security

try:
    import psutil
except ImportError:
    psutil = None

_lock = threading.RLock()
_records: dict[str, dict] = {}
_live: dict[str, dict] = {}
_loaded_dir: Path | None = None
_ACTIVE = {'starting', 'running', 'running_orphaned'}
_ESSENTIAL_ENV = {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
                  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
                  'PROGRAMDATA', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS'}
_BLOCKED_ENV = {'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'PYTHONPATH',
                'PYTHONHOME', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'NODE_PATH', 'ENV',
                'BASH_ENV', 'PSMODULEPATH', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS',
                '_JAVA_OPTIONS', 'CLASSPATH', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL',
                'GIT_CONFIG_SYSTEM', 'GIT_SSH', 'GIT_SSH_COMMAND'}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                   separators=(',', ':')).encode()).hexdigest()


def _directory() -> Path:
    target = security.state_dir() / 'runtime'
    target.mkdir(parents=True, exist_ok=True)
    return target


def _write_record(record: dict) -> None:
    """Atomic per-operation state; caller holds the runtime lock."""
    target = _directory() / (record['id'] + '.json')
    temporary = target.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(security.redact(record), stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)


if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    _kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    _kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel.OpenProcess.restype = wintypes.HANDLE
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    _kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                               ctypes.c_void_p, wintypes.DWORD]

    class _BasicLimit(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong),
                    ('PerJobUserTimeLimit', ctypes.c_longlong), ('LimitFlags', wintypes.DWORD),
                    ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
                    ('ActiveProcessLimit', wintypes.DWORD), ('Affinity', ctypes.c_size_t),
                    ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

    class _IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ['ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                     'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount']]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', _BasicLimit), ('IoInfo', _IOCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    def _windows_created(handle) -> int | None:
        values = [wintypes.FILETIME() for _ in range(4)]
        if not _kernel.GetProcessTimes(handle, *(ctypes.byref(v) for v in values)):
            return None
        return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

    def _attach_job(process: subprocess.Popen, max_memory_bytes: int, max_children: int):
        handle = _kernel.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), 'Cannot create owned process Job Object')
        limit = _ExtendedLimit()
        limit.BasicLimitInformation.LimitFlags = 0x2000 | 0x8  # kill-on-close; active-process bound
        limit.BasicLimitInformation.ActiveProcessLimit = max_children
        if max_memory_bytes:
            limit.BasicLimitInformation.LimitFlags |= 0x200  # total Job memory
            limit.JobMemoryLimit = max_memory_bytes
        if (not _kernel.SetInformationJobObject(handle, 9, ctypes.byref(limit), ctypes.sizeof(limit))
                or not _kernel.AssignProcessToJobObject(handle, int(process._handle))):
            error = ctypes.get_last_error()
            _kernel.CloseHandle(handle)
            raise OSError(error, 'Cannot contain owned process tree')
        return handle


def _pid_created(pid: int) -> int | float | None:
    if os.name == 'nt':
        handle = _kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            exit_code = wintypes.DWORD()
            if not _kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
                return None
            return _windows_created(handle)
        finally:
            _kernel.CloseHandle(handle)
    if psutil is not None:
        try:
            return psutil.Process(pid).create_time()
        except psutil.Error:
            return None
    try:
        return int(Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def _same_process(record: dict) -> bool:
    actual = _pid_created(record.get('pid') or 0)
    return actual is not None and actual == record.get('pid_created')


def _ensure_loaded() -> None:
    global _loaded_dir
    target = _directory()
    if _loaded_dir == target:
        return
    _records.clear()
    _loaded_dir = target
    for source in target.glob('*.json'):
        try:
            if len(source.stem) != 32 or any(c not in '0123456789abcdef' for c in source.stem):
                continue
            record = json.loads(source.read_text(encoding='utf-8'))
            if record.get('id') != source.stem or not isinstance(record.get('owner'), str):
                continue
            _records[record['id']] = record
            if record['status'] in _ACTIVE and record['id'] not in _live:
                alive = _same_process(record)
                record.update(status='running_orphaned' if alive else 'unknown', updated_at=_now(),
                              error='Server restarted; exit result is uncertain; automatic replay disabled.',
                              output_unavailable_after_restart=True)
                if not alive:
                    record['ended_at'] = _now()
                _write_record(record)
                if alive:
                    ctx = contextvars.copy_context()
                    threading.Thread(target=ctx.run, args=(_watch_orphan, record['id']), daemon=True).start()
        except (OSError, ValueError, KeyError, TypeError):
            # Corrupt state is never interpreted as an executable replay request.
            continue


def _profile() -> dict:
    return security.client_profile()


def _owned(ident: str, scope: str = 'process:read') -> dict:
    owner = security.authorize(scope)
    _ensure_loaded()
    record = _records.get(ident)
    if record is None or record['owner'] != owner:
        raise PermissionError('Operation not found for this client')
    return record


def _view(record: dict) -> dict:
    return security.redact({k: v for k, v in record.items()
                            if k not in {'stdout', 'stderr', 'request_digest', 'idempotency_hash', 'request'}})


def _environment(overrides: dict[str, str], executable: dict) -> dict[str, str]:
    allowed = {str(k).upper() for k in executable.get('allowed_env', ['LANG', 'LC_ALL',
                'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'])}
    output = {k: v for k, v in os.environ.items() if k.upper() in _ESSENTIAL_ENV}
    output['PYTHONIOENCODING'] = 'utf-8'
    for key, value in overrides.items():
        upper = key.upper()
        if (upper not in allowed or upper in _BLOCKED_ENV or upper.startswith(('LD_', 'DYLD_', 'SNARKBRIDGE_', 'GIT_CONFIG_'))
                or '=' in key or '\x00' in key or not isinstance(value, str) or '\x00' in value or len(value) > 4096):
            raise PermissionError('Environment variable not permitted: ' + key)
        output[key] = value
    return output


def _prepare(executable: str, args: list[str], cwd_root: str, cwd: str,
             env: dict[str, str], timeout_seconds: float | None, trusted: bool) -> dict:
    definitions = security.config().get('executables', {})
    definition = definitions.get(executable)
    if definition is None or executable not in _profile().get('allowed_executables', []):
        raise PermissionError('Executable not permitted for this client')
    if not isinstance(args, list) or len(args) > 256 or any(not isinstance(a, str) or '\x00' in a or len(a) > 65536 for a in args):
        raise ValueError('argv must contain at most 256 bounded strings without NUL')
    path = Path(definition['path'])
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() in {'.bat', '.cmd'}:
        raise ValueError('Executable must be an existing absolute executable; invoke cmd explicitly for batch files')
    directory = security.resolve_path(cwd_root, cwd, 'execute')
    if not directory.is_dir():
        raise ValueError('Working directory does not exist')
    maximum = float(definition.get('max_seconds', 600))
    duration = maximum if timeout_seconds is None else float(timeout_seconds)
    if not math.isfinite(duration) or duration <= 0 or duration > maximum or maximum > 604800:
        raise ValueError('Timeout must be positive and within the configured executable limit')
    operation_class = definition.get('operation_class', 'sensitive')
    if operation_class not in {'safe', 'sensitive'}:
        raise PermissionError('Invalid executable operation class')
    if not trusted and operation_class == 'safe':
        permitted = definition.get('allowed_args', [])
        if permitted and all(isinstance(a, str) for a in permitted):
            permitted = [permitted]
        if args not in permitted:
            raise PermissionError('Safe executable requires an exact owner-configured argument vector')
    output_limit = int(definition.get('max_output_bytes', 262144))
    if not 1 <= output_limit <= 4194304:
        raise ValueError('Configured output limit must be between 1 byte and 4 MiB')
    encoding = definition.get('output_encoding', 'utf-8')
    codecs.lookup(encoding)
    return {'argv': [str(path), *args], 'cwd': str(directory), 'env': _environment(env, definition),
            'timeout': duration, 'output_limit': output_limit, 'encoding': encoding,
            'sensitive': operation_class == 'sensitive' and not trusted,
            'max_memory_bytes': max(0, int(definition.get('max_memory_bytes', 2147483648))),
            'max_children': max(1, min(64, int(definition.get('max_children', 16))))}


def _event(record: dict) -> None:
    try:
        from bridge_orchestration import emit_runtime_event
        emit_runtime_event('job.changed' if record['kind'] == 'job' else 'processing.completed',
                           record['owner'], {'id': record['id'], 'status': record['status'],
                                             'exit_code': record.get('exit_code')})
    except (ImportError, AttributeError):
        pass
    except Exception:
        # An optional event consumer must never change the subprocess result.
        pass


def _launch(kind: str, request: dict, prepared: dict, idempotency_key: str,
            approval_id: str = '', workflow: str = '', resumed_from: str = '') -> dict:
    owner = security.current_client()
    if len(idempotency_key) > 256:
        raise ValueError('Idempotency key is too long')
    request_digest = _digest({'kind': kind, 'workflow': workflow, 'request': request})
    key_hash = _digest({'owner': owner, 'kind': kind, 'key': idempotency_key}) if idempotency_key else ''
    with _lock:
        _ensure_loaded()
        if key_hash:
            for record in _records.values():
                if record.get('idempotency_hash') == key_hash:
                    if record.get('request_digest') != request_digest:
                        raise ValueError('Idempotency key was already used for a different request')
                    return _view(record)
        limit = min(24, int(security.config().get('runtime', {}).get('max_processes_per_client', 6)))
        active = [r for r in _records.values() if r['status'] in _ACTIVE]
        if len(active) >= 48 or sum(r['owner'] == owner for r in active) >= limit:
            raise ValueError('Managed process concurrency limit reached')
        if prepared['sensitive']:
            security.consume_approval(approval_id, 'process_start', request)
        ident = uuid.uuid4().hex
        audit_id = security.audit('job_submit' if kind == 'job' else 'process_start',
                                 {'id': ident, 'workflow': workflow, 'request': security.redact(request)})
        record = {'id': ident, 'kind': kind, 'owner': owner, 'executor': request['executable'],
                  'workflow': workflow, 'status': 'starting', 'created_at': _now(), 'updated_at': _now(),
                  'started_at': None, 'ended_at': None, 'pid': None, 'pid_created': None,
                  'exit_code': None, 'error': None, 'log_id': audit_id, 'stdout': '', 'stderr': '',
                  'output_truncated': False, 'timeout_seconds': prepared['timeout'],
                  'max_output_bytes': prepared['output_limit'], 'idempotency_hash': key_hash,
                  'request_digest': request_digest, 'request': security.redact(request),
                  'resumed_from': resumed_from or None}
        _records[ident] = record
        _write_record(record)  # reserve idempotency before any side effect
        process = None
        job_handle = None
        try:
            kwargs = {'cwd': prepared['cwd'], 'env': prepared['env'], 'stdin': subprocess.PIPE,
                      'stdout': subprocess.PIPE, 'stderr': subprocess.PIPE, 'shell': False}
            if os.name == 'nt':
                kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                kwargs['start_new_session'] = True
            process = subprocess.Popen(prepared['argv'], **kwargs)
            if os.name == 'nt':
                job_handle = _attach_job(process, prepared['max_memory_bytes'], prepared['max_children'])
            record.update(status='running', pid=process.pid, pid_created=_pid_created(process.pid),
                          started_at=_now(), updated_at=_now(), deadline_epoch=time.time() + prepared['timeout'])
            running = {'process': process, 'job_handle': job_handle, 'reason': '', 'readers': [],
                       'captured_bytes': 0, 'encoding': prepared['encoding'], 'input_bytes': 0,
                       'input_queue': queue.Queue(maxsize=16), 'stdin_closing': False}
            _live[ident] = running
            _write_record(record)
            for stream_name in ('stdout', 'stderr'):
                thread = threading.Thread(target=_read_output, args=(ident, stream_name), daemon=True)
                running['readers'].append(thread)
                thread.start()
            writer = threading.Thread(target=_write_input, args=(ident,), daemon=True)
            running['writer'] = writer
            writer.start()
            ctx = contextvars.copy_context()
            monitor = threading.Thread(target=ctx.run, args=(_monitor, ident, prepared['timeout']), daemon=True)
            running['monitor'] = monitor
            monitor.start()
        except Exception as error:
            if process is not None:
                process.kill()
                process.wait(timeout=5)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
            if job_handle is not None:
                _kernel.CloseHandle(job_handle)
            _live.pop(ident, None)
            record.update(status='failed', error=security.redact(str(error)), ended_at=_now(), updated_at=_now())
            _write_record(record)
        return _view(record)


def _append_output(ident: str, stream_name: str, value: str) -> None:
    with _lock:
        record = _records[ident]
        remaining = record['max_output_bytes'] - len((record['stdout'] + record['stderr']).encode('utf-8'))
        cleaned = security.redact(value).encode('utf-8')
        if len(cleaned) > remaining:
            record['output_truncated'] = True
        record[stream_name] += cleaned[:max(0, remaining)].decode('utf-8', errors='ignore')
        record['updated_at'] = _now()
        _write_record(record)


def _read_output(ident: str, stream_name: str) -> None:
    running = _live[ident]
    stream = getattr(running['process'], stream_name)
    decoder = codecs.getincrementaldecoder(running['encoding'])(errors='replace')
    pending = ''
    try:
        while True:
            chunk = stream.read1(4096)
            if not chunk:
                break
            with _lock:
                limit = _records[ident]['max_output_bytes']
                remaining = max(0, limit - running['captured_bytes'])
                retained = chunk[:remaining]
                running['captured_bytes'] += len(retained)
                if len(chunk) > remaining:
                    _records[ident]['output_truncated'] = True
            pending += decoder.decode(retained)
            # Redact complete lines, preserving secrets split across pipe reads.
            if '\n' in pending:
                complete, pending = pending.rsplit('\n', 1)
                _append_output(ident, stream_name, complete + '\n')
        pending += decoder.decode(b'', final=True)
        if pending:
            _append_output(ident, stream_name, pending)
    except (OSError, ValueError):
        pass


def _write_input(ident: str) -> None:
    """A non-reading child cannot block the caller, shared lock, or timeout monitor."""
    running = _live[ident]
    stream = running['process'].stdin
    while True:
        item = running['input_queue'].get()
        if item is None:
            return
        data, close_stdin = item
        try:
            if data:
                stream.write(data)
                stream.flush()
            if close_stdin:
                stream.close()
                return
        except (OSError, ValueError):
            with _lock:
                record = _records.get(ident)
                if record is not None:
                    record['stdin_error'] = 'Process no longer accepts stdin'
                    _write_record(record)
            return


def _terminate(ident: str) -> bool:
    record = _records[ident]
    running = _live.get(ident)
    if running is not None:
        process = running['process']
        if os.name == 'nt' and running.get('job_handle'):
            return bool(_kernel.TerminateJobObject(running['job_handle'], 1))
        if os.name != 'nt' and _same_process(record):
            try:
                os.killpg(process.pid, signal.SIGKILL)
                return True
            except ProcessLookupError:
                return True
        if process.poll() is None:
            process.kill()  # Popen retains the original Windows handle.
        return False
    if not _same_process(record):
        return False
    if os.name == 'nt':
        handle = _kernel.OpenProcess(0x1000 | 0x1, False, record['pid'])
        if not handle:
            return False
        try:
            if _windows_created(handle) == record['pid_created']:
                _kernel.TerminateProcess(handle, 1)
        finally:
            _kernel.CloseHandle(handle)
        # A restarted server does not own a surviving Job Object; no claim of
        # descendant termination is made without tracked handles.
        return False
    if psutil is not None:
        try:
            owned = psutil.Process(record['pid'])
            if owned.create_time() != record['pid_created']:
                return False
            children = owned.children(recursive=True)
            for child in reversed(children):
                if child.is_running():
                    child.kill()
            owned.kill()
            return True
        except psutil.Error:
            return False
    return False


def _monitor(ident: str, timeout: float) -> None:
    running = _live[ident]
    process = running['process']
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        with _lock:
            if not running['reason']:
                running['reason'] = 'timed_out'
            _terminate(ident)
        process.wait(timeout=10)
    finally:
        # Closing the Job Object also contains descendants outliving the parent.
        with _lock:
            if os.name == 'nt' and running.get('job_handle'):
                _kernel.TerminateJobObject(running['job_handle'], 1)
                _kernel.CloseHandle(running['job_handle'])
                running['job_handle'] = None
        for reader in running['readers']:
            reader.join(timeout=3)
        try:
            running['input_queue'].put_nowait(None)
        except queue.Full:
            pass
        running['writer'].join(timeout=1)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        with _lock:
            record = _records[ident]
            record.update(status=running['reason'] or ('succeeded' if process.returncode == 0 else 'failed'),
                          exit_code=process.returncode, ended_at=_now(), updated_at=_now())
            if record['status'] == 'failed' and record.get('error') is None:
                record['error'] = 'Process exited with code ' + str(process.returncode)
            if record['status'] == 'timed_out':
                record['error'] = 'Configured process timeout exceeded'
            _write_record(record)
            _live.pop(ident, None)
            finished = _view(record)
        security.audit('process_completed', {'id': ident, 'status': record['status'], 'exit_code': record['exit_code']})
        _event(finished)


def _watch_orphan(ident: str) -> None:
    while True:
        with _lock:
            record = _records.get(ident)
            if record is None or record['status'] != 'running_orphaned':
                return
            if not _same_process(record):
                record.update(status='unknown', ended_at=_now(), updated_at=_now())
                _write_record(record)
                return
            if time.time() >= record.get('deadline_epoch', 0):
                complete = _terminate(ident)
                record.update(status='timed_out', ended_at=_now(), updated_at=_now(), tree_stop_complete=complete)
                _write_record(record)
                return
        time.sleep(.5)


def process_start(executable: str, args: list[str], cwd_root: str, cwd: str = '.',
                  env: dict[str, str] | None = None, timeout_seconds: float | None = None,
                  idempotency_key: str = '', approval_id: str = '') -> dict:
    """Start owned argv without shell expansion; sensitive argv needs one-use owner approval.

    Approval operation is process_start with payload containing executable, args,
    cwd_root, cwd, env ({} when omitted), and timeout_seconds (null when omitted).
    Use a stable idempotency_key when retrying an interrupted MCP request.
    """
    security.authorize('process:execute')
    request = {'executable': executable, 'args': args, 'cwd_root': cwd_root, 'cwd': cwd,
               'env': env or {}, 'timeout_seconds': timeout_seconds}
    prepared = _prepare(executable, args, cwd_root, cwd, env or {}, timeout_seconds, False)
    return _launch('process', request, prepared, idempotency_key, approval_id)


def process_status(process_id: str) -> dict:
    """Read only this client's durable managed process state and exit code."""
    with _lock:
        return _view(_owned(process_id))


def process_output(process_id: str, stdout_offset: int = 0, stderr_offset: int = 0,
                   max_chars: int = 16000) -> dict:
    """Page sanitized stdout/stderr independently by character offset."""
    if stdout_offset < 0 or stderr_offset < 0 or not 1 <= max_chars <= 65536:
        raise ValueError('Invalid output offset or page size')
    with _lock:
        record = _owned(process_id)
        stdout = record['stdout'][stdout_offset:stdout_offset + max_chars]
        stderr = record['stderr'][stderr_offset:stderr_offset + max_chars]
        return {'id': process_id, 'status': record['status'], 'stdout': stdout, 'stderr': stderr,
                'stdout_next': stdout_offset + len(stdout), 'stderr_next': stderr_offset + len(stderr),
                'stdout_more': len(record['stdout']) > stdout_offset + len(stdout),
                'stderr_more': len(record['stderr']) > stderr_offset + len(stderr),
                'output_truncated': record['output_truncated'], 'exit_code': record['exit_code']}


def process_input(process_id: str, text: str = '', close_stdin: bool = False) -> dict:
    """Queue bounded stdin to this client's live process; input is never logged.

    accepted_bytes acknowledges queued input; process output confirms its use.
    Non-reading child stdin cannot block the timeout or MCP request thread.
    """
    data = text.encode('utf-8')
    if len(data) > 4096:
        raise ValueError('stdin chunk exceeds 4096 bytes')
    with _lock:
        record = _owned(process_id, 'process:execute')
        running = _live.get(process_id)
        if running is None or record['status'] != 'running' or running['process'].poll() is not None:
            raise ValueError('Process input unavailable; process ended or server restarted')
        if running['input_bytes'] + len(data) > 65536:
            raise ValueError('stdin total exceeds 64 KiB')
        stream = running['process'].stdin
        if stream.closed or running['stdin_closing']:
            raise ValueError('stdin already closed')
        try:
            running['input_queue'].put_nowait((data, close_stdin))
            running['input_bytes'] += len(data)
            if close_stdin:
                running['stdin_closing'] = True
        except queue.Full as error:
            raise ValueError('stdin queue full; wait for the process to consume input') from error
        security.audit('process_input', {'id': process_id, 'bytes': len(data), 'closed': close_stdin})
        return {'id': process_id, 'accepted_bytes': len(data), 'delivery': 'queued',
                'stdin_closed': stream.closed, 'stdin_closing': running['stdin_closing']}


def process_stop(process_id: str) -> dict:
    """Stop only a process owned by this client; never accept arbitrary OS PIDs."""
    with _lock:
        record = _owned(process_id, 'process:execute')
        if record['status'] not in _ACTIVE:
            return _view(record)
        security.audit('process_stop', {'id': process_id})
        running = _live.get(process_id)
        if running is not None:
            running['reason'] = 'cancelled'
        complete = _terminate(process_id)
        record['tree_stop_complete'] = complete
        if running is None:
            record.update(status='cancelled', ended_at=_now(), updated_at=_now())
        _write_record(record)
        return _view(record)


def process_list(limit: int = 100, offset: int = 0) -> list[dict]:
    """List this client's durable processes and jobs, including completed operations."""
    owner = security.authorize('process:read')
    if not 1 <= limit <= 200 or offset < 0:
        raise ValueError('Invalid list page')
    with _lock:
        _ensure_loaded()
        items = sorted((r for r in _records.values() if r['owner'] == owner),
                       key=lambda r: r['created_at'], reverse=True)
        return [_view(r) for r in items[offset:offset + limit]]


def _workflow_request(workflow: str, timeout_seconds: float | None) -> tuple[dict, dict]:
    definition = security.config().get('trusted_workflows', {}).get(workflow)
    if definition is None or workflow not in _profile().get('allowed_workflows', []):
        raise PermissionError('Trusted workflow not permitted for this client')
    request = {'executable': definition['executable'], 'args': definition.get('args', []),
               'cwd_root': definition['cwd_root'], 'cwd': definition.get('cwd', '.'),
               'env': definition.get('env', {}),
               'timeout_seconds': timeout_seconds if timeout_seconds is not None else definition.get('timeout_seconds')}
    prepared = _prepare(request['executable'], request['args'], request['cwd_root'], request['cwd'],
                        request['env'], request['timeout_seconds'], True)
    return request, prepared


def job_submit(workflow: str, idempotency_key: str = '', timeout_seconds: float | None = None) -> dict:
    """Run a fixed owner-configured workflow as a durable job independent of MCP lifetime."""
    security.authorize('job:execute')
    request, prepared = _workflow_request(workflow, timeout_seconds)
    return _launch('job', request, prepared, idempotency_key, workflow=workflow)


def job_status(job_id: str) -> dict:
    """Read this client's job metadata, timestamps, execution state and audit reference."""
    return process_status(job_id)


def job_result(job_id: str, stdout_offset: int = 0, stderr_offset: int = 0,
               max_chars: int = 64000) -> dict:
    """Return sanitized job output, paging offsets, error, exit code and log reference."""
    output = process_output(job_id, stdout_offset, stderr_offset, max_chars)
    status = process_status(job_id)
    output.update(error=status.get('error'), log_id=status['log_id'], executor=status['executor'],
                  started_at=status['started_at'], ended_at=status['ended_at'])
    return output


def job_cancel(job_id: str) -> dict:
    """Cancel a job owned by this client and stop its owned process tree."""
    security.authorize('job:execute')
    return process_stop(job_id)


def job_resume(job_id: str, idempotency_key: str = '') -> dict:
    """Explicitly retry only an owner-marked retry_safe workflow; unknown outcomes never replay automatically."""
    security.authorize('job:execute')
    with _lock:
        record = _owned(job_id)
        if record['kind'] != 'job' or record['status'] not in {'unknown', 'failed', 'cancelled', 'timed_out'}:
            raise ValueError('Only an interrupted or failed workflow job can be resumed')
        workflow = record['workflow']
        definition = security.config().get('trusted_workflows', {}).get(workflow, {})
        if definition.get('retry_safe') is not True:
            raise PermissionError('Workflow is not declared safe to retry')
        request, prepared = _workflow_request(workflow, record['request'].get('timeout_seconds'))
        if _digest({'kind': 'job', 'workflow': workflow, 'request': request}) != record['request_digest']:
            raise ValueError('Workflow changed since submission; submit a new job explicitly')
        # Default retry key is stable for this source ID, preventing repeated
        # resume calls from creating multiple replacement processes.
        key = idempotency_key or 'resume:' + job_id
        return _launch('job', request, prepared, key, workflow=workflow, resumed_from=job_id)


def job_list(limit: int = 100, offset: int = 0) -> list[dict]:
    """List this client's durable workflow jobs with pagination."""
    owner = security.authorize('process:read')
    if not 1 <= limit <= 200 or offset < 0:
        raise ValueError('Invalid list page')
    with _lock:
        _ensure_loaded()
        items = sorted((r for r in _records.values() if r['owner'] == owner and r['kind'] == 'job'),
                       key=lambda r: r['created_at'], reverse=True)
        return [_view(r) for r in items[offset:offset + limit]]


def register(mcp) -> None:
    """Register typed MCP tools on the existing FastMCP server."""
    for tool in (process_start, process_status, process_output, process_input, process_stop, process_list,
                 job_submit, job_status, job_result, job_cancel, job_resume, job_list):
        mcp.tool()(tool)


def _shutdown_for_tests() -> None:
    """Join real child monitors so fixture folders can be safely removed."""
    for running in list(_live.values()):
        monitor = running.get('monitor')
        if monitor is not None:
            monitor.join(timeout=5)
