import argparse
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import upstream_owl3_migration as up  # noqa: E402
from lxml import etree  # noqa: E402

RENDER_API = re.compile(
    r"""\b(?:renderToString|renderToElement|renderToFragment|renderToMarkup|renderAt)"""
    r"""\(\s*["']([A-Za-z0-9_.\-]+)["']"""
)
DYNAMIC_CALL = re.compile(r"\{\{")
DYNAMIC_EXPR = re.compile(r"\{\{\s*(.*?)\s*\}\}")
GENERIC_KEYS = {"template"}
COMPONENT_TEMPLATE = re.compile(r"""static\s+template\s*=\s*["']([^'"]+)["']""")
TEMPLATE_BODY = re.compile(r'<t\s+t-name="([^"]+)"(.*?)</t>\s*(?=<t\s+t-name=|</templates>)', re.DOTALL)
INHERIT = re.compile(r't-name="([^"]+)"[^>]*?t-inherit="([^"]+)"')
EXCLUDED = up.EXCLUDED_PATH + ("/static/lib/", "/static/src/o_spreadsheet/")


class File:
    def __init__(self, path):
        self.path = path
        self._original = path.read_text()
        self.content = self._original

    @property
    def changed(self):
        return self.content != self._original


class Path(str):
    @property
    def _str(self):
        return str(self)


class FileManager(list):
    def print_progress(self, *_args):
        pass


def collect(roots):
    files = FileManager()
    for root in roots:
        for path in sorted(pathlib.Path(root).glob("*/static/**/*")):
            text = str(path)
            if path.suffix not in (".js", ".xml") or any(x in text for x in EXCLUDED):
                continue
            f = File(path)
            f.path = Path(text)
            files.append(f)
    return files


def render_api_templates(files):
    return {
        name
        for f in files
        if f.path.endswith(".js")
        for name in RENDER_API.findall(f.content)
    }


def dynamic_calls(files, original=False):
    report = []
    for f in files:
        content = f._original if original else f.content
        if not f.path.endswith(".xml") or "t-call" not in content:
            continue
        try:
            root = etree.fromstring(content.encode())
        except etree.XMLSyntaxError:
            continue
        for el in root.iter():
            if not isinstance(el.tag, str):
                continue
            call = el.get("t-call")
            if not call or not DYNAMIC_CALL.search(call):
                continue
            scope = set()
            for anc in [el, *el.iterancestors()]:
                if anc.get("t-as"):
                    scope |= {anc.get("t-as"), anc.get("t-as") + "_index"}
                if anc.get("t-slot-scope"):
                    scope.add(anc.get("t-slot-scope"))
                for sib in anc.itersiblings(preceding=True):
                    if isinstance(sib.tag, str) and sib.get("t-set"):
                        scope.add(sib.get("t-set"))
            for child in el:
                if isinstance(child.tag, str) and child.get("t-set"):
                    scope.add(child.get("t-set"))
            scope |= {name for name in el.attrib if not name.startswith("t-")}
            report.append((f.path, el.sourceline, call, sorted(scope)))
    return report


def addon_of(path):
    return str(path).split("/static/")[0].rsplit("/", 1)[-1]


def callee_key(call):
    expr = DYNAMIC_EXPR.search(call)
    if not expr:
        return None
    idents = re.findall(r"[A-Za-z_$][\w$]*", expr.group(1))
    return idents[-1] if idents else None


def dynamic_whitelist(files, calls):
    js = "\n".join(f.content for f in files if f.path.endswith(".js"))
    inherits = {}
    for f in files:
        if f.path.endswith(".xml"):
            for child, parent in INHERIT.findall(f.content):
                inherits.setdefault(parent, set()).add(child)
    components = set(COMPONENT_TEMPLATE.findall(js))
    by_addon = {}
    for f in files:
        if f.path.endswith(".xml"):
            for name, body in TEMPLATE_BODY.findall(f._original):
                if name not in components:
                    by_addon.setdefault(addon_of(f.path), []).append((name, body))
    extra = {}
    for path, _line, call, scope in calls:
        key = callee_key(call)
        if not scope:
            continue
        targets = set()
        if key and key not in GENERIC_KEYS:
            targets = set(re.findall(rf"\b{re.escape(key)}\s*[:=]\s*[\"']([\w.\-]+)[\"']", js))
        if not targets:
            targets = {
                name
                for name, body in by_addon.get(addon_of(path), ())
                if any(re.search(rf"(?<![\w.]){re.escape(v)}\b", body) for v in scope)
            }
        todo = list(targets)
        while todo:
            for child in inherits.get(todo.pop(), ()):
                if child not in targets:
                    targets.add(child)
                    todo.append(child)
        for name in targets:
            extra.setdefault(name, set()).update(scope)
    return extra


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--tcall-only", action="store_true")
    parser.add_argument("--report", metavar="FILE")
    parser.add_argument("roots", nargs="+")
    args = parser.parse_args()

    files = collect(args.roots)
    errors = []

    def log_error(path, exc):
        errors.append(f"{path}: {exc!r}")

    upstream_lists = {
        name: {k: set(v) for k, v in getattr(up, name).items()}
        for name in ("MAIL_WHITELIST", "WEB_WHITELIST", "WEB_EXT_WHITELIST", "MISC_WHITELIST")
    }
    up.EXCLUDED_TEMPLATES = tuple(set(up.EXCLUDED_TEMPLATES) | render_api_templates(files))
    for _pass in range(3):
        before = [f.content for f in files]
        if not args.tcall_only:
            extra = dynamic_whitelist(files, dynamic_calls(files))
            merged = {}
            for wl in (*upstream_lists.values(), extra):
                for name, names in wl.items():
                    merged.setdefault(name, set()).update(names)
            up.MAIL_WHITELIST, up.WEB_WHITELIST, up.WEB_EXT_WHITELIST = {}, {}, {}
            up.MISC_WHITELIST = merged
            up.upgrade_this(files, print, log_error, targets=[])
            up.upgrade_this_in_js(files, print, log_error, targets=[])
        up.upgrade_parametric_tcall(files, print, log_error)
        if [f.content for f in files] == before:
            break

    changed = [f for f in files if f.changed]
    if not args.check:
        for f in changed:
            f.path_obj = pathlib.Path(f.path)
            f.path_obj.write_text(f.content)
    if args.report:
        with open(args.report, "w") as out:
            for path, line, call, scope in dynamic_calls(files):
                out.write(f"{path}:{line}\t{call}\t{','.join(scope)}\n")
    for error in errors:
        print("ERROR", error, file=sys.stderr)
    verb = "would change" if args.check else "changed"
    print(f"{verb} {len(changed)} files; {len(errors)} errors")
    return 1 if errors or (args.check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
