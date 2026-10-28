#!/usr/bin/env python3
"""Builds PhoneMail/Localizable.xcstrings (and InfoPlist.xcstrings), and the watch app's
PhoneMailWatch/Localizable.xcstrings, from l10n/*.tsv, and checks that every L("...") key in the Swift code
(PhoneMail, PhoneMailWatch, Shared) has a Hindi and Tamil translation. Run from ios/: python3 l10n/build-strings.py
strings.tsv: English source <TAB> Hindi <TAB> Tamil, one string per line.
infoplist.tsv: Info.plist key <TAB> English <TAB> Hindi <TAB> Tamil. The English column is needed: without it the
catalog would show the key itself (e.g. "NSContactsUsageDescription") on English devices."""
import json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
LANGS = ["hi", "ta"]
# Keys the code passes through L() indirectly (chip labels, folder names, header kinds).
INDIRECT = ["All", "Unread", "Attachments", "Favorites", "Drafts", "Spam", "Trash", "To", "Cc", "Bcc"]


def read(tsv, langs=LANGS):
    rows, errors = {}, []
    for n, line in enumerate((root / "l10n" / tsv).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) != 1 + len(langs):
            errors.append(f"{tsv}:{n}: expected {1 + len(langs)} columns")
            continue
        key, *vals = cols
        for lang, v in zip(langs, vals):
            for spec in ("%@", "%lld"):
                if key.count(spec) != v.count(spec):
                    errors.append(f"{tsv}:{n}: {lang} has a different number of {spec}")
        rows[key] = vals
    return rows, errors


def catalog(rows, langs=LANGS):
    return {
        "sourceLanguage": "en",
        "strings": {
            k: {"extractionState": "manual",
                "localizations": {l: {"stringUnit": {"state": "translated", "value": v}} for l, v in zip(langs, vals)}}
            for k, vals in sorted(rows.items())
        },
        "version": "1.0",
    }


def keys(*dirs):
    """The L("...") keys in the Swift files under these folders."""
    out = set()
    for d in dirs:
        for f in (root / d).rglob("*.swift"):
            out |= {m.replace("\\'", "'") for m in re.findall(r'L\("((?:[^"\\]|\\.)*)"', f.read_text(encoding="utf-8"))}
    return out


rows, errors = read("strings.tsv")
# Shared/ is built into both apps; the watch app keeps a catalog of just the strings it uses.
watch_used = keys("PhoneMailWatch", "Shared")
used = set(INDIRECT) | keys("PhoneMail") | watch_used
missing = sorted(used - rows.keys())
unused = sorted(rows.keys() - used)
(root / "PhoneMail" / "Localizable.xcstrings").write_text(json.dumps(catalog(rows), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
watch_rows = {k: v for k, v in rows.items() if k in watch_used}
(root / "PhoneMailWatch" / "Localizable.xcstrings").write_text(json.dumps(catalog(watch_rows), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

info, e2 = read("infoplist.tsv", ["en"] + LANGS)
errors += e2
(root / "PhoneMail" / "InfoPlist.xcstrings").write_text(json.dumps(catalog(info, ["en"] + LANGS), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print(f"{len(rows)} strings ({len(watch_rows)} on the watch), {len(info)} Info.plist strings; "
      f"untranslated keys in code: {len(missing)}; unused: {len(unused)}")
for m in missing:
    print("  MISSING:", m)
for e in errors:
    print("  ERROR:", e)
sys.exit(1 if missing or errors else 0)
