# Run command on Vast.ai instance

Run a command on the current active Vast.ai instance.

## Workflow

1. Call `vast_list_instances` to find the running instance ID and confirm it's ready (status=running, ssh_cmd present)
2. Call `vast_run_command` with the instance ID and your command
3. The venv at `/venv/main` is auto-activated (PyTorch, transformers, etc. available)

## Arguments

If the user provides text after the skill invocation, treat it as the command to run.

## Examples

Run a GPU check:
```
vast_run_command(instance_id=..., command="python3 -c 'import torch; print(torch.cuda.get_device_name(0))'")
```

Run a script file that exists on the instance:
```
vast_run_script(instance_id=..., script="cd /workspace/takehome && python3 src/mnist_distill.py --method teacher --epochs 5 --seed 0")
```
