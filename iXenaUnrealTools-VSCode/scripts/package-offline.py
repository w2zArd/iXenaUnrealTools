#!/usr/bin/env python3
"""Build a VSCode VSIX from already compiled JS without downloading npm packages.

For a standard release, prefer `npm ci && npm run package` using the official VSCE.
This fallback includes only shipped runtime files and jsonc-parser (MIT licensed).
"""
import argparse
import json
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent

def manifest(pkg):
    version = escape(pkg['version'])
    ident = escape(pkg['name'])
    publisher = escape(pkg['publisher'])
    display = escape(pkg['displayName'])
    catalog = json.loads((ROOT / 'package.nls.json').read_text(encoding='utf8'))
    description = escape(catalog.get(pkg['description'].strip('%'), pkg['description']))
    tags = escape(','.join(pkg.get('keywords', [])))
    cats = escape(','.join(pkg.get('categories', [])))
    engine = escape(pkg['engines']['vscode'])
    kind = escape(','.join(pkg.get('extensionKind', ['workspace'])))
    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{ident}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Tags>{tags}</Tags>
    <Categories>{cats}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value={quoteattr(engine)} />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value={quoteattr(kind)} />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="en-US,zh-CN" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>'''

def content_types():
    entries = {
        '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json',
        '.md': 'text/markdown', '.ps1': 'text/plain', '.svg': 'image/svg+xml',
        '.txt': 'text/plain', '.vsixmanifest': 'text/xml',
    }
    mapped = ''.join(f'<Default Extension="{suffix}" ContentType="{kind}"/>' for suffix, kind in entries.items())
    return f'<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{mapped}</Types>'

def package(output: Path):
    pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf8'))
    required = ['extension', 'buildLogs', 'dependencyEditor', 'descriptorEditor',
                'descriptorModel', 'sourceSwitcher', 'sourcePairModel', 'liveCoding', 'editorCommunication',
                'editorBridge', 'bridgeInstallation', 'connectionSetup', 'i18n', 'webviewI18n', 'performanceMonitor', 'unrealMcp', 'classWizard', 'ueConsole']
    for item in required:
        if not (ROOT / 'dist' / (item + '.js')).is_file():
            raise SystemExit(f'missing compiled file: dist/{item}.js')
    if not (ROOT / 'node_modules/jsonc-parser/package.json').is_file():
        raise SystemExit('missing jsonc-parser runtime; run npm ci first')
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr('extension.vsixmanifest', manifest(pkg))
        archive.writestr('[Content_Types].xml', content_types())
        for src, dst in [
            ('package.json', 'package.json'), ('README.md', 'readme.md'),
            ('CHANGELOG.md', 'changelog.md'), ('LICENSE', 'LICENSE.txt')
        ]:
            archive.write(ROOT / src, 'extension/' + dst)
        for src in ROOT.glob('package.nls*.json'):
            archive.write(src, 'extension/' + src.name)
        for src in (ROOT / 'dist').rglob('*.js'):
            archive.write(src, 'extension/dist/' + src.relative_to(ROOT / 'dist').as_posix())
        for src in (ROOT / 'resources').rglob('*'):
            if src.is_file():
                archive.write(src, 'extension/resources/' + src.relative_to(ROOT / 'resources').as_posix())
        for src in (ROOT / 'node_modules/jsonc-parser').rglob('*'):
            if src.is_file() and '/src/' not in src.as_posix() and '/esm/' not in src.as_posix():
                archive.write(src, 'extension/node_modules/jsonc-parser/' +
                              src.relative_to(ROOT / 'node_modules/jsonc-parser').as_posix())
    print(f'Created {output} ({output.stat().st_size:,} bytes)')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, help='output .vsix path', default=None)
    args = parser.parse_args()
    package(args.output or ROOT / 'ixena-unreal-tools-0.6.2.vsix')
