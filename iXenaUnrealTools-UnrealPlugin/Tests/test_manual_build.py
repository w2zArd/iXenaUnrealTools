"""Run with Python 3; fake UAT verifies script orchestration, not a UE C++ build."""
from pathlib import Path
import json
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'Tools/Build-Plugin.sh'

class ManualBuildTests(unittest.TestCase):
    def make_engine(self, root, mode='success'):
        engine = root / 'UE 测试引擎'
        batch = engine / 'Engine/Build/BatchFiles'
        batch.mkdir(parents=True)
        (engine / 'Engine/Build/Build.version').write_text('{"MajorVersion":5,"MinorVersion":9}')
        body = '''#!/bin/bash
set -eu
printf 'FAKE_UAT_STARTED\\n'
[[ "$1" == BuildPlugin ]]
for arg in "$@"; do
  case "$arg" in -Package=*) out="${arg#-Package=}";; -Plugin=*) plugin="${arg#-Plugin=}";; -TargetPlatforms=*) host="${arg#-TargetPlatforms=}";; esac
done
'''
        if mode == 'failure':
            body += 'exit 7\n'
        elif mode == 'missing':
            body += 'mkdir -p "$out"\nexit 0\n'
        else:
            body += '''mkdir -p "$out/Binaries/$host"
cp "$plugin" "$out/iXenaUnrealBridge.uplugin"
mkdir -p "$out/Resources"
cp "$(dirname "$plugin")/Resources/ConsoleHelp.zh-CN.json" "$out/Resources/ConsoleHelp.zh-CN.json"
printf '{"BuildId":"test","Modules":{"iXenaUnrealBridge":"fake"}}' > "$out/Binaries/$host/UnrealEditor.modules"
printf 'fake binary' > "$out/Binaries/$host/libUnrealEditor-iXenaUnrealBridge.so"
printf 'symbol' > "$out/Binaries/$host/test.pdb"
'''
        (batch / 'RunUAT.sh').write_text(body)
        return engine

    def run_build(self, engine, package, *more):
        return subprocess.run(['bash', str(SCRIPT), '--engine', str(engine), '--package', str(package), '--language', 'en', *more], text=True, capture_output=True)

    def test_live_build_checks_package_and_removes_symbols_without_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); engine = self.make_engine(root); package = root/'Output 空格'
            result = self.run_build(engine, package)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            self.assertIn('FAKE_UAT_STARTED', result.stdout)
            self.assertIn('This script did not install it', result.stdout)
            self.assertTrue((package/'iXenaUnrealBridge.uplugin').is_file())
            self.assertTrue((package/'Resources/ConsoleHelp.zh-CN.json').is_file())
            self.assertFalse(any(package.rglob('*.pdb')))
            self.assertFalse((engine/'Engine/Plugins').exists())

    def test_keep_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); engine=self.make_engine(root); package=root/'Output'
            result=self.run_build(engine,package,'--keep-symbols')
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertTrue(any(package.rglob('*.pdb')))

    def test_failure_retains_uat_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); engine=self.make_engine(root,'failure')
            result=self.run_build(engine,root/'Output')
            self.assertEqual(result.returncode,7)
            self.assertNotIn('Build succeeded',result.stdout)

    def test_success_without_artifacts_is_not_reported_successful(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); engine=self.make_engine(root,'missing')
            result=self.run_build(engine,root/'Output')
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('Build succeeded',result.stdout)

    def test_nonempty_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); engine=self.make_engine(root); package=root/'Output';package.mkdir()
            marker=package/'keep.txt';marker.write_text('preserve')
            result=self.run_build(engine,package)
            self.assertEqual(result.returncode,2)
            self.assertEqual(marker.read_text(),'preserve')
            self.assertNotIn('FAKE_UAT_STARTED',result.stdout)

    def test_output_inside_engine_and_symlink_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);engine=self.make_engine(root)
            self.assertEqual(self.run_build(engine,engine/'Output').returncode,2)
            existing=root/'existing';existing.mkdir();link=root/'alias';link.symlink_to(existing,target_is_directory=True)
            self.assertEqual(self.run_build(engine,link).returncode,2)

    def test_user_reported_logpath_shadowing_regression(self):
        cpp=(ROOT/'iXenaUnrealBridge/Source/iXenaUnrealBridge/Private/iXenaUnrealBridgeModule.cpp').read_text()
        # UE declares a global LogPath log category; locals/parameters must not shadow it under /WX.
        self.assertNotRegex(cpp,r'\b(?:FString|TCHAR|auto)\s*(?:[&*]\s*)?\bLogPath\b')
        self.assertIn('explicit FCompileOutput(const FString& InCompileLogPath)',cpp)
        self.assertIn('CreateFileWriter(*InCompileLogPath,',cpp)

    def test_plugin_category_and_language_scope(self):
        descriptor=json.loads((ROOT/'iXenaUnrealBridge/iXenaUnrealBridge.uplugin').read_text())
        self.assertEqual(descriptor['Category'],'iXena')
        self.assertEqual(descriptor['VersionName'],'0.6.2')
        locale=(ROOT/'iXenaUnrealBridge/Source/iXenaUnrealBridge/Private/iXenaBridgeLocalization.cpp').read_text()
        self.assertIn('GetCurrentLanguage()',locale)
        self.assertIn('GEditorPerProjectIni',locale)
        self.assertNotIn('SetCurrentCulture',locale)
        self.assertNotIn('SetCurrentLanguage',locale)

if __name__ == '__main__':
    unittest.main()
