"""Verify Stage14 documentation links, source manifest and route coverage. No network."""
import hashlib,json,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
docs=root/'docs/tahap-14'
errors=[];checked=0
for f in [root/'README.md',root/'docs/STATUS-PENERIMAAN.md',*sorted(docs.glob('*.md'))]:
 for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',f.read_text()):
  if '://' in link or link.startswith('#'):continue
  target=link.split('#',1)[0]
  if not (f.parent/target).exists():errors.append(str(f.relative_to(root))+': broken '+link)
  checked+=1
catalog=json.loads((docs/'route-catalog.json').read_text())['routes']
actual={str(f.relative_to(root)):re.findall(r'export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b',f.read_text()) for f in (root/'src/app/api').rglob('route.ts')}
if len(catalog)!=len(actual) or {x['source'] for x in catalog}!=set(actual):errors.append('Route coverage mismatch')
for x in catalog:
 if actual.get(x['source'])!=x['methods']:errors.append('Method mismatch: '+x['source'])
for f,sha in json.loads((docs/'source-manifest.json').read_text()).items():
 if hashlib.sha256((root/f).read_bytes()).hexdigest()!=sha:errors.append('Source changed: '+f)
result={'status':'FAIL' if errors else 'PASS','route_count':len(actual),'page_count':len(list((root/'src/app').rglob('page.tsx'))),'markdown_files':len(list(docs.glob('*.md')))+2,'local_links_checked':checked,'errors':errors}
print(json.dumps(result,indent=2))
raise SystemExit(bool(errors))
