#!/usr/bin/env python3
"""Freeze and test only registration storage/reader code; no Docker or live fleet access."""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
parser = argparse.ArgumentParser(description="Isolated Linux-root registration ownership checks (ARM64 Multipass host).")
parser.add_argument("--keep", action="store_true", help="retain a successful VM and frozen sources")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[3]
name='kayra-registration-ownership-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
evidence=root/'.cache/lab-evidence'/name
evidence.mkdir(parents=True,mode=0o700)
source=pathlib.Path(tempfile.mkdtemp(prefix='kayra-ownership-source-'))
paths=[root/'scripts/server-lib/registration_generation.py',root/'scripts/server-lib/registration_command.py',root/'package.json',root/'ci/tests/swarm-host/authority.json',pathlib.Path(__file__).resolve()]
for directory in ['cli/src','node_modules/zod','ci/tests/registration-generation']:
    paths.extend(p for p in (root/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
paths.extend(root/p for p in ['cli/test/deployment/registration-ownership-publication.test.ts', 'cli/test/deployment/registration-infrastructure.test.ts'])
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
archive=source/'source.tar'
with tarfile.open(archive,'w') as tar:
    for p in paths: tar.add(p,arcname=p.relative_to(root),recursive=False)
(evidence/'source-files.json').write_text(json.dumps(manifest,indent=2)+'\n')
(evidence/'context.json').write_text(json.dumps({'vm':name,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'workingChanges':subprocess.check_output(['git','diff','--stat'],text=True),'archive':str(archive)},indent=2)+'\n')
def run(args):
    print('+', ' '.join(args),flush=True)
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    print(result.stdout,flush=True)
    with (evidence/'commands.log').open('a') as log: log.write('+ '+' '.join(args)+'\n'+result.stdout)
    result.check_returncode()
    return result.stdout
try:
    run(['multipass','launch','24.04','--name',name,'--cpus','2','--memory','4G','--disk','20G'])
    run(['multipass','exec',name,'--','cloud-init','status','--wait'])
    run(['multipass','transfer',str(archive),name+':/home/ubuntu/source.tar'])
    run(['multipass','exec',name,'--','sudo','mkdir','-p','/opt/ownership-lab'])
    run(['multipass','exec',name,'--','sudo','tar','-xf','/home/ubuntu/source.tar','-C','/opt/ownership-lab'])
    run(['multipass','exec',name,'--','sudo','python3','-B','/opt/ownership-lab/ci/tests/registration-generation/test_generation.py'])
    run(['multipass','exec',name,'--','bash','-c','cd /home/ubuntu && curl -fsSLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.xz && curl -fsSLO https://nodejs.org/dist/v24.22.1/SHASUMS256.txt && sha256sum --check --ignore-missing SHASUMS256.txt && tar -xf node-v24.22.1-linux-arm64.tar.xz'])
    run(['multipass','exec',name,'--','sudo','/home/ubuntu/node-v24.22.1-linux-arm64/bin/node','--test','/opt/ownership-lab/cli/test/deployment/registration-ownership-publication.test.ts','/opt/ownership-lab/cli/test/deployment/registration-infrastructure.test.ts'])
    version=run(['multipass','exec',name,'--','bash','-c','cat /etc/os-release; uname -a; python3 --version; /home/ubuntu/node-v24.22.1-linux-arm64/bin/node --version'])
    (evidence/'environment.txt').write_text(version)
    run(['multipass','info',name,'--format','json'])
    if not args.keep:
        run(['multipass','delete','--purge',name])
        shutil.rmtree(source)
    (evidence/'summary.json').write_text(json.dumps({'result':'passed','vm':name,'destroyed':not args.keep,'scope':'root registration filesystem suite and TS owner reader; no Docker/platform-upgrade integration'},indent=2)+'\n')
except BaseException:
    print('FAILED: preserved VM and source. Cleanup only after inspection: multipass delete --purge '+name,flush=True)
    raise
finally:
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence.iterdir() if p.is_file()}
    (evidence/"sha256.json").write_text(json.dumps(hashes, indent=2)+"\n")
    for p in evidence.iterdir(): p.chmod(0o600)
    print('Evidence: '+str(evidence),flush=True)
