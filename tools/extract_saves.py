import glob,struct,hashlib,json,os,sys
def nm(b): return ' '.join(b[:6].replace(b'\x08',b' ').replace(b'\x00',b' ').decode('latin1').split())
lib=[];seen={}
def add(src,name,kind,k):
    key=tuple(k)
    if key in seen: seen[key]['also']+=1; return
    e={'src':src,'name':name or '?','kind':kind,'k':list(k),'also':0};seen[key]=e;lib.append(e)
stats=[]
for f in sorted(glob.glob('src/ds10emu/songs/*.ds10save')):
    d=open(f,'rb').read();save=os.path.basename(f).split('.')[0]
    ns=0;np_=0
    for s in range(18):
        off=0x100+s*0x3000;md5=d[off:off+16];pl=d[off+16:off+16+12252]
        if hashlib.md5(pl).digest()!=md5: continue
        ns+=1
        ver,rev,tempo=struct.unpack_from('<HHI',pl,0);song=nm(pl[0x14:0x24]) or 'SONG%d'%s
        chain=[x for x in struct.unpack_from('<100H',pl,0x24)]
        used=set()
        for x in chain:
            if x==0xFFFF: break
            used.add(x)
        if not used: used={0}
        for pat in sorted(used):
            if pat>15: continue
            base=0xEC+pat*676
            names=pl[0x2BFC+pat*48:0x2BFC+pat*48+48]
            for t in range(2):
                k=struct.unpack_from('31b',pl,base+4+t*31)
                n=nm(names[t*8:t*8+8]);add(save+'/'+song,(n+' ' if n else '')+'S%d P%d'%(t+1,pat+1),'synth',k)
        rown=pl[0x2BCC:0x2BCC+48]
        for dr in range(4):
            k=struct.unpack_from('31b',pl,0x2B2C+dr*31)
            n=nm(rown[(2+dr)*8:(2+dr)*8+8]);add(save+'/'+song,(n+' ' if n else '')+'DR%d'%(dr+1),'drum',k)
    for i in range(96):
        o=0x38000+i*0x40;rec=d[o:o+63]
        if hashlib.md5(rec[16:]).digest()!=rec[:16]: continue
        np_+=1;add(save+'/PATCHES',nm(rec[0x10:0x16]),'patch',struct.unpack_from('31b',rec,0x20))
    stats.append((save,ns,np_))
print(stats,file=sys.stderr);print('unique',len(lib),file=sys.stderr)
from collections import Counter
print(Counter(e['kind'] for e in lib),file=sys.stderr)
print(Counter(e['src'] for e in lib).most_common(40),file=sys.stderr)
json.dump(lib,open('ds10lib.json','w'))
