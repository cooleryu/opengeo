"""Regression checks for audits of the model-visible request, not config flags."""
import copy
import unittest

from capture_runtime import audit_request


def request_with(nested_tools=(), prompt='Supplied evidence package'):
    declarations = '\n'.join(
        'declare const tools: { ' + name + '(args: {}): Promise<unknown>; };'
        for name in nested_tools)
    return {
        'input': [
            {'role': 'developer', 'type': 'additional_tools', 'tools': [
                {'type': 'namespace', 'name': 'functions', 'tools': [
                    {'type': 'custom', 'name': 'exec', 'description':
                     'Example only: await tools.exec_command({})\n' + declarations},
                    {'type': 'function', 'name': 'wait', 'description': 'Wait'},
                ]},
            ]},
            {'role': 'developer', 'type': 'message', 'content': [
                {'type': 'input_text', 'text': '<permissions instructions>read-only</permissions instructions>'},
            ]},
            {'role': 'user', 'type': 'message', 'content': [{'type': 'input_text', 'text': prompt}]},
        ],
    }


class RequestSurfaceTests(unittest.TestCase):
    def test_wrapper_examples_are_not_exposed_terminal_tools(self):
        audit = audit_request(request_with(), 'propose', 'Supplied evidence package')
        self.assertTrue(audit['passed'])
        self.assertEqual(audit['fixed_wrapper_tools'], ['functions.exec', 'functions.wait'])
        self.assertEqual(audit['exposed_tools'], [])

    def test_nested_shell_app_and_delegation_tools_fail_audit(self):
        tools = ['exec_command', 'mcp__codex_app__create_thread', 'spawn_agent']
        audit = audit_request(request_with(tools), 'propose', 'Supplied evidence package')
        self.assertFalse(audit['passed'])
        self.assertEqual(audit['unexpected_tools'], sorted(tools))

    def test_web_is_required_only_in_web_stages(self):
        for stage in ['research', 'review', 'review_final']:
            with self.subTest(stage=stage):
                self.assertTrue(audit_request(request_with(['web__run']), stage,
                                             'Supplied evidence package')['passed'])
                self.assertIn('web_surface_mismatch', audit_request(request_with(), stage,
                              'Supplied evidence package')['failures'])
        for stage in ['propose', 'repair']:
            with self.subTest(stage=stage):
                self.assertFalse(audit_request(request_with(['web__run']), stage,
                                              'Supplied evidence package')['passed'])

    def test_injected_catalogs_fail_but_quoted_task_material_does_not(self):
        for marker in ['## Memory', '<skills_instructions>', '<collaboration_mode>', '<apps_instructions>']:
            with self.subTest(marker=marker):
                task = 'Review a document containing ' + marker
                request = request_with(prompt=task)
                self.assertTrue(audit_request(request, 'repair', task)['passed'])
                request['input'].insert(1, {'role': 'developer', 'type': 'message', 'content': marker})
                self.assertIn('unexpected_context_blocks',
                              audit_request(request, 'repair', task)['failures'])

    def test_missing_permissions_or_changed_prompt_fails(self):
        request = request_with()
        request['input'].pop(1)
        self.assertIn('missing_permissions_instructions',
                      audit_request(request, 'propose', 'Supplied evidence package')['failures'])
        self.assertIn('supplied_prompt_not_found',
                      audit_request(request_with(), 'propose', 'Changed prompt')['failures'])

    def test_direct_tool_surface_cannot_bypass_audit(self):
        request = copy.deepcopy(request_with())
        request['tools'] = [{'type': 'function', 'name': 'browser_use', 'description': ''}]
        self.assertEqual(audit_request(request, 'propose', 'Supplied evidence package')
                         ['unexpected_tools'], ['browser_use'])


if __name__ == '__main__':
    unittest.main()
