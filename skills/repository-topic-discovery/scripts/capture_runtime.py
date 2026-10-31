"""Capture a reconstructed Codex request on loopback; never forward or invoke a model.

The local endpoint returns HTTP 400 deliberately. Provider settings apply only
to this subprocess. Authorization header values are never read or persisted.
Historical snapshots and the user's configuration remain untouched.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from runtime_profile import WEB_STAGES


def audit_request(request, stage, prompt_text):
    """Inspect the actual wire surface, without echoing prompts or settings."""
    tool_names = set()
    nested_names = set()
    tool_chars = 0

    def inspect_tools(items, namespace=''):
        for item in items:
            name = item.get('name', item.get('type', 'unknown'))
            qualified = '.'.join(filter(None, (namespace, name)))
            if item.get('type') == 'namespace':
                inspect_tools(item.get('tools', []), qualified)
            else:
                tool_names.add(qualified)
                nested_names.update(re.findall(
                    r'declare const tools:\s*\{\s*(\w+)\s*\(',
                    item.get('description', '')))

    def message_text(item):
        content = item.get('content', [])
        if isinstance(content, str):
            return content
        return '\n'.join(part.get('text', '') for part in content
                         if isinstance(part, dict))

    direct_tools = request.get('tools', [])
    inspect_tools(direct_tools)
    tool_chars += len(json.dumps(direct_tools, ensure_ascii=False)) if direct_tools else 0
    injected_text = [request.get('instructions', '')]
    prompt_present = False
    for item in request.get('input', []):
        if item.get('type') == 'additional_tools':
            inspect_tools(item.get('tools', []))
            tool_chars += len(json.dumps(item.get('tools', []), ensure_ascii=False))
        else:
            text = message_text(item)
            if item.get('role') == 'user' and text.strip() == prompt_text.strip():
                prompt_present = True
            else:
                injected_text.append(text)
    injected_text = '\n'.join(injected_text)
    markers = {
        'memory': ['## Memory', 'MEMORY_SUMMARY BEGINS', '<memory'],
        'skills': ['## Skills', '### Available skills', '<skills_instructions>'],
        'collaboration': ['<collaboration_mode>', '<multi_agent_role>', '<multi_agent_mode>'],
        'apps': ['<app-context>', '<apps_instructions>', '<recommended_plugins>'],
    }
    unexpected_blocks = [name for name, values in markers.items()
                         if any(value in injected_text for value in values)]
    fixed_wrappers = {'functions.exec', 'functions.wait'}
    permitted_web_tools = {'web__run', 'web.run', 'web_search', 'web_search_preview'}
    exposed_tools = (tool_names - fixed_wrappers) | nested_names
    expected_web = stage in WEB_STAGES
    allowed = permitted_web_tools if expected_web else set()
    unexpected_tools = sorted(exposed_tools - allowed)
    web_present = bool(exposed_tools & permitted_web_tools)
    permissions_present = '<permissions instructions>' in injected_text
    failures = []
    if unexpected_tools:
        failures.append('unexpected_tools')
    if unexpected_blocks:
        failures.append('unexpected_context_blocks')
    if web_present != expected_web:
        failures.append('web_surface_mismatch')
    if not permissions_present:
        failures.append('missing_permissions_instructions')
    if not prompt_present:
        failures.append('supplied_prompt_not_found')
    return {
        'stage': stage, 'passed': not failures, 'failures': failures,
        'fixed_wrapper_tools': sorted(tool_names & fixed_wrappers),
        'exposed_tools': sorted(exposed_tools),
        'unexpected_tools': unexpected_tools,
        'unexpected_context_blocks': unexpected_blocks,
        'web_expected': expected_web, 'web_declared': web_present,
        'web_execution_verified': False,
        'permissions_instructions_present': permissions_present,
        'supplied_prompt_preserved': prompt_present,
        'serialized_tool_chars': tool_chars,
        'token_usage': 'unknown: local capture rejects before model execution',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompt', required=True, type=Path)
    parser.add_argument('--schema', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('--stage', choices=['research','propose','review','repair','review_final'], required=True)
    parser.add_argument('--fail-on-unexpected', action='store_true',
                        help='Exit nonzero if a captured request fails the stage surface audit')
    args = parser.parse_args()
    prompt_text = args.prompt.read_text()
    json.loads(args.schema.read_text())
    args.output.mkdir(parents=True, exist_ok=False)
    captures = []
    audits = []

    class Capture(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            encoding = self.headers.get('Content-Encoding', '')
            if encoding == 'gzip':
                body = gzip.decompress(body)
            number = len(captures)
            p = args.output / f'request-{number}.json'
            try:
                data = json.loads(body)
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
                os.chmod(p, 0o600)
                audit = audit_request(data, args.stage, prompt_text)
                (args.output / f'request-{number}-audit.json').write_text(
                    json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
                audits.append(audit)
                parsed = True
            except Exception:
                p = args.output / f'request-{number}.body'
                p.write_bytes(body)
                os.chmod(p, 0o600)
                parsed = False
            captures.append({'path': self.path, 'bytes': len(body),
                             'encoding': encoding, 'json': parsed,
                             'header_names_only': sorted(self.headers.keys())})
            response = json.dumps({'error': {'message': 'Local diagnostic capture complete; no model was called.',
                                            'type': 'invalid_request_error', 'code': 'audit_capture_only'}}).encode()
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def do_GET(self):
            self.send_response(404)
            self.end_headers()

    server = HTTPServer(('127.0.0.1', 0), Capture)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    start = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix='topic-wire-audit-') as cwd:
            overrides = {
                'model_provider': 'local_token_audit',
                'model_providers.local_token_audit.name': 'Local capture only, no model',
                'model_providers.local_token_audit.base_url': f'http://127.0.0.1:{server.server_port}/v1',
                'model_providers.local_token_audit.wire_api': 'responses',
                'model_providers.local_token_audit.requires_openai_auth': False,
                'model_providers.local_token_audit.supports_websockets': False,
                'model_providers.local_token_audit.supports_standalone_web_search': True,
                'model_providers.local_token_audit.capabilities.external_web_access': True,
                'model_providers.local_token_audit.request_max_retries': 0,
                'model_providers.local_token_audit.stream_max_retries': 0,
            }
            from runtime_profile import build_runtime_args
            command = ['codex', '--no-daemon', '-a', 'never'] + build_runtime_args(args.stage)
            for key, value in overrides.items():
                command += ['-c', key + '=' + json.dumps(value)]
            command += ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
                        '--json', '--color', 'never', '--output-schema', str(args.schema.resolve()),
                        '-C', cwd, '-']
            (args.output / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
            with (args.output / 'events.jsonl').open('w') as out, (args.output / 'stderr.txt').open('w') as err:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                           text=True, start_new_session=True)
                try:
                    process.communicate(prompt_text, timeout=args.timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
            result = {'reconstruction_not_historical': True, 'model_called': False,
                      'endpoint': 'loopback only, rejects every request, no forwarding',
                      'exit_code': process.returncode, 'wall_seconds': time.monotonic()-start,
                      'captures': captures,
                      'audit_passed': bool(audits) and len(audits) == len(captures)
                                      and all(audit['passed'] for audit in audits),
                      'audits': audits}
            (args.output / 'capture-meta.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result))
    finally:
        server.shutdown()
        server.server_close()
    if args.fail_on_unexpected and not result['audit_passed']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
