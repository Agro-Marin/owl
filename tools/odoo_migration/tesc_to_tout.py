"""Rewrite OWL `t-esc` to `t-out` in an Odoo addons tree.

Scope: every `*/static/**/*.xml` and every xml`...` tagged template in
`*/static/**/*.js`, excluding the vendored `static/lib/` and `static/src/o_spreadsheet/`.
View archs (kanban/activity templates in data XML and in test `arch`
strings) are compiled by the view compilers, not by OWL, and are left alone.

Renames the attribute, `<attribute name="t-esc">` operations and the
`@t-esc` references in inheritance XPaths, so
a parent template and the templates locating elements in it stay in sync;
run it on every repo that inherits the templates, in the same change.

Requires owl >= 2.8-marin 42a915b1 (t-out renders non-block objects as text).
Behaviour changes that remain: a Markup value renders as HTML instead of
escaped source, and a body default no longer replaces `false`.

    python tesc_to_tout.py [--check] ROOT...
"""

import argparse
import pathlib
import re
import sys

from lxml import etree

ATTR = re.compile(r"(?<=\s)t-esc(?=\s*=)")
XPATH_REF = re.compile(r"@t-esc\b")
ATTRIBUTE_OP = re.compile(r"(<attribute\s+name=[\"'])t-esc(?=[\"'])")
TAGGED = re.compile(r"\bxml`(.*?)`", re.DOTALL)
EXCLUDED = ("/static/lib/", "/node_modules/", "/static/src/o_spreadsheet/")


def rewrite(text):
    count = sum(len(r.findall(text)) for r in (ATTR, XPATH_REF, ATTRIBUTE_OP))
    text = ATTRIBUTE_OP.sub(r"\1t-out", XPATH_REF.sub("@t-out", ATTR.sub("t-out", text)))
    return text, count


def rewrite_js(text):
    total = 0

    def one(match):
        nonlocal total
        body, count = rewrite(match.group(1))
        total += count
        return f"xml`{body}`"

    return TAGGED.sub(one, text), total


def canonical(tree):
    return etree.tostring(tree, method="c14n")


def expected(tree):
    for el in tree.iter():
        if not isinstance(el.tag, str):
            continue
        if "t-esc" in el.attrib:
            items = [("t-out" if k == "t-esc" else k, v) for k, v in el.attrib.items()]
            el.attrib.clear()
            el.attrib.update(items)
        if el.tag == "attribute" and el.get("name") == "t-esc":
            el.set("name", "t-out")
        for key, value in el.attrib.items():
            if "@t-esc" in value:
                el.set(key, XPATH_REF.sub("@t-out", value))
    return tree


def verify_xml(path, before, after):
    parser = etree.XMLParser(remove_blank_text=False)
    want = canonical(expected(etree.fromstring(before.encode(), parser)))
    got = canonical(etree.fromstring(after.encode(), parser))
    if want != got:
        raise SystemExit(f"{path}: rewrite changed more than t-esc attributes")


def files(root):
    root = pathlib.Path(root)
    for path in sorted(root.glob("*/static/**/*")):
        if path.suffix in (".xml", ".js") and not any(x in str(path) for x in EXCLUDED):
            yield path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("roots", nargs="+")
    args = parser.parse_args()
    changed = sites = 0
    for root in args.roots:
        for path in files(root):
            before = path.read_text()
            if "t-esc" not in before:
                continue
            if path.suffix == ".xml":
                after, count = rewrite(before)
                if count:
                    verify_xml(path, before, after)
            else:
                after, count = rewrite_js(before)
            if not count:
                continue
            changed += 1
            sites += count
            if not args.check:
                path.write_text(after)
    print(f"{'would rewrite' if args.check else 'rewrote'} {sites} sites in {changed} files")
    return 1 if args.check and sites else 0


if __name__ == "__main__":
    sys.exit(main())
