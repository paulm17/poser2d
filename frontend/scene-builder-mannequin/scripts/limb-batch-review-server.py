"""Loopback-only persistent Blender geometry audit for actual editor frames."""
import sys,json,importlib.util,urllib.parse,time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
import numpy as np
base=Path(__file__).resolve().parents[1];assets=base/'assets/ual-library';docs=base/'docs/ual-fit/limb-clearance/batch-app';docs.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('c',Path(__file__).with_name('limb-collision.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
ids={r['id'] for r in json.loads((assets/'limb-repair-batch.json').read_text())['actions']};topology={};reports={}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def end(self,code,result):
  raw=json.dumps(result).encode();self.send_response(code);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin') if self.headers.get('Origin') in ['http://127.0.0.1:5173','http://127.0.0.1:5174','http://127.0.0.1:5175'] else 'http://127.0.0.1:5173');self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
 def do_OPTIONS(self):self.end(200,{})
 def do_POST(self):
  try:
   u=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(u.query);editor=q['editor'][0]
   if editor not in ['makehuman','legacy','legacy2']:raise ValueError('editor')
   size=int(self.headers['Content-Length'])
   if size>12000000:raise ValueError('payload')
   raw=self.rfile.read(size)
   if u.path=='/topology':topology[editor]=json.loads(raw);self.end(200,{'pass':True});return
   id=q['id'][0];frame=int(q['frame'][0])
   if id not in ids or not 0<=frame<10000:raise ValueError('clip/frame')
   directory=docs/id/editor;directory.mkdir(parents=True,exist_ok=True)
   if u.path=='/frame':
    points=np.frombuffer(raw,dtype='<f4').reshape(-1,3);hits=c.intersections(points,topology[editor]);key=(id,editor);report=reports.setdefault(key,{'id':id,'editor':editor,'frames':[]});report['frames']=[f for f in report['frames'] if f['frame']!=frame];report['frames'].append({'frame':frame,'intersections':hits});report['frames'].sort(key=lambda f:f['frame']);report['intersectingFrames']=sum(bool(f['intersections']) for f in report['frames']);report['checkedFrames']=len(report['frames']);(directory/'limb-intersections.json').write_text(json.dumps(report,indent=2));self.end(200,{'pass':not hits,'intersections':hits});return
   if u.path=='/image':
    import base64
    d=json.loads(raw);(directory/(str(frame).zfill(3)+'.png')).write_bytes(base64.b64decode(d['png'].split(',')[1]));self.end(200,{'pass':True});return
   if u.path=='/proposal':
    proposal=directory/'additional-corrections.json';values=json.loads(proposal.read_text()) if proposal.exists() else {};values[str(frame)]=json.loads(raw);proposal.write_text(json.dumps(values,indent=2));self.end(200,{'pass':True});return
   if u.path=='/metrics':(directory/'comparison.json').write_bytes(raw);self.end(200,{'pass':True});return
   raise ValueError('route')
  except Exception as e:self.end(400,{'error':str(e)})
print('Persistent actual-editor limb audit: http://127.0.0.1:3010',flush=True);HTTPServer(('127.0.0.1',3010),Handler).serve_forever()
