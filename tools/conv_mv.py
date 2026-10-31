import re,sys,json
base='src/midiverb_emulator/'
def split_top(s,ch):
    out=[];d=0;cur=''
    for c in s:
        if c in '([':d+=1
        elif c in ')]':d-=1
        if c==ch and d==0: out.append(cur);cur=''
        else: cur+=c
    out.append(cur);return out
def repl_line(s):
    # replace LINE(id, W, R) with D[(p+W-R)&16383]
    res='';i=0
    while True:
        j=s.find('LINE(',i)
        if j<0: res+=s[i:];break
        res+=s[i:j];k=j+5;d=1;st=k
        while d: 
            if s[k]=='(':d+=1
            elif s[k]==')':d-=1
            k+=1
        args=split_top(s[st:k-1],',')
        w=args[1].strip();r=args[2].strip()
        w=w.replace('lfo1_value','l1').replace('lfo2_value','l2')
        if re.fullmatch(r'\d+',w): res+='D[(p+%d)&16383]'%(int(w)-int(r))
        else: res+='D[(p+%s-%s)&16383]'%(w,r)
        i=k
    return res
def conv_rhs(s):
    s=repl_line(s.strip())
    s=s.replace('lfo1_value','l1').replace('lfo2_value','l2')
    terms=split_top(s,'+')
    out=[]
    for t in terms:
        t=t.strip()
        assert ' - ' not in re.sub(r'\[[^\]]*\]|\([^()]*\)','',t), t
        parts=split_top(t,'/')
        if len(parts)==1: out.append(t)
        elif len(parts)==2: out.append('((%s)/%s|0)'%(parts[0].strip(),parts[1].strip()))
        else: raise Exception(t)
    return '+'.join(out)
def conv_file(fn,prefix):
    src=open(base+fn).read()
    funcs={}
    for m in re.finditer(r'void (%s_effect_(\d+))\(.*?\) \{\n(.*?)\n\}\n'%prefix,src,re.S):
        name,num,body=m.groups()
        js=[]
        for line in body.split('\n'):
            l=line.strip()
            if not l: continue
            if l.startswith('int16_t'):
                vs=[v.strip() for v in l[8:-1].split(',')]
                js.append('let '+','.join(v+'=0' for v in vs)+';');continue
            if l.startswith('switch'):
                js.append(l.replace('lfo1_value','l1').replace('lfo2_value','l2'));continue
            if l.startswith('case') or l=='break;' or l=='}' or l.startswith('default'):
                js.append(l);continue
            mm=re.match(r'(.*?)\s=\s(.*);$',l)
            assert mm,l
            lhs,rhs=mm.groups()
            r=conv_rhs(rhs)
            if lhs.startswith('WRITE_LINE('):
                w=split_top(lhs[11:-1],',')[1].strip().replace('lfo1_value','l1').replace('lfo2_value','l2')
                js.append('D[(p+%s)&16383]=%s;'%(w,r))
            elif lhs=='*out_left': js.append('o[0]=(%s)<<16>>16;'%r)
            elif lhs=='*out_right': js.append('o[1]=(%s)<<16>>16;'%r)
            else: js.append('%s=(%s)<<16>>16;'%(lhs,r))
        funcs[int(num)]='function(input,D,p,l1,l2,o){'+''.join(js)+'}'
    ks=sorted(funcs); return [funcs[i] for i in ks]
def names(fn):
    return [x for x in re.findall(r'"(.*?)"',open(base+fn).read())]
out='const MV_DEV=['
for fn,pre,nf,label in [('decompiled-midiverb.h','midiverb','names-midiverb.h','MIDIVERB'),('decompiled-midifex.h','midifex','names-midifex.h','MIDIFEX'),('decompiled-midiverb2.h','midiverb2','names-midiverb2.h','MIDIVERB II')]:
    fs=conv_file(fn,pre); ns=names(nf)
    print(label,len(fs),len(ns),file=sys.stderr)
    out+='{name:%s,names:%s,fx:[%s]},'%(json.dumps(label),json.dumps(ns),','.join(fs))
out+='];\n'
open('midiverb_fx.js','w').write(out)
