import sys, re, pathlib, collections
from lxml import etree
roots = sys.argv[1:]
tpl = {}; calls = collections.defaultdict(list)
for r in roots:
    for f in pathlib.Path(r).glob("*/static/**/*.xml"):
        if "/static/lib/" in str(f) or "o_spreadsheet" in str(f): continue
        try: root = etree.parse(str(f)).getroot()
        except Exception: continue
        for t in root.iter("t"):
            n = t.get("t-name")
            if n and not t.get("t-inherit"): tpl[n] = (str(f), t)
for name, (f, t) in tpl.items():
    for el in t.iter():
        if not isinstance(el.tag, str): continue
        c = el.get("t-call")
        if not c or "{{" in c: continue
        scope = {a for a in el.attrib if not a.startswith("t-")}
        for anc in [el, *el.iterancestors()]:
            if anc is t.getparent(): break
            if anc.get("t-as"): scope |= {anc.get("t-as"), anc.get("t-as") + "_index"}
            if anc.get("t-slot-scope"): scope.add(anc.get("t-slot-scope"))
            for sib in anc.itersiblings(preceding=True):
                if isinstance(sib.tag, str) and sib.get("t-set"): scope.add(sib.get("t-set"))
        calls[c.strip()].append((name, scope))
amb = collections.defaultdict(set)
changed = True
while changed:
    changed = False
    for callee, sites in calls.items():
        for caller, scope in sites:
            new = scope | amb[caller]
            if not new <= amb[callee]: amb[callee] |= new; changed = True
out = []
for name, (f, t) in tpl.items():
    if not amb[name]: continue
    text = etree.tostring(t).decode()
    hits = sorted({v for v in amb[name] if re.search(r"\bthis\." + re.escape(v) + r"\b", text)})
    if hits: out.append((f, name, hits))
for f, n, h in sorted(out): print(f"{f}\t{n}\t{','.join(h)}")
print(len(out), "templates read a caller-provided name as this.<name>", file=sys.stderr)
