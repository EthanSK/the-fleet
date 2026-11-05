#!/usr/bin/env python3
"""Publish the exact CI archive through Developer ID, Apple and Sparkle gates.
Private keys and notarization credentials remain in the signing Mac's Keychain.
"""
import hashlib,json,os,pathlib,plistlib,re,shutil,subprocess,sys,tempfile,xml.etree.ElementTree as ET
root=pathlib.Path(__file__).resolve().parent.parent
os.chdir(root)
c=json.loads((root/'release-config.json').read_text())
def run(*args,**kw):
    return subprocess.run([str(x) for x in args],check=True,**kw)
def output(*args):
    return subprocess.check_output([str(x) for x in args],text=True).strip()
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
source=pathlib.Path(sys.argv[1]).resolve()
receipt=json.loads((source/'build-receipt.json').read_text())
commit=output('git','rev-parse','HEAD')
assert receipt['commit']==commit, 'CI artifact belongs to a different commit'
assert receipt['archive']==pathlib.Path(c['prebuilt']).name
archive=source/receipt['archive']
assert sha(archive)==receipt['sha256'], 'CI archive hash differs'
identity=os.environ['CODE_SIGN_IDENTITY']
assert identity.startswith('Developer ID Application: ')
if c['version']=='files':
    version=(root/'VERSION').read_text().strip(); build=(root/'BUILD_NUMBER').read_text().strip()
else:
    version=json.loads((root/'package.json').read_text())['version']; build=version
assert re.fullmatch(r'\d+\.\d+\.\d+',version)
tag=f'v{version}-build.{build}' if c['version']=='files' else f'v{version}'
env=os.environ.copy(); env.pop('GH_TOKEN',None); env.pop('GITHUB_TOKEN',None)
assert subprocess.check_output(['gh','api','--hostname','github.com','user','--jq','.login'],env=env,text=True).strip()=='EthanSK'
if subprocess.run(['gh','release','view',tag,'--repo',f'EthanSK/{c["repo"]}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
    raise SystemExit('Release already exists; refusing to replace published update bytes.')
work=pathlib.Path(os.environ['RUNNER_TEMP'])/'signed-app.noindex'
work.mkdir(exist_ok=False)
run('ditto','-xk',archive,work)
app=work/f'{c["app"]}.app'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
expected=plistlib.loads((root/c['plist']).read_bytes())
assert info['CFBundleShortVersionString']==version and info['CFBundleVersion']==build
for key in ('SUPublicEDKey','SUFeedURL'):
    assert info[key]==expected[key]
assert info['CFBundleIdentifier']==c['account']
framework=app/'Contents/Frameworks/Sparkle.framework'
for component in ('Versions/B/Autoupdate','Versions/B/Updater.app','Versions/B/XPCServices/Downloader.xpc','Versions/B/XPCServices/Installer.xpc','.'):
    run('codesign','--force','--options','runtime','--timestamp','--sign',identity,framework/component)
run('codesign','--force','--options','runtime','--timestamp','--sign',identity,app)
exe=app/'Contents/MacOS'/c['exe']
for arch in ('arm64','x86_64'): run('lipo',exe,'-verify_arch',arch)
def verify(bundle,stapled=False):
    run('codesign','--verify','--deep','--strict',bundle)
    value=json.loads(output(bundle/'Contents/MacOS'/c['exe'],'--check-packaged-launch'))
    assert value['packagedLaunch']=='ok' and value['version']==version and value['build']==build
    if stapled:
        run('xcrun','stapler','validate',bundle)
        run('spctl','--assess','--type','execute','--verbose=2',bundle)
verify(app)
submission=work/'notary-submission.zip'
run('ditto','-c','-k','--keepParent',app,submission)
notary=json.loads(output('xcrun','notarytool','submit',submission,'--keychain-profile',os.environ.get('NOTARY_PROFILE','AgentFlowRelease'),'--wait','--timeout','30m','--output-format','json'))
assert notary['status']=='Accepted', notary
run('xcrun','stapler','staple',app)
verify(app,True)
out=work/'release'; out.mkdir()
final=out/c['download']
run('ditto','-c','-k','--keepParent',app,final)
# The Fleet's download retains the complete licensing scope beside the app.
if c['repo']=='the-fleet':
    import zipfile
    with zipfile.ZipFile(final,'a',compression=zipfile.ZIP_DEFLATED) as z:
        for name in ('LICENSE','LICENSING.md'): z.write(root/name,name)
verify_dir=work/'verify'; verify_dir.mkdir()
run('ditto','-xk',final,verify_dir)
verify(verify_dir/app.name,True)
tools=pathlib.Path(os.environ['SPARKLE_TOOLS'])
assert output(tools/'generate_keys','--account',c['account'],'-p')==info['SUPublicEDKey']
run(tools/'generate_appcast','--account',c['account'],'--maximum-deltas','0','--download-url-prefix',f'https://github.com/EthanSK/{c["repo"]}/releases/download/{tag}/','-o',out/'appcast.xml',out)
ns='{http://www.andymatuschak.org/xml-namespaces/sparkle}'
enclosures=ET.parse(out/'appcast.xml').findall('./channel/item/enclosure')
assert len(enclosures)==1 and enclosures[0].attrib[ns+'edSignature']
assert enclosures[0].attrib['url'].endswith('/'+final.name)
(out/'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in (final,out/'appcast.xml')))
(out/'notarization.json').write_text(json.dumps(notary,indent=2)+'\n')
(out/'release.json').write_text(json.dumps(dict(commit=commit,version=version,build=build,archive=final.name,sha256=sha(final),architectures=['arm64','x86_64'],notarized=True,stapled=True),indent=2)+'\n')
repo=f'EthanSK/{c["repo"]}'
run('gh','release','create',tag,'--repo',repo,'--draft','--target',commit,'--title',f'{c["app"]} {version}','--generate-notes',*[str(p) for p in sorted(out.iterdir())],env=env)
run('gh','release','edit',tag,'--repo',repo,'--draft=false','--latest',env=env)
public=work/'public'; public.mkdir()
run('gh','release','download',tag,'--repo',repo,'--dir',public,env=env)
for p in (final,out/'appcast.xml',out/'release.json'):
    assert sha(p)==sha(public/p.name), 'Public bytes differ from verified release'
run('shasum','-a','256','-c','SHA256SUMS',cwd=public)
print(f'Published verified signed update: https://github.com/{repo}/releases/tag/{tag}')
