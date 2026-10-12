#!/usr/bin/env python3
"""Fetch the pinned assets. A removed upstream version fails rather than silently updating."""
import concurrent.futures, hashlib, json, pathlib, re, subprocess, tempfile, shutil
root = pathlib.Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'desktop/snapshot.json').read_text())
target = root / 'photopea.com'
if target.exists():
    raise SystemExit('photopea.com already exists; move it aside before downloading a new snapshot.')
staging = pathlib.Path(tempfile.mkdtemp(prefix='photopea-snapshot-', dir=root))
def fetch(item):
    name, expected = item
    out = staging / name
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--retry', '2', '--max-time', '90', 'https://www.photopea.com/' + name, '-o', str(out)], check=True)
    if name.startswith('code/pp/'):
        source = out.read_text()
        source, n = re.subn(r'\|\|[\w$]+\.[\w$]+\(\)==[\w$]+\.a6\("YMVVHAj=FA"\);', '||true;/* desktop:full-width */', source)
        if n != 1: raise RuntimeError('Editor layout anchor changed')
        out.write_text(source)
    if hashlib.sha256(out.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Asset changed: ' + name + '. Recover the pinned snapshot from the release app instead.')
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch, manifest['files'].items()))
    staging.rename(target)
    print('Downloaded and verified', len(manifest['files']), 'assets')
finally:
    if staging.exists(): shutil.rmtree(staging)
