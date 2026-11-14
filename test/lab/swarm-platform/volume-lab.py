#!/usr/bin/env python3
"""Fresh single-node Docker adapter lab; no existing VM/context is changed."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--output', type=Path)
parser.add_argument('--keep', action='store_true')
parser.add_argument('--platform-inputs', action='store_true', help='also verify exact platform input generations and permissions as deployer UID 1000')
parser.add_argument('--image-admission', action='store_true', help='also verify real registry metadata against declared service and one-shot mounts')
args = parser.parse_args()
source = args.source.resolve()
vm = 'kayra-volume-lab-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S%f')
if subprocess.run(['multipass', 'info', vm], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0:
    raise SystemExit('refusing existing VM: ' + vm)
report = (args.output or Path.cwd() / '.cache/lab-evidence' / vm).resolve()
report.mkdir(parents=True, mode=0o700)
os.chmod(report, 0o700)
work = Path(tempfile.mkdtemp(prefix='kayra-volume-lab-'))
frozen = work / 'source'
frozen.mkdir()
paths = ['cli/src/contracts', 'cli/src/lib', 'cli/src/server/runtime/owned-volume.ts', 'cli/src/server/runtime/docker-api.ts',
         'package.json', 'test/lab/stage-source.yml', 'test/lab/swarm-platform/volume-runtime.mjs',
         'test/lab/swarm-platform/volume-runtime.yml', 'ansible/roles/docker', 'ansible/ansible.cfg', 'ansible/callback_plugins', 'node_modules/zod']
if args.platform_inputs:
    paths += ['cli/src/server/platform', 'test/lab/swarm-platform/platform-inputs.mjs']
if args.image_admission:
    paths += ['cli/src/server/runtime/registry-images.ts', 'cli/src/server/runtime/image-json.ts', 'test/lab/swarm-platform/declared-images.mjs']
for relative in paths:
    origin, target = source / relative, frozen / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if origin.is_dir():
        shutil.copytree(origin, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copy2(origin, target)
files = [{'path': str(path.relative_to(frozen)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
         for path in sorted(frozen.rglob('*')) if path.is_file()]
(report / 'source-files.json').write_text(json.dumps(files, indent=2))
with tarfile.open(report / 'source.tar', 'w') as archive:
    archive.add(frozen, arcname='source')
image = 'node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea'
commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
context = {'sourceCommit': commit, 'sourceManifest': 'source-files.json', 'vm': vm, 'source': str(source), 'frozen': str(frozen), 'workspace': str(work), 'output': str(report), 'nodeImage': image, 'scope': 'runtime adapter and optional platform input readers only; no managed application or coordinator', 'platformInputs': args.platform_inputs, 'declaredImages': args.image_admission}
(report / 'context.json').write_text(json.dumps(context, indent=2))
log = (report / 'lab.log').open('w')
awake = subprocess.Popen(['caffeinate', '-i', '-s'])
succeeded = False


def run(command, **kwargs):
    return subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT, **kwargs)


try:
    key = work / 'id_ed25519'
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
    cloud = work / 'cloud-init.yml'
    cloud.write_text('#cloud-config\n' + json.dumps({'users': ['default', {'name': 'deploy', 'groups': 'sudo', 'shell': '/bin/bash', 'sudo': ['ALL=(ALL) NOPASSWD:ALL'], 'ssh_authorized_keys': [key.with_suffix('.pub').read_text().strip()]}], 'package_update': True, 'packages': ['python3-debian', 'ca-certificates', 'curl', 'apparmor']}))
    run(['multipass', 'launch', '24.04', '--name', vm, '--cpus', '2', '--memory', '4G', '--disk', '20G', '--cloud-init', str(cloud)])
    run(['multipass', 'exec', vm, '--', 'cloud-init', 'status', '--wait'])
    info = json.loads(subprocess.check_output(['multipass', 'info', vm, '--format', 'json'], text=True))
    address = info['info'][vm]['ipv4'][0]
    inventory = work / 'inventory.ini'
    inventory.write_text('[servers]\nvolume-lab ansible_host=' + address + ' ansible_user=deploy ansible_ssh_private_key_file=' + str(key) + ' ansible_ssh_common_args="-o IdentitiesOnly=yes"\n')
    env = {**os.environ, 'ANSIBLE_CONFIG': str(frozen / 'ansible/ansible.cfg'), 'PYTHONDONTWRITEBYTECODE': '1'}
    run(['ansible-playbook', '-i', str(inventory), str(frozen / 'test/lab/swarm-platform/volume-runtime.yml'), '-e', 'kayra_root=' + str(frozen), '-e', 'volume_node_image=' + image, '-e', 'report_path=' + str(report / 'result.json'), '-e', 'platform_input_probe=' + ('true' if args.platform_inputs else 'false'), '-e', 'declared_image_probe=' + ('true' if args.image_admission else 'false')], env=env)
    if not args.keep:
        run(['multipass', 'delete', '--purge', vm])
        shutil.rmtree(work)
    succeeded = True
    print(json.dumps({'passed': True, 'vm': vm, 'kept': args.keep, 'output': str(report)}))
finally:
    log.close()
    for path in report.rglob('*'):
        if path.is_file():
            path.chmod(0o600)
    awake.terminate()
    awake.wait()
    if not succeeded or args.keep:
        print(json.dumps({'vmPreserved': vm, 'workspace': str(work), 'output': str(report), 'cleanup': ['multipass', 'delete', '--purge', vm]}))
