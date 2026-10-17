// Keep parsed frame data bounded while sharing in-flight requests.
export class AnimationFrameCache {
 constructor(limit=8){this.limit=limit;this.values=new Map();this.pending=new Map();}
 peek(id){const value=this.values.get(id);if(value){this.values.delete(id);this.values.set(id,value);}return value;}
 async get(id,loader){
  const cached=this.peek(id);if(cached)return cached;
  if(!this.pending.has(id)){
   const promise=Promise.resolve().then(loader).then(value=>{
    this.values.set(id,value);while(this.values.size>this.limit)this.values.delete(this.values.keys().next().value);return value;
   }).finally(()=>this.pending.delete(id));this.pending.set(id,promise);
  }
  return this.pending.get(id);
 }
}
