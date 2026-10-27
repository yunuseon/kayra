# Worker and singleton experiment — measurement pending

Implemented the six-scenario worker/singleton harness in the follow-up to the
HTTP and migration experiments. **No valid worker matrix has completed.**
The existing HTTP and migration findings are unchanged.

Two attempts on 2026-10-27 were invalidated by host suspension:

| Run | Source | Stage reached | Finding |
|---|---|---|---|
| `20261027t000541010` | `4f6039627271fc5e4163ad0a0f8bdf9f0d4aa74b` | Dependency/image setup | Build timed out during repeated host sleep/wake cycles; no worker cases ran |
| `20261027t064306748` | `d8d80e5` | Singleton baseline | Baseline tick continuity rejected; no worker cases ran |

The second baseline recorded 255 ticks spanning approximately 35.87 seconds,
with interrupted cadence. The macOS power log showed repeated sleep/wake
cycles. A subsequent host check reported `AppleClamshellState = Yes` and battery
power. An idle-sleep assertion (`caffeinate -i`) did not prevent lid-close sleep.
Neither run is evidence for or against Swarm worker feasibility.

Raw artifacts are under `.cache/swarm-worker-lab/<run>/`. Both diagnostic VMs
were stopped and preserved; the existing `test` VM and host OrbStack Docker
context were not changed. Cleanup, when the evidence is no longer needed:

```bash
multipass delete --purge kayra-swarm-lab-20261027t000541010
multipass delete --purge kayra-swarm-lab-20261027t064306748
```

The harness and assessment have 31 focused tests passing across the HTTP,
migration and worker suites. They check missing acknowledged effects, effect
multiplicity, real redelivery to a different task, singleton exclusion versus
concurrent work, interrupted baselines and incomplete matrices. These tests
validate evidence handling; they do not replace real VM measurements.

To resume, keep the Mac awake with its lid open, preferably on power, then run:

```bash
bash test/lab/swarm/run.sh --suite workers --repeats 1
# After the smoke run succeeds:
bash test/lab/swarm/run.sh --suite workers
```

The full experiment requires all six cases repeated three times. Its final
report must distinguish positive application protocol results from the two
unsafe negative controls. See [the experiment README](README.md) for criteria,
artifacts and limits. No production integration decision follows until that
matrix completes without host suspension.
