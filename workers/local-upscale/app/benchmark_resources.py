"""Windows session containment/telemetry. Definitions only; no probes at import."""
from __future__ import annotations

import ctypes as c
import os
import time
import threading
from datetime import UTC, datetime
from ctypes import wintypes as w


def windows_api():
    if os.name != "nt": raise RuntimeError("Prepared benchmark containment requires Windows")
    kernel = c.WinDLL("kernel32",use_last_error=True)
    for name,args,result in [
        ("CreateJobObjectW",[c.c_void_p,w.LPCWSTR],w.HANDLE),
        ("SetInformationJobObject",[w.HANDLE,c.c_int,c.c_void_p,w.DWORD],w.BOOL),
        ("QueryInformationJobObject",[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.c_void_p],w.BOOL),
        ("AssignProcessToJobObject",[w.HANDLE,w.HANDLE],w.BOOL),
        ("OpenProcess",[w.DWORD,w.BOOL,w.DWORD],w.HANDLE),
        ("GetCurrentProcess",[],w.HANDLE),
        ("GetProcessAffinityMask",[w.HANDLE,c.POINTER(c.c_size_t),c.POINTER(c.c_size_t)],w.BOOL),
        ("SetProcessAffinityMask",[w.HANDLE,c.c_size_t],w.BOOL),
        ("CloseHandle",[w.HANDLE],w.BOOL),
        ("TerminateJobObject",[w.HANDLE,w.UINT],w.BOOL),
        ("GetSystemTimes",[c.c_void_p,c.c_void_p,c.c_void_p],w.BOOL),
        ("GlobalMemoryStatusEx",[c.c_void_p],w.BOOL),
        ("GetProcessTimes",[w.HANDLE,c.c_void_p,c.c_void_p,c.c_void_p,c.c_void_p],w.BOOL),
        ("GetExitCodeProcess",[w.HANDLE,c.POINTER(w.DWORD)],w.BOOL),
        ("QueryFullProcessImageNameW",[w.HANDLE,w.DWORD,w.LPWSTR,c.POINTER(w.DWORD)],w.BOOL),
    ]:
        method = getattr(kernel,name); method.argtypes=args; method.restype=result
    return kernel


def checked(value):
    if not value: raise c.WinError(c.get_last_error())
    return value


def affinity_mask(kernel, threads):
    allowed,system = c.c_size_t(),c.c_size_t()
    checked(kernel.GetProcessAffinityMask(kernel.GetCurrentProcess(),c.byref(allowed),c.byref(system)))
    bits = [1 << n for n in range(c.sizeof(c.c_size_t)*8) if allowed.value & (1 << n)]
    if len(bits) < threads: raise RuntimeError("Insufficient allowed CPUs for benchmark affinity")
    return sum(bits[:threads])


def cap_current_process(threads):
    kernel = windows_api()
    mask = affinity_mask(kernel,threads)
    checked(kernel.SetProcessAffinityMask(kernel.GetCurrentProcess(),mask))
    return mask


class BasicLimits(c.Structure):
    _fields_ = [("ProcessTime",c.c_int64),("JobTime",c.c_int64),("Flags",w.DWORD),
        ("MinWorkingSet",c.c_size_t),("MaxWorkingSet",c.c_size_t),("ActiveLimit",w.DWORD),
        ("Affinity",c.c_size_t),("Priority",w.DWORD),("Scheduling",w.DWORD)]


class IOCounters(c.Structure):
    _fields_ = [(name,c.c_uint64) for name in ("ReadOps","WriteOps","OtherOps","ReadBytes","WriteBytes","OtherBytes")]


class ExtendedLimits(c.Structure):
    _fields_ = [("Basic",BasicLimits),("IO",IOCounters),("ProcessMemory",c.c_size_t),
        ("JobMemory",c.c_size_t),("PeakProcessMemory",c.c_size_t),("PeakJobMemory",c.c_size_t)]


class Accounting(c.Structure):
    _fields_ = [(name,c.c_int64) for name in ("User","Kernel","PeriodUser","PeriodKernel")] + [
        (name,w.DWORD) for name in ("PageFaults","TotalProcesses","ActiveProcesses","TerminatedProcesses")]


class MemoryStatus(c.Structure):
    _fields_ = [("Length",w.DWORD),("Load",w.DWORD)] + [(name,c.c_uint64) for name in
        ("TotalPhysical","AvailablePhysical","TotalPageFile","AvailablePageFile","TotalVirtual","AvailableVirtual","AvailableExtendedVirtual")]


class ProcessMemory(c.Structure):
    _fields_ = [("Size",w.DWORD),("PageFaults",w.DWORD)] + [(name,c.c_size_t) for name in
        ("PeakWorkingSet","WorkingSet","QuotaPeakPaged","QuotaPaged","QuotaPeakNonPaged","QuotaNonPaged","Pagefile","PeakPagefile")]


class OwnedSession:
    """A job contains only this harness's spawned processes and their descendants."""
    def __init__(self, threads):
        self.kernel = windows_api()
        self.handle = checked(self.kernel.CreateJobObjectW(None,None))
        self.affinity = affinity_mask(self.kernel,threads)
        limits = ExtendedLimits()
        limits.Basic.Flags = 0x2000 | 0x10  # KILL_ON_JOB_CLOSE | AFFINITY
        limits.Basic.Affinity = self.affinity
        try: checked(self.kernel.SetInformationJobObject(self.handle,9,c.byref(limits),c.sizeof(limits)))
        except BaseException:
            self.close(); raise
        self.previous = None
        self.process_handles = {}
        self.process_images = {}
        self.snapshot_lock = threading.RLock()
        self.psapi = c.WinDLL("psapi",use_last_error=True)
        self.psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE,c.c_void_p,w.DWORD]
        self.psapi.GetProcessMemoryInfo.restype = w.BOOL

    def add(self, pid):
        handle = checked(self.kernel.OpenProcess(0x0100 | 0x0001,False,pid))
        try: checked(self.kernel.AssignProcessToJobObject(self.handle,handle))
        finally: self.kernel.CloseHandle(handle)

    def accounting(self):
        value = Accounting()
        checked(self.kernel.QueryInformationJobObject(self.handle,1,c.byref(value),c.sizeof(value),None))
        return value

    def pids(self):
        class Pids(c.Structure):
            _fields_ = [("Assigned",w.DWORD),("Count",w.DWORD),("Values",c.c_size_t*128)]
        value = Pids()
        checked(self.kernel.QueryInformationJobObject(self.handle,3,c.byref(value),c.sizeof(value),None))
        return list(value.Values[:value.Count])

    def sample(self):
        self.snapshot()  # retain identities/handles before short-lived children exit
        now = time.perf_counter()
        accounting = self.accounting()
        idle,kernel,user = c.c_uint64(),c.c_uint64(),c.c_uint64()
        checked(self.kernel.GetSystemTimes(c.byref(idle),c.byref(kernel),c.byref(user)))
        cpu_ticks = accounting.User + accounting.Kernel
        total_ticks = kernel.value + user.value
        process_cpu,total_cpu = None,None  # first sample has no interval; do not invent 0% usage
        if self.previous:
            old_now,old_cpu,old_total,old_idle = self.previous
            process_cpu = max(0,(cpu_ticks-old_cpu)/1e7/(now-old_now)*100)
            delta = total_ticks-old_total
            total_cpu = max(0,(1-(idle.value-old_idle)/delta)*100) if delta else 0
        self.previous = now,cpu_ticks,total_ticks,idle.value
        memory = MemoryStatus(); memory.Length=c.sizeof(memory)
        checked(self.kernel.GlobalMemoryStatusEx(c.byref(memory)))
        rss = 0
        for pid in self.pids():
            handle = self.kernel.OpenProcess(0x0400 | 0x0010,False,pid)
            if not handle: continue  # process can exit between snapshots
            try:
                info=ProcessMemory(); info.Size=c.sizeof(info)
                measured=self.psapi.GetProcessMemoryInfo(handle,c.byref(info),c.sizeof(info))
                if not measured:
                    if pid in self.pids(): checked(measured)
                    continue  # process exited between PID snapshot and memory query
                rss += info.WorkingSet
            finally: self.kernel.CloseHandle(handle)
        return dict(monotonic_seconds=now,process_cpu_percent_one_core=process_cpu,
                    total_cpu_percent=total_cpu,rss_bytes=rss,available_ram_bytes=memory.AvailablePhysical,
                    owned_active_processes=accounting.ActiveProcesses)

    def snapshot(self):
        with self.snapshot_lock:
            active = self.pids()
            errors = []
            for pid in active:
                if pid not in self.process_handles:
                    handle = self.kernel.OpenProcess(0x1000,False,pid)
                    if handle: self.process_handles[pid] = handle
                    else: errors.append({"pid":pid,"error":c.get_last_error()})
            processes = []
            for pid,handle in self.process_handles.items():
                created,exited,kernel,user = (c.c_uint64() for _ in range(4))
                code = w.DWORD()
                checked(self.kernel.GetProcessTimes(handle,c.byref(created),c.byref(exited),c.byref(kernel),c.byref(user)))
                checked(self.kernel.GetExitCodeProcess(handle,c.byref(code)))
                name = c.create_unicode_buffer(32768); length = w.DWORD(len(name))
                named = self.kernel.QueryFullProcessImageNameW(handle,0,name,c.byref(length))
                if named: self.process_images[pid] = name.value
                def stamp(ticks):
                    return datetime.fromtimestamp(ticks/1e7-11644473600,UTC).isoformat() if ticks else None
                processes.append(dict(pid=pid,start_time=stamp(created.value),exit_time=stamp(exited.value),
                    exit_status=code.value,active=pid in active,image=self.process_images.get(pid)))
            return dict(timestamp=datetime.now(UTC).isoformat(),active_processes=self.accounting().ActiveProcesses,
                active_pids=active,processes=processes,identity_errors=errors,affinity_mask=self.affinity)

    def terminate(self): checked(self.kernel.TerminateJobObject(self.handle,1))
    def close(self):
        for handle in getattr(self,"process_handles",{}).values(): self.kernel.CloseHandle(handle)
        if hasattr(self,"process_handles"): self.process_handles.clear()
        if self.handle:
            self.kernel.CloseHandle(self.handle); self.handle=None
