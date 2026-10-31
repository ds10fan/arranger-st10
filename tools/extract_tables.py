import re,json,sys
src=open('src/ds10emu/src/core/tables_data.c').read()
src=re.sub(r'/\*.*?\*/','',src,flags=re.S)
out={}
for m in re.finditer(r'const\s+(u?int\d+_t)\s+ds10_tbl_(\w+)\[\d*\]\s*=\s*\{(.*?)\};',src,re.S):
    typ,name,body=m.groups()
    if name in('sincos',): continue
    vals=[]
    for tok in re.findall(r'-?0x[0-9A-Fa-f]+u?|-?\d+u?',body):
        t=tok.rstrip('uU'); v=int(t,16) if '0x' in t.lower() else int(t)
        if typ=='int32_t' and v>=2**31: v-=2**32
        if typ=='int16_t' and v>=2**15: v-=2**16
        vals.append(v)
    out[name]=vals
for k,v in out.items(): print(k,len(v),file=sys.stderr)
open('ds10_tables.js','w').write('const T='+json.dumps(out,separators=(',',':'))+';\n')
