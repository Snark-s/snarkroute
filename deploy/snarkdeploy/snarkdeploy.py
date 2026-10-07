#!/usr/bin/env python3
from __future__ import annotations
import argparse, fnmatch, hashlib, json, os, shutil, socket, subprocess, sys, tempfile, urllib.request, zipfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "manifest.json"

def load_manifest():
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

def expand(value, variables):
    if not isinstance(value, str):
        return value
    env = dict(os.environ)
    env.setdefault("APPDATA", os.getenv("APPDATA",""))
    env.setdefault("LOCALAPPDATA", os.getenv("LOCALAPPDATA",""))
    resolved = value
    merged = {}
    for k, spec in variables.items():
        merged[k] = os.getenv(k) or spec.get("default","")
    for _ in range(8):
        old = resolved
        for k,v in merged.items():
            vv = str(v)
            for kk,vv2 in merged.items():
                vv = vv.replace("{{"+kk+"}}", str(vv2))
            vv = vv.replace("{{APPDATA}}", env["APPDATA"]).replace("{{LOCALAPPDATA}}", env["LOCALAPPDATA"])
            resolved = resolved.replace("{{"+k+"}}", vv)
        resolved = resolved.replace("{{APPDATA}}", env["APPDATA"]).replace("{{LOCALAPPDATA}}", env["LOCALAPPDATA"])
        if resolved == old:
            break
    return os.path.expandvars(resolved)

def run(cmd, cwd=None, check=True):
    if isinstance(cmd, str):
        p = subprocess.run(cmd, cwd=cwd, shell=True, text=True, capture_output=True)
    else:
        p = subprocess.run(cmd, cwd=cwd, shell=False, text=True, capture_output=True)
    if check and p.returncode:
        raise RuntimeError((p.stderr or p.stdout or f"command failed: {cmd}").strip())
    return p

def command_exists(name):
    return shutil.which(name) is not None

def should_exclude(rel, patterns):
    parts = Path(rel).parts
    for pat in patterns:
        if pat in parts or fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(Path(rel).name, pat):
            return True
    return False

def copy_tree_into_zip(zf, src, prefix, excludes):
    src = Path(src)
    for p in src.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(src).as_posix()
        if should_exclude(rel, excludes):
            continue
        zf.write(p, f"{prefix}/{rel}")

def git_info(path):
    path = Path(path)
    if not (path / ".git").exists():
        return None
    commit = run(["git","rev-parse","HEAD"], cwd=path).stdout.strip()
    remote = run(["git","remote","get-url","origin"], cwd=path, check=False).stdout.strip()
    patch = run(["git","diff","--binary","HEAD"], cwd=path, check=False).stdout
    untracked = run(["git","ls-files","--others","--exclude-standard"], cwd=path, check=False).stdout.splitlines()
    branch = run(["git","branch","--show-current"], cwd=path, check=False).stdout.strip()
    return {"commit":commit,"remote":remote,"branch":branch,"patch":patch,"untracked":untracked}

def write_registry(manifest):
    vars_ = manifest["variables"]
    services=[]
    for s in manifest.get("services",[]):
        item=dict(s)
        for k,v in list(item.items()):
            if isinstance(v,str):
                item[k]=expand(v,vars_)
        services.append(item)
    target=Path(expand(manifest["variables"]["SNARK_REGISTRY_PATH"]["default"],vars_))
    target.parent.mkdir(parents=True,exist_ok=True)
    payload={"schema_version":1,"generated_at":datetime.now().isoformat(timespec="seconds"),"services":services}
    target.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    return target

def probe_tcp(host,port,timeout=0.8):
    try:
        with socket.create_connection((host,int(port)),timeout=timeout):
            return True,None
    except OSError as e:
        return False,str(e)

def probe_http(url,timeout=1.5):
    try:
        with urllib.request.urlopen(url,timeout=timeout) as r:
            return 200 <= r.status < 500, f"HTTP {r.status}"
    except Exception as e:
        return False,str(e)

def doctor(args):
    m=load_manifest(); vars_=m["variables"]; bad=0
    print("SnarkDeploy doctor")
    print("="*48)
    print("\nPrerequisites")
    for p in m.get("prerequisites",[]):
        names=[p["command"]]+p.get("alternatives",[])
        ok=any(command_exists(x) for x in names)
        req=p.get("required",False)
        print(f"  {'OK ' if ok else ('ERR' if req else '---')} {p['id']}")
        if req and not ok: bad+=1
    print("\nComponents")
    for c in m.get("components",[]):
        path=Path(expand(c["path"],vars_))
        ok=path.exists()
        print(f"  {'OK ' if ok else '---'} {c['id']}: {path}")
        if c["id"]=="snarkroute" and not ok: bad+=1
    print("\nServices")
    for s in m.get("services",[]):
        pr=s.get("probe",{})
        ok=False; detail=""
        if pr.get("type")=="tcp":
            ok,detail=probe_tcp(pr["host"],pr["port"])
        elif pr.get("type")=="http":
            base=s.get("endpoint","").rstrip("/")
            ok,detail=probe_http(base+pr.get("path",""))
        print(f"  {'UP ' if ok else 'down'} {s['id']}: {s.get('endpoint','')} {detail or ''}".rstrip())
    if command_exists("nvidia-smi"):
        r=run(["nvidia-smi","--query-gpu=name,memory.total,memory.used,driver_version","--format=csv,noheader"],check=False)
        if r.stdout.strip():
            print("\nGPU")
            for line in r.stdout.strip().splitlines(): print(" ",line)
    reg=write_registry(m)
    print(f"\nRegistry: {reg}")
    return bad

def snapshot(args):
    m=load_manifest(); vars_=m["variables"]; excludes=m.get("snapshot_excludes",[])
    out=Path(args.output or ".").expanduser().resolve()
    out.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now().strftime("%Y%m%d-%H%M%S")
    dest=out/f"snark-recovery-{stamp}.zip"
    state={"schema_version":1,"created_at":datetime.now().isoformat(timespec="seconds"),"components":[],"inventories":[]}
    with zipfile.ZipFile(dest,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as zf:
        for c in m.get("components",[]):
            if not c.get("snapshot",False): continue
            path=Path(expand(c["path"],vars_))
            rec={"id":c["id"],"path":str(path),"strategy":c["strategy"],"present":path.exists()}
            if not path.exists():
                state["components"].append(rec); continue
            gi=git_info(path) if c["strategy"] in ("git","git-or-copy") else None
            if gi and gi.get("remote"):
                rec.update({"mode":"git","commit":gi["commit"],"remote":gi["remote"],"branch":gi["branch"]})
                if gi["patch"]:
                    zf.writestr(f"git/{c['id']}/working.patch",gi["patch"])
                for rel in gi["untracked"]:
                    p=path/rel
                    if p.is_file() and not should_exclude(rel,excludes):
                        zf.write(p,f"git/{c['id']}/untracked/{Path(rel).as_posix()}")
            else:
                rec["mode"]="copy"
                copy_tree_into_zip(zf,path,f"files/{c['id']}",excludes)
            state["components"].append(rec)
        for inv in m.get("inventories",[]):
            p=Path(expand(inv,vars_))
            if p.is_file():
                key=hashlib.sha256(str(p).encode("utf-8")).hexdigest()[:12]
                zf.write(p,f"inventories/{key}-{p.name}")
                state["inventories"].append({"source":str(p),"file":f"inventories/{key}-{p.name}"})
        zf.writestr("state.json",json.dumps(state,ensure_ascii=False,indent=2))
        zf.writestr("manifest.json",json.dumps(m,ensure_ascii=False,indent=2))
    print(dest)
    return 0

def safe_extract(zf, member, target):
    target=Path(target).resolve()
    out=(target/member).resolve()
    if target not in out.parents and out != target:
        raise RuntimeError("unsafe zip path")
    zf.extract(member,target)

def restore(args):
    bundle=Path(args.bundle).expanduser().resolve()
    if not bundle.is_file(): raise FileNotFoundError(bundle)
    current=load_manifest(); vars_=current["variables"]
    with zipfile.ZipFile(bundle,"r") as zf:
        state=json.loads(zf.read("state.json").decode("utf-8"))
        for rec in state.get("components",[]):
            if not rec.get("present"): continue
            c=next((x for x in current["components"] if x["id"]==rec["id"]),None)
            if not c: continue
            target=Path(expand(c["path"],vars_))
            target.parent.mkdir(parents=True,exist_ok=True)
            if rec.get("mode")=="git":
                if not (target/".git").exists():
                    if target.exists() and any(target.iterdir()):
                        raise RuntimeError(f"restore target is non-empty: {target}")
                    if target.exists(): target.rmdir()
                    run(["git","clone",rec["remote"],str(target)])
                run(["git","fetch","--all","--tags"],cwd=target,check=False)
                run(["git","checkout","--detach",rec["commit"]],cwd=target)
                patch_name=f"git/{rec['id']}/working.patch"
                if patch_name in zf.namelist():
                    with tempfile.NamedTemporaryFile("wb",delete=False,suffix=".patch") as tf:
                        tf.write(zf.read(patch_name)); patch=tf.name
                    try: run(["git","apply","--binary",patch],cwd=target)
                    finally: os.unlink(patch)
                prefix=f"git/{rec['id']}/untracked/"
                for name in zf.namelist():
                    if name.startswith(prefix) and not name.endswith("/"):
                        rel=name[len(prefix):]
                        dst=target/Path(rel)
                        dst.parent.mkdir(parents=True,exist_ok=True)
                        with zf.open(name) as src, open(dst,"wb") as out: shutil.copyfileobj(src,out)
            else:
                prefix=f"files/{rec['id']}/"
                target.mkdir(parents=True,exist_ok=True)
                for name in zf.namelist():
                    if name.startswith(prefix) and not name.endswith("/"):
                        rel=name[len(prefix):]
                        dst=target/Path(rel)
                        dst.parent.mkdir(parents=True,exist_ok=True)
                        with zf.open(name) as src, open(dst,"wb") as out: shutil.copyfileobj(src,out)
    write_registry(current)
    print("Restore complete.")
    return 0

def install(args):
    m=load_manifest(); vars_=m["variables"]
    for c in m.get("components",[]):
        path=Path(expand(c["path"],vars_))
        if c.get("remote") and not path.exists():
            path.parent.mkdir(parents=True,exist_ok=True)
            print(f"Cloning {c['id']} -> {path}")
            run(["git","clone",c["remote"],str(path)])
        for cmd in c.get("install_commands",[]):
            if path.exists():
                print(f"[{c['id']}] {cmd}")
                run(cmd,cwd=path)
    reg=write_registry(m)
    print(f"Install complete. Registry: {reg}")
    return 0

def main():
    ap=argparse.ArgumentParser(prog="snarkdeploy")
    sub=ap.add_subparsers(dest="command",required=True)
    sub.add_parser("doctor")
    sp=sub.add_parser("snapshot"); sp.add_argument("--output",default=".")
    rp=sub.add_parser("restore"); rp.add_argument("bundle")
    sub.add_parser("install")
    a=ap.parse_args()
    try:
        code={"doctor":doctor,"snapshot":snapshot,"restore":restore,"install":install}[a.command](a)
        raise SystemExit(code)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        print(f"ERROR: {e}",file=sys.stderr)
        raise SystemExit(1)

if __name__=="__main__":
    main()
