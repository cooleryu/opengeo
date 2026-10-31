"""Process-scoped minimum-capability runtime; never changes user config.

The base instructions specialize a research workflow, while managed permissions,
sandbox restrictions, source-integrity and explicit authorization remain in force.
Model, reasoning, provider/auth settings are inherited unchanged.
"""
import json
from pathlib import Path

PROFILE_VERSION = "topic-lean-v2"
WEB_STAGES = {"research", "review", "review_final"}

def runtime_overrides(stage):
    if stage not in WEB_STAGES | {"propose", "repair"}:
        raise ValueError("Unknown workflow stage: " + stage)
    values = {
        "model_instructions_file": str(Path(__file__).with_name("runtime_instructions.md").resolve()),
        "memories.use_memories": False,
        "skills.include_instructions": False,
        "skills.bundled.enabled": False,
        "web_search": "live" if stage in WEB_STAGES else "disabled",
        "personality": "none",
        "features.code_mode_host": True,
        # Web tools need this transport. Exclude unused built-ins from its
        # nested surface; the CLI's outer exec/wait wrapper remains present.
        "features.code_mode.enabled": True,
        "features.code_mode.excluded_tool_namespaces": ["functions", "clock"],
        "agents.enabled": False,
        "tools.experimental_request_user_input.enabled": False,
        "tools.update_plan.enabled": False,
        "include_collaboration_mode_instructions": False,
        "include_apps_instructions": False,
    }
    # No shell/browser/app/delegation surface is required to read public sources
    # with web search or to transform a supplied, traceable evidence package.
    for name in (
        "memories", "apps", "plugins", "shell_tool", "browser_use",
        "browser_use_external", "computer_use", "multi_agent", "multi_agent_v2",
        "chronicle", "skill_search", "sleep_tool", "view_image",
        "workspace_dependencies", "request_permissions_tool", "goals", "tool_suggest",
    ):
        values["features." + name] = False
    return values

def build_runtime_args(stage):
    args = []
    for key, value in runtime_overrides(stage).items():
        args.extend(["-c", key + "=" + json.dumps(value, ensure_ascii=False)])
    return args
