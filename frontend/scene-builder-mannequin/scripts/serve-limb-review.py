"""Serve the built app plus local audit data; no hot reload or dev runtime."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
import urllib.parse,urllib.request,urllib.error
frontend=Path(__file__).resolve().parents[2];dist=frontend/'dist'
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  if not self.path.startswith('/__limb-audit/'):
   self.send_error(404);return
  route=self.path[len('/__limb-audit/'):]
  if route.split('?')[0] not in ['topology','frame','image','metrics','proposal']:
   self.send_error(404);return
  length=int(self.headers.get('Content-Length','0'))
  if length>12000000:self.send_error(413);return
  data=self.rfile.read(length);request=urllib.request.Request('http://127.0.0.1:3010/'+route,data=data,headers={'Content-Type':self.headers.get('Content-Type','application/octet-stream')},method='POST')
  try:
   with urllib.request.urlopen(request,timeout=120) as response:body=response.read();code=response.status
  except urllib.error.HTTPError as error:body=error.read();code=error.code
  self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def translate_path(self,url):
  name=urllib.parse.unquote(urllib.parse.urlparse(url).path).lstrip('/')
  if name in ['scene-builder-mannequin/scripts/limb-batch-review.html','scene-builder-mannequin/scripts/legacy-limb-repair.html']:return str(frontend/name)
  if name.startswith('scene-builder-mannequin/assets/ual-library/') or name.startswith('scene-builder-mannequin/docs/ual-fit/limb-clearance/'):
   p=(frontend/name).resolve()
   if p.is_relative_to(frontend):return str(p)
  p=(dist/name).resolve()
  return str(p) if p.is_relative_to(dist) else str(dist/'not-found')
print('Built app limb review: http://127.0.0.1:5175',flush=True);ThreadingHTTPServer(('127.0.0.1',5175),Handler).serve_forever()
