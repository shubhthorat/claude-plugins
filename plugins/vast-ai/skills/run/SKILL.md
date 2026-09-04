---
description: Run a command on the active Vast.ai GPU instance via SSH
user-invocable: true
---

# Run on Vast.ai

Run a command or script on the current running Vast.ai GPU instance.

## Workflow

1. Call `vast_list_instances` to get the running instance ID and confirm SSH is ready
2. Call `vast_run_command` with the instance ID and command
   - The `/venv/main` Python env is auto-activated (PyTorch, transformers, etc.)
3. For multi-line scripts use `vast_run_script` instead

## Arguments

If the user provides text after the skill, treat it as the command to run on the active instance.

## Examples

GPU smoke test:
```
vast_run_command(instance_id=..., command="python3 -c 'import torch; print(torch.cuda.get_device_name(0))'")
```

Run exam scripts:
```
vast_run_script(instance_id=..., script="cd /workspace/takehome && python3 src/mnist_distill.py --method teacher --epochs 5 --seed 0")
```
