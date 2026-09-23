import sys, re, pathlib, collections
from lxml import etree
roots = sys.argv[1:]
getters = collections.defaultdict(list)
GET = re.compile(r"^\s+(?:get\s+|async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{", re.M)
def body_at(src, i):
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{": depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0: return src[i:j]
    return src[i:]
def addon(p): return str(p).split("/static/")[0].rsplit("/", 1)[-1]
for r in roots:
    for f in pathlib.Path(r).glob("*/static/src/**/*.js"):
        if "/static/lib/" in str(f): continue
        src = f.read_text(errors="ignore")
        members = set(re.findall(r"\bthis\.([A-Za-z_$][\w$]*)\s*=[^=]", src))
        members |= set(re.findall(r"\bget\s+([A-Za-z_$][\w$]*)\s*\(", src))
        members |= set(re.findall(r"^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{", src, re.M))
        members |= set(re.findall(r"^\s+([A-Za-z_$][\w$]*)\s*=", src, re.M))
        members |= {"props", "env", "state", "constructor"}
        for m in GET.finditer(src):
            reads = set(re.findall(r"\bthis\.([A-Za-z_$][\w$]*)", body_at(src, m.end() - 1)))
            getters[m[1]].append((str(f), reads - members))
out = set()
for r in roots:
    for f in pathlib.Path(r).glob("*/static/**/*.xml"):
        if "/static/lib/" in str(f) or "o_spreadsheet" in str(f): continue
        try: root = etree.parse(str(f)).getroot()
        except Exception: continue
        for t in root.iter("t"):
            if not t.get("t-name"): continue
            locals_ = set()
            for el in t.iter():
                if not isinstance(el.tag, str): continue
                for a in ("t-as", "t-set", "t-slot-scope"):
                    if el.get(a): locals_.add(el.get(a))
            text = etree.tostring(t).decode()
            for g in set(re.findall(r"\bthis\.([A-Za-z_$][\w$]*)\b", text)):
                for jf, reads in getters.get(g, ()):
                    if addon(jf).split("_")[0] != addon(f).split("_")[0]: continue
                    bad = reads & locals_
                    if bad: out.add((str(f), t.get("t-name"), g, jf, ",".join(sorted(bad))))
for o in sorted(out): print("\t".join(o))
print(len(out), "getter reads of template locals", file=sys.stderr)
