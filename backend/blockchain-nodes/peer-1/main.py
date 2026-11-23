import hashlib, json, os, tempfile
from functools import wraps
from threading import RLock
from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
app=FastAPI(title=os.getenv('PEER_ID','peer'))

CHAIN_LOCK = RLock()

def serialize_write(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        # Keep read, validation and replacement in one critical section.
        with CHAIN_LOCK:
            return function(*args, **kwargs)
    return guarded

PEER_ID=os.getenv('PEER_ID','peer'); DATA=Path(os.getenv('DATA_FILE','/data/chain.json')); API_KEY=os.getenv('PEER_API_KEY',os.getenv('INTERNAL_API_KEY',''))
GENESIS_FIELDS={'index':0,'timestamp':'2026-01-01T00:00:00+00:00','event_id':'GENESIS','event_type':'GENESIS','payload':{'message':'Vitality genesis block'},'previous_hash':'0'*64}
def digest(fields): return hashlib.sha256(json.dumps(fields,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def make_genesis(): return {**GENESIS_FIELDS,'hash':digest(GENESIS_FIELDS)}
def read_chain():
    DATA.parent.mkdir(parents=True,exist_ok=True)
    if not DATA.exists(): write_chain([make_genesis()])
    return json.loads(DATA.read_text())
def write_chain(chain):
    DATA.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=str(DATA.parent),prefix='chain-')
    with os.fdopen(fd,'w') as f: json.dump(chain,f,indent=2,sort_keys=True); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,DATA)
def valid_chain(chain):
    if not chain or chain[0]!=make_genesis(): return False
    for i,b in enumerate(chain[1:],1):
        fields={k:v for k,v in b.items() if k!='hash'}
        if b.get('index')!=i or b.get('previous_hash')!=chain[i-1].get('hash') or digest(fields)!=b.get('hash'): return False
    return True
def auth(key):
    if API_KEY and key!=API_KEY: raise HTTPException(401,'Invalid peer API key')
class Block(BaseModel):
    index:int; timestamp:str; event_id:str; event_type:str; payload:dict; previous_hash:str; hash:str
class SyncBody(BaseModel): blocks:list[dict]
@app.get('/health')
def health():
    c=read_chain(); return {'peer':PEER_ID,'status':'ok','height':len(c)-1,'latest_hash':c[-1]['hash'],'valid':valid_chain(c)}
@app.get('/chain')
def chain():
    c=read_chain(); return {'peer':PEER_ID,'blocks':c,'height':len(c)-1,'latest_hash':c[-1]['hash'],'valid':valid_chain(c)}
@app.post('/validate')
def validate(block:Block,x_peer_api_key:str|None=Header(default=None)):
    auth(x_peer_api_key); c=read_chain()
    if not valid_chain(c): return {'approved':False,'reason':'local_chain_invalid'}
    b=block.model_dump()
    if any(x['event_id']==b['event_id'] for x in c):
        old=next(x for x in c if x['event_id']==b['event_id'])
        return {'approved':old['hash']==b['hash'],'reason':'already_committed' if old['hash']==b['hash'] else 'duplicate_event_conflict'}
    fields={k:v for k,v in b.items() if k!='hash'}
    if b['index']!=len(c): return {'approved':False,'reason':'wrong_index'}
    if b['previous_hash']!=c[-1]['hash']: return {'approved':False,'reason':'previous_hash_mismatch'}
    if digest(fields)!=b['hash']: return {'approved':False,'reason':'hash_mismatch'}
    return {'approved':True,'peer':PEER_ID}
@app.post('/commit')
@serialize_write
def commit(block:Block,x_peer_api_key:str|None=Header(default=None)):
    auth(x_peer_api_key); c=read_chain(); b=block.model_dump()
    if not valid_chain(c): raise HTTPException(409,'Local chain is invalid')
    for old in c:
        if old['event_id']==b['event_id']:
            if old['hash']==b['hash']: return {'committed':True,'already_committed':True,'peer':PEER_ID}
            raise HTTPException(409,'Event ID already committed with different hash')
    fields={k:v for k,v in b.items() if k!='hash'}
    if b['index']!=len(c) or b['previous_hash']!=c[-1]['hash'] or digest(fields)!=b['hash']:
        raise HTTPException(409,'Block does not extend local chain')
    c.append(b); write_chain(c); return {'committed':True,'peer':PEER_ID,'height':len(c)-1}
@app.post('/sync')
@serialize_write
def sync(body:SyncBody,x_peer_api_key:str|None=Header(default=None)):
    auth(x_peer_api_key)
    if not valid_chain(body.blocks): raise HTTPException(400,'Refusing invalid chain snapshot')
    current=read_chain()
    if not valid_chain(current): raise HTTPException(409,'Local chain is corrupt; manual recovery required')
    # Only accept a snapshot that extends the peer's current history; never silently roll back committed data.
    if len(body.blocks)<len(current) or body.blocks[:len(current)]!=current: raise HTTPException(409,'Snapshot does not extend local chain')
    write_chain(body.blocks); return {'synced':True,'peer':PEER_ID,'height':len(body.blocks)-1}
@app.get('/verify')
def verify():
    c=read_chain(); return {'peer':PEER_ID,'valid':valid_chain(c),'height':len(c)-1}
