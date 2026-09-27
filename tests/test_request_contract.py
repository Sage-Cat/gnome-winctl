from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gnome_winctl import cli, client


class RequestContractTests(unittest.TestCase):
    def test_monitor_zero_is_not_replaced_by_primary(self):
        args = cli.parser().parse_args(['place', '1', '--monitor', '0', '--workspace', '0', '--geometry', '0,0,10,10'])
        self.assertEqual(cli._target(args)['monitor'], 0)

    def test_wait_requires_verified_completion_across_all_active_states(self):
        states = [{'status': state, 'placed': state == 'verified'}
                  for state in ('accepted', 'deferred', 'applied', 'verified')]
        with patch.object(client, 'expectation_status', side_effect=states) as status, patch.object(client.time, 'sleep'):
            self.assertEqual(client.wait_for_expectation('one')['status'], 'verified')
        self.assertEqual(status.call_count, 4)

    def test_legacy_deferred_placed_never_becomes_success_at_timeout(self):
        with patch.object(client, 'expectation_status', return_value={'status': 'placed', 'placed': True, 'deferred': True}), \
             patch.object(client.time, 'monotonic', side_effect=[0, 0, 0, 2]), patch.object(client.time, 'sleep'):
            result = client.wait_for_expectation('one', timeout=1)
        self.assertEqual(result['status'], 'deferred')
        self.assertFalse(result['placed'])
        self.assertTrue(result['wait_timed_out'])

    def test_terminal_replay_error_returns_immediately(self):
        with patch.object(client, 'expectation_status', return_value={'status': 'failed', 'message': 'replay rejected'}), patch.object(client.time, 'sleep') as sleep:
            self.assertEqual(client.wait_for_expectation('one')['message'], 'replay rejected')
        sleep.assert_not_called()

    def test_place_exit_code_distinguishes_acceptance_and_requested_verification(self):
        arguments = ['place', '1', '--target-json', '{}']
        result = {'token': 'one', 'status': 'deferred', 'placed': False}
        with patch.object(cli, 'place_window', return_value=result), patch.object(cli, '_print'), \
             patch.object(cli, 'wait_for_expectation', return_value=result):
            self.assertEqual(cli.main(arguments), 0)
            self.assertEqual(cli.main(arguments + ['--wait']), 1)


class LegacyInstallerTests(unittest.TestCase):
    def test_real_directory_is_preserved_and_replaced_with_exact_symlink(self):
        spec = importlib.util.spec_from_file_location('stub_installer', Path(__file__).resolve().parents[1] / 'scripts/install_legacy_stub.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            destination = root / 'extensions/old-uuid'
            destination.mkdir(parents=True)
            (destination / 'user-file').write_text('preserve me')
            installer.install(source, destination)
            self.assertTrue(destination.is_symlink())
            self.assertEqual(destination.resolve(), source)
            backups = list(destination.parent.glob('old-uuid.pre-symlink-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / 'user-file').read_text(), 'preserve me')
            installer.install(source, destination)
            self.assertEqual(len(list(destination.parent.glob('old-uuid.pre-symlink-*'))), 1)

    def test_symlink_failure_rolls_back_directory_migration(self):
        spec = importlib.util.spec_from_file_location('stub_installer', Path(__file__).resolve().parents[1] / 'scripts/install_legacy_stub.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / 'source', root / 'old-uuid'
            source.mkdir()
            destination.mkdir()
            (destination / 'user-file').write_text('preserve me')
            with patch.object(installer.os, 'replace', side_effect=OSError('simulated failure')):
                with self.assertRaises(OSError):
                    installer.install(source, destination)
            self.assertFalse(destination.is_symlink())
            self.assertEqual((destination / 'user-file').read_text(), 'preserve me')


if __name__ == '__main__':
    unittest.main()
