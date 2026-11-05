#!/usr/bin/env python3
"""Bind the built archive to source; release signing checks both fields."""
import hashlib,json,os,pathlib,subprocess,sys
archive=pathlib.Path(sys.argv[1])
receipt={"commit":os.environ.get("BUILD_SOURCE_COMMIT") or subprocess.check_output(["git","rev-parse","HEAD"],cwd=pathlib.Path(__file__).resolve().parents[2],text=True).strip(),
         "archive":archive.name,"sha256":hashlib.sha256(archive.read_bytes()).hexdigest()}
(archive.parent/"build-receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
