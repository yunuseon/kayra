#!/usr/bin/env python3
import json
import subprocess
import time
from pathlib import Path

previous = None
while True:
    memory = {
        line.split(':')[0]: int(line.split()[1]) * 1024
        for line in Path('/proc/meminfo').read_text().splitlines()
    }
    cpu = [int(value) for value in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    total, idle = sum(cpu), cpu[3] + cpu[4]
    busy = None if previous is None else 1 - (idle - previous[1]) / max(1, total - previous[0])
    previous = total, idle
    print(json.dumps({
        'at': int(time.time() * 1000), 'kind': 'vm',
        'memoryTotalBytes': memory['MemTotal'], 'memoryAvailableBytes': memory['MemAvailable'],
        'cpuBusyFraction': busy,
    }), flush=True)
    try:
        result = subprocess.run(
            ['docker', 'stats', '--no-stream', '--format', '{{json .}}'],
            capture_output=True, text=True, timeout=8, check=True,
        )
        for line in result.stdout.splitlines():
            print(json.dumps({'at': int(time.time() * 1000), 'kind': 'container', **json.loads(line)}), flush=True)
    except (subprocess.SubprocessError, ValueError) as error:
        print(json.dumps({'at': int(time.time() * 1000), 'kind': 'sampling-error', 'error': str(error)}), flush=True)
    time.sleep(2)
